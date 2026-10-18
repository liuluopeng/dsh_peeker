/**
 * lx_dsh_peek — a read-only, LAN-only peek at the running DSH session.
 *
 * The plugin serves one small page and one SSE stream. It never accepts input:
 * every request is GET, and the only Session Controller methods it calls are
 * `list()` and `follow()`. The page flashes three times when a live `turn/end`
 * event arrives.
 */

import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'

/** Plugin name used by Cordis diagnostics and loader display. */
export const name = 'lx-dsh-peek'

/** Wait for the Session Controller before mounting. */
export const inject = ['sessionController']

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cache-control': 'no-store',
}

/** @param {import('node:http').ServerResponse} res */
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

/** @param {import('node:http').ServerResponse} res */
function sendEvent(res, value) {
  if (res.writableEnded || res.destroyed) return
  try {
    res.write(`data: ${JSON.stringify(value)}\n\n`)
  } catch {
    // The peer went away between the check and the write; the stream teardown handles it.
  }
}

/** Strip the accumulated delta copy from assistant messages so snapshots stay small. */
function trimEvent(event) {
  if (event?.type !== 'assistant/message' || event.data === null || typeof event.data !== 'object') return event
  const { stream, ...data } = event.data
  return { ...event, data }
}

const MAX_TEXT = 4000
const MAX_SNAPSHOT_BYTES = 1_200_000

/** Bound one JSON value so a long tool output cannot make the phone wait forever. */
function shrink(value, depth = 0) {
  if (typeof value === 'string') {
    return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}\n…（已截断）` : value
  }
  if (Array.isArray(value)) return depth > 8 ? [] : value.map((item) => shrink(item, depth + 1))
  if (value !== null && typeof value === 'object') {
    if (depth > 8) return null
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shrink(item, depth + 1)]))
  }
  return value
}

/** Keep the newest records that fit the snapshot budget. */
function fitSnapshot(records) {
  const trimmed = (Array.isArray(records) ? records : [])
    .map((record) => record?.type === 'event' ? { ...record, event: trimEvent(record.event) } : record)
    .map((record) => shrink(record))
  let from = 0
  let bytes = JSON.stringify(trimmed).length
  while (bytes > MAX_SNAPSHOT_BYTES && from < trimmed.length - 1) {
    bytes -= JSON.stringify([trimmed[from]]).length - 2
    from += 1
  }
  return { records: trimmed.slice(from), dropped: from }
}

/** Read a title from the session projections; fall back to the cwd basename. */
function sessionTitle(summary) {
  const values = summary?.projections?.values ?? {}
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'string' && key.toLowerCase().includes('title')) return value
  }
  const cwd = typeof summary?.cwd === 'string' ? summary.cwd : ''
  return cwd.split(/[\\/]/).filter(Boolean).pop() ?? String(summary?.sessionId ?? '')
}

/**
 * List sessions newest-running first.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
async function listSessions(ctx) {
  const value = await ctx.sessionController.list({}, AbortSignal.timeout(8000))
  const items = Array.isArray(value?.items) ? value.items : []
  return items
    .map((item) => ({
      sessionId: String(item?.sessionId ?? ''),
      title: sessionTitle(item),
      cwd: typeof item?.cwd === 'string' ? item.cwd : '',
      running: item?.running === true,
      updatedAt: Number.isFinite(Number(item?.updatedAt)) ? Number(item.updatedAt) : 0,
    }))
    .filter((item) => item.sessionId !== '')
    .sort((left, right) => Number(right.running) - Number(left.running) || right.updatedAt - left.updatedAt)
}

/** Keep terminal job rows long enough for the page to render their final state. */
const JOB_KEEP_MS = 12_000

/** Client-safe projection of one background job. */
function publicJob(job) {
  return {
    id: String(job?.id ?? ''),
    kind: String(job?.kind ?? ''),
    label: String(job?.label ?? ''),
    status: String(job?.status ?? ''),
    progress: typeof job?.progress === 'string' ? job.progress : undefined,
    detail: typeof job?.detail === 'string' ? job.detail : undefined,
    startedAt: Number.isFinite(Number(job?.startedAt)) ? Number(job.startedAt) : 0,
    finishedAt: Number.isFinite(Number(job?.finishedAt)) ? Number(job.finishedAt) : undefined,
    output: {
      total: Number(job?.output?.total) || 0,
      earliest: Number(job?.output?.earliest) || 0,
    },
  }
}

/** Client-safe projection of one retained output chunk. */
function publicChunk(chunk) {
  return {
    at: Number(chunk?.at) || 0,
    text: String(chunk?.text ?? ''),
    channel: chunk?.channel,
    gapBefore: chunk?.gapBefore === true ? true : undefined,
  }
}

/** LAN IPv4 addresses, only for the startup log. */
function lanAddresses() {
  const addresses = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && entry.internal !== true) addresses.push(entry.address)
    }
  }
  return addresses
}

/**
 * Mount the listener.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ port?: number } | undefined} config
 */
export function apply(ctx, config) {
  const port = Number(config?.port ?? 3082)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`lx_dsh_peek: port must be an integer from 1 to 65535, got ${JSON.stringify(config?.port)}`)
  }

  const page = readFileSync(new URL('./page.html', import.meta.url), 'utf8')
  /** @type {Set<{ controller: AbortController, res: import('node:http').ServerResponse }>} */
  const streams = new Set()
  let disposed = false

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'read-only' })
      return
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8' })
      res.end(page)
      return
    }
    if (url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true })
      return
    }
    if (url.pathname === '/api/sessions') {
      try {
        sendJson(res, 200, { items: await listSessions(ctx) })
      } catch (error) {
        sendJson(res, 500, { error: String(error?.message ?? error) })
      }
      return
    }
    if (url.pathname === '/api/stream') {
      await handleStream(req, res, url)
      return
    }
    sendJson(res, 404, { error: 'not found' })
  }

  /**
   * Forward the session's background-job roster and live output on the same SSE
   * stream as the transcript. One connection per pane keeps the browser below its
   * six-connection HTTP/1.1 limit even with four panes.
   */
  function startJobStreaming(sessionId, res, signal) {
    const jobController = ctx.get('jobController')
    if (jobController === undefined) return () => {}
    const follows = new Map()
    const send = (payload) => {
      if (!signal.aborted && !res.writableEnded && !res.destroyed) sendEvent(res, payload)
    }
    const stop = () => {
      for (const controller of follows.values()) controller.abort()
      follows.clear()
    }
    const followJob = (job) => {
      const controller = new AbortController()
      follows.set(job.id, controller)
      void (async () => {
        try {
          for await (const frame of jobController.follow({ sessionId, jobId: job.id }, controller.signal)) {
            if (controller.signal.aborted) break
            if (frame?.type === 'opened') send({ t: 'job', job: publicJob(frame.job) })
            else if (frame?.type === 'output') {
              send({ t: 'job-output', jobId: job.id, chunks: (frame.chunks ?? []).map(publicChunk) })
            } else if (frame?.type === 'status') {
              send({ t: 'job-status', job: publicJob(frame.job) })
            }
          }
        } catch (error) {
          if (!controller.signal.aborted) send({ t: 'job-error', jobId: job.id, message: String(error?.message ?? error) })
        } finally {
          follows.delete(job.id)
        }
      })()
    }
    void (async () => {
      try {
        for await (const frame of jobController.list({ sessionId }, signal)) {
          if (signal.aborted) break
          if (frame?.type !== 'rows') continue
          const jobs = (Array.isArray(frame.jobs) ? frame.jobs : []).filter((job) => {
            if (job.status === 'running' || job.status === 'stopping') return true
            const finished = Number(job.finishedAt) || 0
            return finished > 0 && Date.now() - finished <= JOB_KEEP_MS
          })
          send({ t: 'jobs', jobs: jobs.map(publicJob) })
          for (const job of jobs) {
            if (job.status !== 'running' && job.status !== 'stopping') continue
            if (job.id && !follows.has(job.id)) followJob(job)
          }
        }
      } catch (error) {
        if (!signal.aborted) send({ t: 'jobs-error', message: String(error?.message ?? error) })
      }
    })()
    return stop
  }

  async function handleStream(req, res, url) {
    if (disposed) {
      sendJson(res, 503, { error: 'plugin disposed' })
      return
    }
    const sessionId = url.searchParams.get('sessionId') ?? ''
    if (sessionId === '') {
      sendJson(res, 400, { error: 'sessionId is required' })
      return
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': 'text/event-stream; charset=utf-8',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write('retry: 2000\n\n')
    const controller = new AbortController()
    const entry = { controller, res }
    streams.add(entry)
    const jobAbort = new AbortController()
    const stopJobs = startJobStreaming(sessionId, res, jobAbort.signal)
    const stop = () => {
      controller.abort()
      jobAbort.abort()
      streams.delete(entry)
    }
    req.on('close', stop)
    res.on('close', stop)
    const ping = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) {
        try { res.write(': ping\n\n') } catch { stop() }
      }
    }, 15000)
    try {
      const frames = ctx.sessionController.follow({
        address: { kind: 'session', sessionId },
        maxMessages: 200,
        assistantStream: true,
      }, controller.signal)
      for await (const frame of frames) {
        if (controller.signal.aborted || disposed) break
        if (frame?.type === 'snapshot') {
          const fitted = fitSnapshot(frame.records)
          sendEvent(res, { t: 'snapshot', records: fitted.records, dropped: fitted.dropped })
        } else if (frame?.type === 'event') {
          sendEvent(res, { t: 'event', event: shrink(trimEvent(frame.event)) })
          if (frame.event?.type === 'turn/end') sendEvent(res, { t: 'flash', times: 3 })
        } else if (frame?.type === 'assistant-stream') {
          sendEvent(res, { t: 'delta', frame: frame.frame })
        }
      }
      if (!controller.signal.aborted && !disposed) sendEvent(res, { t: 'end' })
    } catch (error) {
      if (!controller.signal.aborted && !disposed) {
        sendEvent(res, { t: 'error', message: String(error?.message ?? error) })
      }
    } finally {
      clearInterval(ping)
      jobAbort.abort()
      stopJobs()
      streams.delete(entry)
      if (!res.writableEnded) res.end()
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (!res.headersSent) sendJson(res, 500, { error: String(error?.message ?? error) })
      else res.end()
    })
  })
  server.on('error', (error) => {
    const busy = error?.code === 'EADDRINUSE'
    console.error(`[lx-dsh-peek] listener failed: ${busy ? `port ${port} is busy` : String(error?.message ?? error)}`)
  })

  ctx.effect(() => {
    server.listen(port, '0.0.0.0', () => {
      const addresses = lanAddresses()
      for (const address of addresses) console.log(`[lx-dsh-peek] http://${address}:${port}/`)
      if (addresses.length === 0) console.log(`[lx-dsh-peek] http://127.0.0.1:${port}/`)
    })
    return () => {
      disposed = true
      for (const entry of streams) {
        try { entry.controller.abort() } catch { /* already gone */ }
        try { entry.res.end() } catch { /* already closed */ }
      }
      streams.clear()
      server.closeAllConnections?.()
      server.close()
    }
  }, 'lx-dsh-peek:listener')
}

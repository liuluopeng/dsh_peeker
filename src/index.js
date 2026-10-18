/**
 * lx_dsh_peek — a read-only, LAN-only peek at the running DSH session.
 *
 * The plugin serves one small page and one SSE stream. It never accepts input:
 * every request is GET, and the only Session Controller methods it calls are
 * `list()` and `follow()`. The page flashes three times when a live `turn/end`
 * event arrives.
 *
 * It also contributes one host-side stylesheet to every DSH index page: larger
 * font variables and, when configured, a fixed width for the official
 * conversation column. The injected rules are plain CSS, so they survive in the
 * official desktop app without patching its bundle.
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
  // JSON and HTML answers close their socket; the SSE response below overrides
  // this with keep-alive. That leaves exactly one long-lived browser connection
  // on constrained mobile browsers, even while a /api/sessions poll is in flight.
  'connection': 'close',
}

/**
 * CSS cap used by `contentWidth: 'fill'`. The transcript and composer keep
 * `width: 100%`, so any cap above the pane width makes them fill the pane.
 */
const FILL_WIDTH = 10_000

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
 *
 * A subagent child carries its durable parent id so the stream can follow it
 * with `{ kind: 'subagent', parentSessionId, childSessionId, mode: 'unknown' }`;
 * a plain `{ kind: 'session' }` address is rejected by the Host with
 * "subagent Sessions require their durable parent address".
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
async function listSessions(ctx) {
  const value = await ctx.sessionController.list({}, AbortSignal.timeout(8000))
  const items = Array.isArray(value?.items) ? value.items : []
  return items
    // A subagent row without its durable parent cannot be followed; leave it out
    // instead of exposing a pane that can only fail.
    .filter((item) => item?.origin !== 'subagent' || typeof item?.parentSessionId === 'string')
    .map((item) => ({
      sessionId: String(item?.sessionId ?? ''),
      title: sessionTitle(item),
      cwd: typeof item?.cwd === 'string' ? item.cwd : '',
      running: item?.running === true,
      updatedAt: Number.isFinite(Number(item?.updatedAt)) ? Number(item.updatedAt) : 0,
      ...(item?.origin === 'subagent' && typeof item?.parentSessionId === 'string'
        ? { parentSessionId: item.parentSessionId }
        : {}),
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
 * @param {{ port?: number, fontSize?: number, codeFontSize?: number, terminalFontSize?: number, contentWidth?: number | 'fill' } | undefined} config
 */
export function apply(ctx, config) {
  const port = Number(config?.port ?? 3082)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`lx_dsh_peek: port must be an integer from 1 to 65535, got ${JSON.stringify(config?.port)}`)
  }
  const fontSize = Number(config?.fontSize ?? 34)
  const codeFontSize = Number(config?.codeFontSize ?? 24)
  const terminalFontSize = Number(config?.terminalFontSize ?? 24)
  for (const [name, value] of [['fontSize', fontSize], ['codeFontSize', codeFontSize], ['terminalFontSize', terminalFontSize]]) {
    if (!Number.isInteger(value) || value < 8 || value > 80) {
      throw new Error(`lx_dsh_peek: ${name} must be an integer from 8 to 80, got ${JSON.stringify(value)}`)
    }
  }
  const rawContentWidth = config?.contentWidth ?? 'fill'
  const contentWidth = rawContentWidth === 'fill' ? FILL_WIDTH : Number(rawContentWidth)
  if (rawContentWidth !== 'fill' && (!Number.isInteger(contentWidth) || (contentWidth !== 0 && (contentWidth < 640 || contentWidth > 2400)))) {
    throw new Error(`lx_dsh_peek: contentWidth must be 'fill', 0 (official width), or an integer from 640 to 2400, got ${JSON.stringify(config?.contentWidth)}`)
  }
  const fontStyle = `:root, body {
  --dsh-content-font-size: ${fontSize}px !important;
  --dsh-code-font-size: ${codeFontSize}px !important;
  --dsh-terminal-font-size: ${terminalFontSize}px !important;
}`
  // The official conversation column is adaptive and caps at 920px. Pinning the
  // shared content axis widens the transcript, dock cards, composer, and
  // approval/question panels together. `fill` uses a cap above any real pane so
  // the official `width: 100%` rules consume the whole conversation pane; a
  // number pins a readable maximum. The built-in drag handles are hidden because
  // their preference would be ignored; `contentWidth: 0` keeps the official
  // behavior instead.
  const widthStyle = contentWidth === 0 ? '' : `
:root, body {
  --dsh-chat-user-width: ${contentWidth}px;
}
[data-conversation-content] {
  --dsh-chat-content-width: ${contentWidth}px !important;
  --dsh-composer-card-max-width: ${contentWidth + 32}px !important;
}
[data-conversation-content] [data-width-handle] {
  display: none !important;
}`
  const injectedStyle = `${fontStyle}${widthStyle}`

  const page = readFileSync(new URL('./page.html', import.meta.url), 'utf8')
  /** @type {Set<{ controller: AbortController, res: import('node:http').ServerResponse }>} */
  const streams = new Set()
  let disposed = false

  ctx.effect(() => {
    const off = ctx.on('webserver/index-inject', (table) => {
      table.push({ kind: 'style', text: injectedStyle })
    })
    return () => { if (typeof off === 'function') off() }
  }, 'lx-dsh-peek:official-ui-overrides')

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
   * Forward one session's background-job roster and live output through the
   * caller's emitter. Each pane no longer owns a browser connection, so every
   * job frame carries the session id that owns it.
   */
  function startJobStreaming(sessionId, emit, signal) {
    const jobController = ctx.get('jobController')
    if (jobController === undefined) return () => {}
    const follows = new Map()
    const send = (payload) => {
      if (!signal.aborted) emit(sessionId, payload)
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

  /**
   * Serve one SSE stream for one or more sessions.
   *
   * The mobile page opens a single connection and passes every visible session
   * as a repeated `sessionId` parameter, with a parallel `parentSessionId`
   * parameter for subagent children (empty for ordinary sessions). A
   * one-session request keeps the old untagged payloads; a multi-session
   * request tags every payload with its `sessionId` so the page can dispatch it
   * to the right pane. This avoids the per-origin connection limit (and queued
   * EventSources) that left a second pane stuck on "连接中" on mobile browsers.
   */
  async function handleStream(req, res, url) {
    if (disposed) {
      sendJson(res, 503, { error: 'plugin disposed' })
      return
    }
    const sessionIds = url.searchParams.getAll('sessionId')
    const parentIds = url.searchParams.getAll('parentSessionId')
    const entries = []
    const seen = new Set()
    for (let index = 0; index < sessionIds.length; index += 1) {
      const sessionId = sessionIds[index]
      if (sessionId === '' || seen.has(sessionId)) continue
      seen.add(sessionId)
      entries.push({ sessionId, parentSessionId: parentIds[index] ?? '' })
    }
    if (entries.length === 0) {
      sendJson(res, 400, { error: 'sessionId is required' })
      return
    }
    const multi = entries.length > 1
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': 'text/event-stream; charset=utf-8',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write('retry: 2000\n\n')
    const controllers = new Map()
    const jobAborts = new Map()
    let entry
    let closed = false
    const stop = () => {
      if (closed) return
      closed = true
      for (const controller of controllers.values()) controller.abort()
      for (const abort of jobAborts.values()) abort.abort()
      controllers.clear()
      jobAborts.clear()
      if (entry !== undefined) streams.delete(entry)
    }
    entry = { res, stop }
    streams.add(entry)
    const emit = (sessionId, payload) => {
      if (closed || disposed || res.writableEnded || res.destroyed) return
      sendEvent(res, multi ? { ...payload, sessionId } : payload)
    }
    req.on('close', stop)
    res.on('close', stop)
    const ping = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) {
        try {
          // The comment keeps proxies warm; the data frame gives the page a
          // heartbeat it can observe, so it can detect a silently suspended
          // mobile connection and force a fresh stream on the next visible frame.
          res.write(': ping\n\n')
          sendEvent(res, { t: 'ping', at: Date.now() })
        } catch { stop() }
      }
    }, 15000)
    const followSession = async (sessionId, parentSessionId) => {
      const controller = new AbortController()
      controllers.set(sessionId, controller)
      const jobAbort = new AbortController()
      jobAborts.set(sessionId, jobAbort)
      const stopJobs = startJobStreaming(sessionId, emit, jobAbort.signal)
      const address = parentSessionId === ''
        ? { kind: 'session', sessionId }
        : { kind: 'subagent', parentSessionId, childSessionId: sessionId, mode: 'unknown' }
      try {
        const frames = ctx.sessionController.follow({
          address,
          maxMessages: 200,
          assistantStream: true,
        }, controller.signal)
        for await (const frame of frames) {
          if (controller.signal.aborted || disposed) break
          if (frame?.type === 'snapshot') {
            const fitted = fitSnapshot(frame.records)
            emit(sessionId, { t: 'snapshot', records: fitted.records, dropped: fitted.dropped })
          } else if (frame?.type === 'event') {
            emit(sessionId, { t: 'event', event: shrink(trimEvent(frame.event)) })
            if (frame.event?.type === 'turn/end') emit(sessionId, { t: 'flash', times: 3 })
          } else if (frame?.type === 'assistant-stream') {
            emit(sessionId, { t: 'delta', frame: frame.frame })
          }
        }
      } catch (error) {
        if (!controller.signal.aborted && !disposed) {
          emit(sessionId, { t: 'error', message: String(error?.message ?? error) })
        }
      } finally {
        controllers.delete(sessionId)
        jobAborts.delete(sessionId)
        jobAbort.abort()
        stopJobs()
      }
    }
    try {
      await Promise.all(entries.map(({ sessionId, parentSessionId }) => followSession(sessionId, parentSessionId)))
      if (!closed && !disposed) {
        for (const { sessionId } of entries) emit(sessionId, { t: 'end' })
      }
    } finally {
      clearInterval(ping)
      stop()
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
        try { entry.stop() } catch { /* already gone */ }
        try { entry.res.end() } catch { /* already closed */ }
      }
      streams.clear()
      server.closeAllConnections?.()
      server.close()
    }
  }, 'lx-dsh-peek:listener')
}

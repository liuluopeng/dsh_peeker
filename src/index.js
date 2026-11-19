/**
 * lx_dsh_peek — a read-only, LAN-only peek at the running DSH session.
 *
 * The plugin serves one small page and one SSE stream. It never accepts input:
 * every request is GET, and the only Session Controller methods it calls are
 * `list()` and `follow()`. The page flashes three times when a live `turn/end`
 * event arrives.
 *
 * It also contributes one host-side stylesheet to every DSH index page: larger
 * font variables, a taller composer, and, when configured, a fixed width for
 * the official conversation column. The injected rules are plain CSS, so they
 * survive in the official desktop app without patching its bundle.
 */

import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'

import { createZcodeSource, isZcodeSessionId, ZCODE_PREFIX } from './zcode.js'
import { createArchiver } from './archive.js'

/** Plugin name used by Cordis diagnostics and loader display. */
export const name = 'lx-dsh-peek'

/** Wait for the Session Controller before mounting. */
export const inject = ['sessionController', 'sessionQuery']

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

/** Length of the `z:` prefix that marks a ZCode session id. */
const ZCODE_PREFIX_LENGTH = 2

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

/**
 * A live `assistant/message` commit replaces text the page has already
 * streamed in full, so its text and reasoning get a much higher cap than
 * snapshots — truncating here would visibly cut a finished reply short the
 * moment it commits.
 */
const LIVE_TEXT_MAX = 65_536

function shrinkEvent(event) {
  if (event?.type !== 'assistant/message' || event.data === null || typeof event.data !== 'object') return shrink(event)
  const message = event.data.message ?? {}
  const content = Array.isArray(message.content) ? message.content : []
  const capped = content.map((block) => {
    if ((block?.type === 'text' || block?.type === 'reasoning') && typeof block.text === 'string' && block.text.length > LIVE_TEXT_MAX) {
      return { ...block, text: `${block.text.slice(0, LIVE_TEXT_MAX)}\n…（已截断）` }
    }
    return block
  })
  return { ...event, data: { ...event.data, message: { ...message, content: capped } } }
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
 * @param {{ port?: number, fontSize?: number, codeFontSize?: number, terminalFontSize?: number, contentWidth?: number | 'fill', composerHeight?: number } | undefined} config
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
  const composerHeight = Number(config?.composerHeight ?? 200)
  if (!Number.isInteger(composerHeight) || (composerHeight !== 0 && (composerHeight < 80 || composerHeight > 600))) {
    throw new Error(`lx_dsh_peek: composerHeight must be 0 (official height) or an integer from 80 to 600, got ${JSON.stringify(config?.composerHeight)}`)
  }
  if (config?.zcode !== undefined && typeof config.zcode !== 'boolean') {
    throw new Error(`lx_dsh_peek: zcode must be a boolean, got ${JSON.stringify(config.zcode)}`)
  }
  if (config?.zcodeDbPath !== undefined && (typeof config.zcodeDbPath !== 'string' || config.zcodeDbPath.trim() === '')) {
    throw new Error(`lx_dsh_peek: zcodeDbPath must be a non-empty string, got ${JSON.stringify(config.zcodeDbPath)}`)
  }
  // ZCode sessions come from the ZCode app's own SQLite store, read-only. The
  // source never throws into the DSH paths; all of its failures degrade to
  // "no ZCode sessions" with a throttled log line.
  const zcode = createZcodeSource({
    enabled: config?.zcode !== false,
    dbPath: config?.zcodeDbPath,
    log: (message) => console.error(`[lx-dsh-peek] zcode: ${message}`),
  })
  // 会话归档：把每个会话的完整事件流镜像到 NAS 的 PG（默认开启；无 token 时
  // 只留在内存并在 /api/archive/status 里标 no-token，不改动监看行为）。
  if (config?.archive !== undefined && (config.archive === null || typeof config.archive !== 'object')) {
    throw new Error(`lx_dsh_peek: archive must be an object, got ${JSON.stringify(config.archive)}`)
  }
  const archiver = createArchiver({
    ctx,
    config: { enabled: true, ...config?.archive },
    log: (line) => console.error(line),
  })
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
  // Stable data attributes on the official composer. The hero state has a
  // more specific `.…_hero .…_input { min-height: 52px }` rule, so the
  // min-height needs !important. The scroll container inherits the max-height
  // custom property from the card, which lets a long draft scroll only after
  // the taller box is filled.
  const composerStyle = composerHeight === 0 ? '' : `
[data-composer-input="true"] {
  min-height: ${composerHeight}px !important;
}
[data-composer-card="true"] {
  --dsh-composer-text-max-height: ${Math.max(360, composerHeight + 160)}px !important;
}`
  const injectedStyle = `${fontStyle}${widthStyle}${composerStyle}`

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

  ctx.effect(() => () => zcode.dispose(), 'lx-dsh-peek:zcode-source')

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
    if (url.pathname === '/api/archive/status') {
      sendJson(res, 200, archiver.status())
      return
    }
    if (url.pathname === '/api/archive/flush') {
      // 手动催一次投递（页面/运维用；仍然只写 NAS，不碰会话）
      await archiver.flush()
      sendJson(res, 200, archiver.status())
      return
    }
    if (url.pathname === '/api/sessions') {
      try {
        // Each source degrades independently: a DSH Controller failure must
        // not hide ZCode sessions and vice versa.
        const [items, zcodeItems] = await Promise.all([
          listSessions(ctx).catch((error) => {
            console.error(`[lx-dsh-peek] dsh session list failed: ${String(error?.message ?? error)}`)
            return []
          }),
          zcode.list().catch(() => []),
        ])
        sendJson(res, 200, { items: [...items, ...zcodeItems] })
      } catch (error) {
        sendJson(res, 500, { error: String(error?.message ?? error) })
      }
      return
    }
    if (url.pathname === '/api/bootstrap') {
      await handleBootstrap(req, res, url)
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
   * Serve the initial transcript as a plain JSON response.
   *
   * A large one-shot SSE write is exactly what mobile networks/proxies buffer
   * until more data arrives, which leaves the phone showing only "运行中". The
   * DSH mobile bridge solves this by bootstrapping over a normal HTTP request
   * and keeping SSE for live deltas; this endpoint is the same split for the
   * peek page.
   */
  async function handleBootstrap(req, res, url) {
    const sessionId = url.searchParams.get('sessionId') ?? ''
    if (sessionId === '') {
      sendJson(res, 400, { error: 'missing sessionId' })
      return
    }
    if (isZcodeSessionId(sessionId)) {
      // A ZCode snapshot fails soft: an empty transcript keeps the pane usable
      // for the live watcher instead of surfacing a store error on the phone.
      const records = await zcode.bootstrap(sessionId.slice(ZCODE_PREFIX_LENGTH))
      const fitted = fitSnapshot(records)
      sendJson(res, 200, { records: fitted.records, dropped: fitted.dropped })
      return
    }
    const parentSessionId = url.searchParams.get('parentSessionId') ?? ''
    const address = parentSessionId === ''
      ? { kind: 'session', sessionId }
      : { kind: 'subagent', parentSessionId, childSessionId: sessionId, mode: 'unknown' }
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, 10000)
    try {
      const frames = ctx.sessionController.follow({
        address,
        maxMessages: 200,
        assistantStream: true,
      }, controller.signal)
      for await (const frame of frames) {
        if (frame?.type !== 'snapshot') continue
        const fitted = fitSnapshot(frame.records)
        sendJson(res, 200, {
          records: fitted.records,
          dropped: fitted.dropped,
          ...(typeof frame.cursor === 'number' ? { cursor: frame.cursor } : {}),
          ...(frame.assistantStream === undefined ? {} : { assistantStream: frame.assistantStream }),
        })
        return
      }
      sendJson(res, 200, { records: [], dropped: 0 })
    } catch (error) {
      if (timedOut) sendJson(res, 200, { records: [], dropped: 0 })
      else sendJson(res, 500, { error: String(error?.message ?? error) })
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
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
    // First real data frame: proves the stream is live before any follow work.
    // The initial transcript is fetched separately through /api/bootstrap.
    sendEvent(res, { t: 'ready' })
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
          // mobile connection and force a fresh stream on the next visible
          // frame. Five seconds matches the page's 12-second stale threshold
          // with room for a couple of lost writes.
          res.write(': ping\n\n')
          sendEvent(res, { t: 'ping', at: Date.now() })
        } catch { stop() }
      }
    }, 5000)
    /**
     * Emit one follow snapshot as a series of small SSE frames. History truth
     * and live events share one ordered connection, so a reconnect resyncs
     * deterministically instead of racing a separate bootstrap fetch. The
     * chunking is what keeps mobile proxies from stalling a one-shot large
     * SSE write: no single frame approaches the sizes that buffer.
     */
    const emitSnapshotFrames = (sessionId, { records, cursor, dropped, assistantStream }) => {
      const batch = 20
      if (records.length === 0) {
        emit(sessionId, {
          t: 'snapshot', records,
          ...(cursor === undefined ? {} : { cursor }),
          ...(dropped > 0 ? { dropped } : {}),
          final: true,
          ...(assistantStream === undefined ? {} : { assistantStream }),
        })
        return
      }
      for (let from = 0; from < records.length; from += batch) {
        const final = from + batch >= records.length
        emit(sessionId, {
          t: 'snapshot',
          ...(from === 0 ? { ...(cursor === undefined ? {} : { cursor }), ...(dropped > 0 ? { dropped } : {}) } : {}),
          records: records.slice(from, from + batch),
          final,
          ...(final && assistantStream !== undefined ? { assistantStream } : {}),
        })
      }
    }
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
            // The follow snapshot opens the stream on purpose: history truth
            // and live events share one ordered connection, so a reconnect
            // resyncs deterministically instead of racing a separate
            // bootstrap fetch.
            const fitted = fitSnapshot(frame.records)
            emitSnapshotFrames(sessionId, {
              records: fitted.records,
              dropped: fitted.dropped,
              cursor: typeof frame.cursor === 'number' ? frame.cursor : undefined,
              assistantStream: frame.assistantStream,
            })
          } else if (frame?.type === 'event') {
            emit(sessionId, { t: 'event', event: shrinkEvent(trimEvent(frame.event)) })
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
    /**
     * ZCode sessions have no Host follow stream; one watcher polls the ZCode
     * store for all of this connection's `z:` entries and synthesizes the same
     * event/delta frames. A finished turn carries its own flash frame.
     */
    const followZcode = async (rawIds) => {
      if (rawIds.length === 0) return
      const controller = new AbortController()
      controllers.set(rawIds.join('\u0000'), controller)
      const zcodeEmit = (rawId, payload) => {
        if (payload?.t === 'snapshot') {
          const fitted = fitSnapshot(payload.records)
          emitSnapshotFrames(`${ZCODE_PREFIX}${rawId}`, { records: fitted.records, dropped: fitted.dropped })
          return
        }
        if (payload?.t === 'event') payload = { ...payload, event: shrinkEvent(trimEvent(payload.event)) }
        emit(`${ZCODE_PREFIX}${rawId}`, payload)
        if (payload?.t === 'event' && payload.event?.type === 'turn/end') {
          emit(`${ZCODE_PREFIX}${rawId}`, { t: 'flash', times: 3 })
        }
      }
      try {
        await zcode.watch(rawIds, zcodeEmit, controller.signal)
      } catch (error) {
        if (!controller.signal.aborted && !disposed) {
          for (const rawId of rawIds) emit(`${ZCODE_PREFIX}${rawId}`, { t: 'error', message: String(error?.message ?? error) })
        }
      } finally {
        controllers.delete(rawIds.join('\u0000'))
      }
    }
    try {
      const zcodeIds = entries
        .filter(({ sessionId }) => isZcodeSessionId(sessionId))
        .map(({ sessionId }) => sessionId.slice(ZCODE_PREFIX_LENGTH))
      await Promise.all([
        ...entries
          .filter(({ sessionId }) => !isZcodeSessionId(sessionId))
          .map(({ sessionId, parentSessionId }) => followSession(sessionId, parentSessionId)),
        followZcode(zcodeIds),
      ])
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
      try { archiver.stop() } catch { /* teardown is best effort */ }
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

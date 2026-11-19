/**
 * lx_dsh_peek archive — mirror every DSH session's full event stream into the
 * NAS PostgreSQL (dayly_service `/api/dsh/archive`).
 *
 * Why this exists: when several AI agents run in parallel, a past conversation
 * is otherwise only findable through the hand-written `nohup.md` summary. This
 * module records the machine truth instead: every user message, assistant
 * text, reasoning block, tool call, tool result, turn boundary and approval —
 * append-only, deduplicated by `(session_id, seq)`.
 *
 * Why it cannot miss messages (the peek viewer's three known gaps):
 *   1. The viewer only ever takes a bounded `maxMessages` snapshot and never
 *      pages backwards, so older history is dropped. Here `backfill()` opens a
 *      `follow()` only to learn the log cursor, breaks immediately (no Agent
 *      promotion), then walks `page({ beforeSeq })` until `hasMore === false`
 *      — that is the complete log.
 *   2. The viewer shrinks strings to 4000 chars. Here payloads are forwarded
 *      unshrunk (only `assistant/message.stream` — the per-token duplicate of
 *      the content blocks — is dropped by default).
 *   3. The viewer only captures while a browser page is connected. Here live
 *      capture is the Host `session/event` firehose, independent of viewers.
 *
 * Delivery is at-least-once: a failed POST is written to a local JSONL spool
 * under `~/.dsh/lx-dsh-peek-archive/spool/` and retried until the NAS accepts
 * it, so an expired token or a NAS restart loses nothing.
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Root of the local archive state (never inside a repository). */
export const ARCHIVE_HOME = join(homedir(), '.dsh', 'lx-dsh-peek-archive')

/** Durable events whose `assistant/message.stream` may be dropped. */
const STREAM_EVENT = 'assistant/message'

/** How many messages one `page()` call asks for while backfilling. */
const PAGE_MESSAGES = 200

/** Sanity bound for one session's backward paging (a 1M-event session stops here). */
const MAX_PAGES = 2000

/** Event types kept out of the archive entirely (presentation-only keepalives). */
const DROP_TYPES = new Set(['session/end-seed'])

/**
 * Conversation-only event types. The archive keeps the user's questions and
 * the assistant's prose plus reasoning — no tool calls, tool output, step or
 * job bookkeeping (they were 4/5 of the bytes and unreadable).
 */
const TEXT_TYPES = new Set(['user/message', 'assistant/message', 'session/title'])

/**
 * Extract the human-readable text of one event: user text, assistant text and
 * reasoning blocks. Tool-call blocks are skipped by design.
 * @param {string} kind event type
 * @param {any} data event data
 * @returns {string}
 */
export function conversationText(kind, data) {
  if (kind === 'session/title') {
    return typeof data?.title === 'string' ? data.title.trim() : ''
  }
  const content = kind === 'assistant/message' || kind === 'system/message'
    ? data?.message?.content
    : kind === 'tool/result'
      ? data?.message?.content
      : data?.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    const text = typeof block?.text === 'string' ? block.text.trim() : ''
    if (text === '') continue
    if (block.type === 'text') parts.push(text)
    else if (block.type === 'reasoning') parts.push(`[思考] ${text}`)
  }
  return parts.join('\n')
}

/**
 * Read a token's remaining lifetime from its JWT payload.
 * @param {string} token
 * @returns {{ expiresAt: number | null, daysLeft: number | null }}
 */
export function tokenLifetime(token) {
  const empty = { expiresAt: null, daysLeft: null }
  if (typeof token !== 'string' || token === '') return empty
  const parts = token.split('.')
  if (parts.length < 2) return empty
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    const exp = Number(payload?.exp)
    if (!Number.isFinite(exp) || exp <= 0) return empty
    return { expiresAt: exp * 1000, daysLeft: (exp * 1000 - Date.now()) / 86_400_000 }
  } catch {
    return empty
  }
}

/**
 * Drop the per-token assistant stream copy (content blocks already carry the
 * same text/reasoning/tool calls). Keeps one event small enough for a phone.
 * @param {any} event
 * @param {boolean} storeStream
 */
export function compactEvent(event, storeStream) {
  if (storeStream === true) return event
  if (event?.type !== STREAM_EVENT) return event
  const data = event.data
  if (data === null || typeof data !== 'object' || !('stream' in data)) return event
  const { stream: _stream, ...rest } = data
  return { ...event, data: rest }
}

/**
 * Decide whether one captured event is worth sending.
 * @param {any} event durable SessionEvent
 * @param {number} archivedSeq last seq already accepted by the NAS
 * @returns {boolean}
 */
export function shouldArchive(event, archivedSeq, mode = 'text') {
  if (event === null || typeof event !== 'object') return false
  if (typeof event.type !== 'string' || !Number.isSafeInteger(event.seq)) return false
  if (DROP_TYPES.has(event.type)) return false
  if (mode !== 'full' && !TEXT_TYPES.has(event.type)) return false
  return event.seq > archivedSeq
}

/**
 * Build the `sessions` rows for one session header.
 * @param {any} header SessionWireHeader or Session.header
 * @param {string} [title]
 */
export function sessionMeta(header, title = '') {
  if (header === null || typeof header !== 'object') return null
  const id = header.id
  if (typeof id !== 'string' || id === '') return null
  return {
    session_id: id,
    workspace: typeof header.cwd === 'string' ? header.cwd : '',
    title: typeof title === 'string' ? title : '',
    origin: typeof header.origin === 'string' ? header.origin : '',
    parent_session_id: typeof header.parentSession === 'string' ? header.parentSession : null,
    created_at: Number.isFinite(Number(header.createdAt)) ? Number(header.createdAt) : null,
    meta: {
      version: header.version,
      isSeeded: header.isSeeded === true ? true : undefined,
      delegationDepth: Number.isFinite(Number(header.delegationDepth))
        ? Number(header.delegationDepth)
        : undefined,
      agentPreset: typeof header.agentPreset === 'string' ? header.agentPreset : undefined,
    },
  }
}

/** Bounded exponential backoff for the delivery loop. */
function backoffMs(attempt) {
  return Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6))
}

/**
 * Minimal JSON-over-HTTP client.
 *
 * The NAS uses a Caddy self-signed certificate whose SAN is the LAN IP, so the
 * default is to accept it (`insecureTls: true`); the request stays on the LAN.
 *
 * @param {{ base: string, token: string | (() => string), insecure: boolean }} options
 * @returns {(path: string, body?: any, timeoutMs?: number) => Promise<any>}
 */
function createClient({ base, token, insecure }) {
  const root = new URL(base)
  // The token may be rotated by auto-login, so read it at request time.
  const bearer = typeof token === 'function' ? token : () => token
  return function requestJson(path, body, timeoutMs = 20_000) {
    const url = new URL(path, root)
    const isHttps = url.protocol === 'https:'
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const headers = { accept: 'application/json' }
    if (payload !== null) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = String(payload.length)
    }
    const credential = bearer()
    if (credential) headers.authorization = `Bearer ${credential}`
    const send = isHttps ? httpsRequest : httpRequest
    return new Promise((resolve, reject) => {
      const req = send(
        url,
        {
          method: payload === null ? 'GET' : 'POST',
          headers,
          ...(isHttps && insecure ? { rejectUnauthorized: false } : {}),
        },
        (res) => {
          const chunks = []
          res.on('data', (chunk) => chunks.push(chunk))
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            let parsed = null
            try {
              parsed = text === '' ? null : JSON.parse(text)
            } catch {
              // Non-JSON error page (proxy/redirect); keep the text for the log.
            }
            if (res.statusCode >= 200 && res.statusCode < 300 && parsed !== null) resolve(parsed)
            else reject(Object.assign(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`), {
              status: res.statusCode,
            }))
          })
        },
      )
      req.on('error', reject)
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`timeout after ${timeoutMs}ms`))
      })
      if (payload !== null) req.write(payload)
      req.end()
    })
  }
}

/**
 * Mount the archiver.
 *
 * @param {object} options
 * @param {import('@deepseek-ai/cordis').Context} options.ctx Host context (`inject: ['sessionController']`)
 * @param {object} [options.config] archive config block
 * @param {(line: string) => void} [options.log]
 * @returns {{ status: () => object, stop: () => void }}
 */
export function createArchiver({ ctx, config, zcode, log = (line) => console.error(line) }) {
  const enabled = config?.enabled !== false
  const apiBase = String(config?.apiBase ?? 'http://192.168.31.58:23000')
  let token = String(config?.token ?? process.env.LX_DSH_ARCHIVE_TOKEN ?? '').trim()
  // 可选：账号登录自动续期（免去每 30 天手贴 JWT）。密码可写在配置文件里，
  // 也可放在 600 权限的独立文件（passwordFile）。
  const username = String(config?.username ?? '').trim()
  const password = String(config?.password ?? '').trim()
  const passwordFile = String(config?.passwordFile ?? '').trim()
  const insecure = config?.insecureTls !== false
  const batch = Math.max(1, Math.min(500, Number(config?.batch ?? 200)))
  const flushMs = Math.max(500, Number(config?.flushMs ?? 3000))
  const pollMs = Math.max(5000, Number(config?.pollMs ?? 30_000))
  const backfillEnabled = config?.backfill !== false
  const storeStream = config?.storeStream === true
  const mode = config?.mode === 'full' ? 'full' : 'text'
  const zcodeEnabled = config?.zcode !== false && zcode !== undefined && typeof zcode?.exportSessions === 'function'

  // Isolated directory (tests / second instance); defaults to the per-user home.
  const home = typeof config?.home === 'string' && config.home !== '' ? config.home : ARCHIVE_HOME
  const stateFile = join(home, 'state.json')
  const spoolDir = join(home, 'spool')

  /** @type {{ sessions: Record<string, { archivedSeq: number, backfilled: boolean, checkedAt: number, title?: string }> }} */
  const state = { sessions: {} }
  const stats = {
    queued: 0,
    spooled: 0,
    sent: 0,
    batches: 0,
    failures: 0,
    skipped: 0,
    backfilled: 0,
    lastError: '',
    lastSuccessAt: 0,
    lastErrorAt: 0,
    state: enabled ? 'starting' : 'disabled',
  }
  /** @type {any[]} */
  let queue = []
  /** @type {Map<string, any>} session rows waiting to be sent with the next batch */
  const pendingMeta = new Map()
  /** @type {Set<string>} `${sessionId}:${seq}` guard against double enqueue */
  const inflight = new Set()
  let flushing = false
  let stopped = false
  let failureStreak = 0
  let flushTimer = null
  let pollTimer = null
  let saveTimer = null
  let backfilling = false
  const backfillQueue = []

  const request = createClient({ base: apiBase, token: () => token, insecure })
  let lifetime = tokenLifetime(token)
  const authFile = join(home, 'auth.json')
  let loginInFlight = null
  let lastLoginAt = 0
  let lastLoginError = ''
  let lastLoginAttemptAt = 0

  function ensureDirs() {
    mkdirSync(spoolDir, { recursive: true })
  }

  function loadState() {
    try {
      const parsed = JSON.parse(readFileSync(stateFile, 'utf8'))
      if (parsed !== null && typeof parsed === 'object' && parsed.sessions !== null) {
        for (const [id, row] of Object.entries(parsed.sessions)) {
          if (row === null || typeof row !== 'object') continue
          state.sessions[id] = {
            archivedSeq: Number.isSafeInteger(row.archivedSeq) ? row.archivedSeq : -1,
            backfilled: row.backfilled === true,
            checkedAt: Number.isFinite(Number(row.checkedAt)) ? Number(row.checkedAt) : 0,
            ...(typeof row.title === 'string' && row.title !== '' ? { title: row.title } : {}),
          }
        }
      }
    } catch {
      // A missing or corrupt state file just means "archive from scratch";
      // the NAS deduplicates by (session_id, seq), so replay is harmless.
    }
  }

  function saveStateSoon() {
    if (saveTimer !== null || stopped) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      try {
        ensureDirs()
        const tmp = `${stateFile}.tmp`
        writeFileSync(tmp, JSON.stringify({ version: 1, sessions: state.sessions }))
        renameSync(tmp, stateFile)
      } catch (error) {
        log(`[lx-dsh-peek] archive: state save failed: ${String(error?.message ?? error)}`)
      }
    }, 1500)
    saveTimer.unref?.()
  }

  function readPassword() {
    if (password !== '') return password
    if (passwordFile === '') return ''
    try {
      return readFileSync(passwordFile, 'utf8').trim()
    } catch {
      return ''
    }
  }

  /** Restore a token persisted by a previous auto-login. */
  function loadAuthFile() {
    try {
      const parsed = JSON.parse(readFileSync(authFile, 'utf8'))
      const saved = String(parsed?.token ?? '')
      if (saved === '') return
      const savedLifetime = tokenLifetime(saved)
      if (savedLifetime.daysLeft !== null && savedLifetime.daysLeft <= 0) return
      // A token pasted in the profile config wins over the cached one.
      if (token === '') {
        token = saved
        lifetime = savedLifetime
      }
    } catch {
      // no cached credential yet
    }
  }

  function saveAuthFile() {
    try {
      ensureDirs()
      writeFileSync(authFile, JSON.stringify({ token, savedAt: Date.now() }), { mode: 0o600 })
    } catch (error) {
      log(`[lx-dsh-peek] archive: auth cache write failed: ${String(error?.message ?? error)}`)
    }
  }

  /**
   * Refresh the JWT through `POST /api/user/login` when the current one is
   * missing or about to expire. Returns quietly when no credentials exist.
   * @param {boolean} [force] ignore the cached token (after a 401)
   */
  async function ensureToken(force = false) {
    if (username === '' || readPassword() === '') return
    const noToken = token === ''
    const expiring = lifetime.daysLeft !== null && lifetime.daysLeft < 3
    if (!force && !noToken && !expiring) return
    // 登录失败后 60s 内不再重试，避免 NAS 掉线时每秒打一次登录接口
    if (!force && Date.now() - lastLoginAttemptAt < 60_000) return
    if (loginInFlight !== null) return loginInFlight
    loginInFlight = (async () => {
      try {
        const answer = await request('/api/user/login', {
          username,
          password: readPassword(),
        })
        const fresh = String(answer?.data?.token ?? answer?.token ?? '')
        if (fresh === '') throw new Error('login returned no token')
        token = fresh
        lifetime = tokenLifetime(fresh)
        lastLoginAt = Date.now()
        lastLoginAttemptAt = lastLoginAt
        lastLoginError = ''
        saveAuthFile()
        stats.state = 'ok'
        log(`[lx-dsh-peek] archive: token refreshed via login (${Math.round((lifetime.daysLeft ?? 0) * 10) / 10} days left)`)
      } catch (error) {
        lastLoginError = String(error?.message ?? error)
        lastLoginAttemptAt = Date.now()
        // 登录失败沿用旧 token；真正的 401 会在 flush 里再次触发本函数
        log(`[lx-dsh-peek] archive: auto-login failed: ${lastLoginError}`)
      } finally {
        loginInFlight = null
      }
    })()
    return loginInFlight
  }

  function sessionRow(sessionId) {
    let row = state.sessions[sessionId]
    if (row === undefined) {
      row = { archivedSeq: -1, backfilled: false, checkedAt: 0 }
      state.sessions[sessionId] = row
    }
    return row
  }

  /** Remember one session header for the next ingest batch. */
  function rememberSession(header, title) {
    const meta = sessionMeta(header, title)
    if (meta === null) return
    const row = sessionRow(meta.session_id)
    if (typeof title === 'string' && title !== '' && row.title !== title) {
      row.title = title
      saveStateSoon()
    }
    pendingMeta.set(meta.session_id, meta)
  }

  /**
   * Queue one durable event for delivery.
   * @param {any} session live Session
   * @param {any} event durable SessionEvent
   * @param {{ force?: boolean }} [options] force bypasses the archived-seq filter
   *   (backfill sends history newest-first, so the filter would otherwise drop
   *   the older half; duplicates are harmless because the NAS deduplicates)
   */
  function enqueue(session, event, options = {}) {
    if (!enabled || stopped) return
    const row = sessionRow(session.id)
    if (event.type === 'session/title') {
      const title = event?.data?.title
      if (typeof title === 'string' && title !== '') {
        row.title = title
        rememberSession(session.header ?? { id: session.id }, title)
        saveStateSoon()
      }
    }
    if (options.force !== true && !shouldArchive(event, row.archivedSeq, mode)) return
    // 文本模式只发抽取好的对话文本，不带事件原文：体积从 393MB 降到几十 MB
    const text = mode === 'full' ? '' : conversationText(event.type, event.data)
    if (mode !== 'full' && text === '') return
    const key = `${session.id}:${event.seq}`
    if (inflight.has(key)) return
    inflight.add(key)
    rememberSession(session.header ?? { id: session.id }, row.title ?? '')
    const compact = mode === 'full' ? compactEvent(event, storeStream) : null
    queue.push(
      mode === 'full'
        ? {
            session_id: session.id,
            seq: compact.seq,
            type: compact.type,
            time: Number.isFinite(Number(compact.time)) ? Number(compact.time) : null,
            data: compact.data ?? {},
          }
        : {
            session_id: session.id,
            seq: event.seq,
            type: event.type,
            time: Number.isFinite(Number(event.time)) ? Number(event.time) : null,
            text,
          },
    )
    stats.queued = queue.length
    if (queue.length >= batch) void flush()
  }

  /**
   * Write queued events to spool files so a NAS outage loses nothing.
   * Files are byte-bounded (a spool file is replayed as one request, so an
   * oversized one would keep bouncing off the server's body limit).
   */
  function spillQueue() {
    if (queue.length === 0) return
    try {
      ensureDirs()
      let index = 0
      while (index < queue.length) {
        const chunk = takeBatchFrom(index)
        if (chunk.length === 0) break
        const name = `${String(Date.now()).padStart(14, '0')}-${process.pid}-${String(index).padStart(5, '0')}.json`
        const referenced = new Set(chunk.map((event) => event.session_id))
        const payload = {
          sessions: [...pendingMeta.values()].filter((meta) => referenced.has(meta.session_id)),
          events: chunk,
        }
        const tmp = join(spoolDir, `${name}.tmp`)
        writeFileSync(tmp, JSON.stringify(payload))
        renameSync(tmp, join(spoolDir, name))
        stats.spooled += chunk.length
        index += chunk.length
      }
    } catch (error) {
      log(`[lx-dsh-peek] archive: spool write failed (keeping in memory): ${String(error?.message ?? error)}`)
      return
    }
    for (const event of queue) inflight.delete(`${event.session_id}:${event.seq}`)
    queue = []
    stats.queued = 0
  }

  function spoolFiles() {
    try {
      return readdirSync(spoolDir)
        .filter((name) => name.endsWith('.json'))
        .sort()
    } catch {
      return []
    }
  }

  /** Send one batch (spool file first, then the in-memory queue). */
  async function sendOne() {
    const files = spoolFiles()
    if (files.length > 0) {
      const file = join(spoolDir, files[0])
      let payload
      try {
        payload = JSON.parse(readFileSync(file, 'utf8'))
      } catch {
        unlinkSync(file) // corrupt spool file: drop it rather than block forever
        return false
      }
      await postWithSplit(payload)
      try {
        unlinkSync(file)
      } catch {
        // Already gone (another instance?); harmless.
      }
      const events = Array.isArray(payload?.events) ? payload.events : []
      for (const event of events) {
        const row = sessionRow(event.session_id)
        if (event.seq > row.archivedSeq) row.archivedSeq = event.seq
      }
      stats.sent += events.length
      stats.batches += 1
      saveStateSoon()
      return true
    }
    if (queue.length === 0) return false
    const events = takeBatchFrom(0)
    // Only ship the session rows this batch references: a long backfill touches
    // every session, and the server (rightly) bounds rows per request.
    const referenced = new Set(events.map((event) => event.session_id))
    const sessions = [...pendingMeta.values()].filter((meta) => referenced.has(meta.session_id))
    await postWithSplit({ sessions, events })
    queue = queue.slice(events.length)
    stats.queued = queue.length
    for (const event of events) {
      const row = sessionRow(event.session_id)
      if (event.seq > row.archivedSeq) row.archivedSeq = event.seq
      inflight.delete(`${event.session_id}:${event.seq}`)
    }
    stats.sent += events.length
    stats.batches += 1
    saveStateSoon()
    return true
  }

  /**
   * Take up to `batch` events from `from`, stopping early when the serialized
   * batch would exceed the byte budget so one oversized tool result cannot
   * trigger a 413. The first event is always taken.
   */
  function takeBatchFrom(from = 0) {
    const budget = Math.max(64 * 1024, Number(config?.batchBytes ?? 1_500_000))
    const events = []
    let bytes = 0
    for (let index = from; index < queue.length; index += 1) {
      const event = queue[index]
      if (events.length >= batch) break
      const size = 120 + JSON.stringify(event).length
      if (events.length > 0 && bytes + size > budget) break
      events.push(event)
      bytes += size
    }
    return events
  }

  /**
   * POST one batch, halving it on 413 (a spool file written by an older build,
   * or one huge event, must not wedge the queue forever).
   */
  async function postWithSplit(payload) {
    try {
      return await request('/api/dsh/archive/ingest', payload)
    } catch (error) {
      const events = Array.isArray(payload?.events) ? payload.events : []
      if (Number(error?.status) !== 413 || events.length <= 1) throw error
      const mid = Math.ceil(events.length / 2)
      await postWithSplit({ sessions: payload.sessions, events: events.slice(0, mid) })
      return postWithSplit({ sessions: [], events: events.slice(mid) })
    }
  }

  /** Drain as much as the NAS accepts right now. */
  async function flush() {
    if (!enabled || stopped || flushing) return
    flushing = true
    try {
      await ensureToken()
      if (token === '') {
        // No credential: keep events in memory until the operator configures one.
        stats.state = 'no-token'
        return
      }
      // drain up to 20 batches per wake-up so a long backfill catches up fast
      for (let index = 0; index < 20 && !stopped; index += 1) {
        let sent
        try {
          sent = await sendOne()
        } catch (error) {
          const status = Number(error?.status ?? 0)
          // 401/403 = token expired/revoked: refresh through the login endpoint
          // and retry the same batch once before treating it as an outage.
          if ((status === 401 || status === 403) && index === 0) {
            await ensureToken(true)
            sent = await sendOne()
          } else {
            throw error
          }
        }
        if (!sent) break
        failureStreak = 0
        stats.state = 'ok'
        stats.lastSuccessAt = Date.now()
      }
    } catch (error) {
      failureStreak += 1
      stats.failures += 1
      stats.lastError = String(error?.message ?? error)
      stats.lastErrorAt = Date.now()
      stats.state = 'error'
      spillQueue()
      if (failureStreak === 1 || failureStreak % 20 === 0) {
        log(`[lx-dsh-peek] archive: delivery failed (${failureStreak}x): ${stats.lastError}`)
      }
      scheduleFlush(backoffMs(failureStreak))
    } finally {
      flushing = false
      if (queue.length > 0) scheduleFlush(flushMs)
    }
  }

  function scheduleFlush(delay) {
    if (flushTimer !== null || stopped) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      void flush()
    }, delay)
    flushTimer.unref?.()
  }

  /**
   * Read one session's whole durable log without activating an Agent.
   *
   * Preferred: `sessionQuery.observeSession()` — the same Host service the
   * Session Controller uses internally. It returns the header plus the complete
   * event prefix for attached and cold sessions alike, so no subagent address or
   * mode has to be guessed. Falls back to `follow` (cursor only) + backward
   * `page` when that service is not composed.
   *
   * @param {string} sessionId
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ header: any, events: any[] }>}
   */
  async function readLog(sessionId, signal) {
    // Resolved lazily through the reflection API: `sessionQuery` is not in the
    // plugin's inject list (requiring it would make the whole peek plugin pending
    // on a differently composed profile) and Cordis throws on a plain property
    // read of an uninjected service.
    const query = resolveSessionQuery()
    if (query !== undefined && query !== null && typeof query.observeSession === 'function') {
      const observation = await query.observeSession(sessionId, {
        ...(signal === undefined ? {} : { signal }),
        projectionMode: 'none',
      })
      try {
        return {
          header: observation?.header ?? { id: sessionId },
          events: Array.isArray(observation?.events) ? observation.events : [],
        }
      } finally {
        try {
          observation?.[Symbol.dispose]?.()
        } catch {
          // lease already released
        }
      }
    }
    return readLogByPage(sessionId, signal)
  }

  /** Read an optional service without declaring it in the plugin's inject list. */
  function resolveSessionQuery() {
    try {
      const service = ctx.get?.('sessionQuery')
      if (service !== undefined && service !== null) return service
    } catch {
      // not composed
    }
    return undefined
  }

  /** Fallback backfill: learn the cursor from a follow opening, then page back. */
  async function readLogByPage(sessionId, signal) {
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const address = { kind: 'session', sessionId }
      const frames = ctx.sessionController.follow({ address, maxMessages: 1 }, controller.signal)
      let snapshot = null
      for await (const frame of frames) {
        if (frame?.type === 'snapshot') snapshot = frame
        break // 拿到 opening 就断流：冷会话因此不会被 promote/激活
      }
      if (snapshot === null) throw new Error('follow returned no snapshot')
      const events = (snapshot.records ?? [])
        .filter((record) => record?.type === 'event')
        .map((record) => record.event)
      let beforeSeq = events.length > 0 ? events[0].seq : undefined
      let pages = 0
      while (!stopped && pages < MAX_PAGES) {
        const page = await ctx.sessionController.page(
          { address, throughSeq: snapshot.cursor, beforeSeq, maxMessages: PAGE_MESSAGES },
          controller.signal,
        )
        const records = Array.isArray(page?.records) ? page.records : []
        for (const record of records) {
          if (record?.type === 'event') events.push(record.event)
        }
        if (page?.hasMore !== true || records.length === 0) break
        const firstSeq = records[0].event?.seq
        if (!Number.isSafeInteger(firstSeq) || firstSeq === beforeSeq) break
        beforeSeq = firstSeq
        pages += 1
      }
      return { header: snapshot.header ?? { id: sessionId }, events }
    } finally {
      controller.abort()
      signal?.removeEventListener('abort', onAbort)
    }
  }

  async function backfillSession(sessionId, signal) {
    const { header, events } = await readLog(sessionId, signal)
    const row = sessionRow(sessionId)
    rememberSession(header ?? { id: sessionId }, row.title ?? '')
    for (const event of events) {
      if (event === null || typeof event !== 'object') continue
      // 文本模式按模式过滤（非对话事件直接丢），完整模式全量重放
      enqueue({ id: sessionId, header: header ?? { id: sessionId } }, event, { force: mode === 'full' })
    }
    const current = sessionRow(sessionId)
    current.backfilled = true
    current.checkedAt = Date.now()
    const highest = events.reduce(
      (top, event) => (Number.isSafeInteger(event?.seq) && event.seq > top ? event.seq : top),
      current.archivedSeq,
    )
    current.archivedSeq = highest
    stats.backfilled += 1
    saveStateSoon()
  }

  /** Enqueue one event using a session header that may be a wire snapshot header. */
  function enqueueFromHeader(header, event, options = {}) {
    enqueue({ id: header.id, header }, event, options)
  }

  /**
   * Mirror ZCode sessions' conversation text. ZCode has no event firehose, so
   * this polls its read-only SQLite: only sessions whose `time_updated` moved
   * are re-read, and each session's messages are ordered by their raw index so
   * already-archived seqs never shift.
   */
  async function pollZcode() {
    if (!zcodeEnabled || stopped) return
    let sessions = []
    try {
      sessions = await zcode.exportSessions()
    } catch (error) {
      stats.lastError = `zcode list: ${String(error?.message ?? error)}`
      stats.lastErrorAt = Date.now()
      return
    }
    for (const session of sessions) {
      if (stopped) return
      const sessionId = `z:${session.id}`
      const row = sessionRow(sessionId)
      if (row.backfilled && session.updatedAt <= row.checkedAt) continue
      try {
        const messages = await zcode.exportMessages(session.id)
        rememberSession(
          { id: sessionId, cwd: session.directory, origin: 'zcode' },
          session.title,
        )
        for (const message of messages) {
          enqueueText(
            sessionId,
            message.seq,
            message.role === 'user' ? 'user/message' : 'assistant/message',
            message.time,
            message.text,
          )
        }
        row.backfilled = true
        row.checkedAt = session.updatedAt
        stats.backfilled += 1
        saveStateSoon()
      } catch (error) {
        stats.lastError = `zcode ${session.id}: ${String(error?.message ?? error)}`
        stats.lastErrorAt = Date.now()
      }
    }
    if (queue.length > 0) await flush()
  }

  async function pollSessions(signal) {
    if (backfilling || stopped) return
    backfilling = true
    try {
      const listed = await ctx.sessionController.list({}, signal)
      const items = Array.isArray(listed?.items) ? listed.items : []
      const now = Date.now()
      for (const summary of items) {
        const id = summary?.sessionId
        if (typeof id !== 'string' || id === '') continue
        const row = sessionRow(id)
        const header = {
          id,
          createdAt: summary.updatedAt,
          cwd: summary.cwd,
          parentSession: summary.parentSessionId,
          origin: summary.origin,
        }
        rememberSession(header, row.title ?? '')
        const stale = !row.backfilled || Number(summary.updatedAt) > row.checkedAt
        if (!stale) continue
        try {
          await backfillSession(id, signal)
        } catch (error) {
          if (stopped || signal?.aborted) return
          row.checkedAt = now
          stats.lastError = `backfill ${id}: ${String(error?.message ?? error)}`
          stats.lastErrorAt = now
          log(`[lx-dsh-peek] archive: ${stats.lastError}`)
        }
        void flush()
      }
    } catch (error) {
      if (!stopped && !signal?.aborted) {
        stats.lastError = `list: ${String(error?.message ?? error)}`
        stats.lastErrorAt = Date.now()
      }
    } finally {
      backfilling = false
    }
  }

  const disposers = []

  function start() {
    if (!enabled) {
      stats.state = 'disabled'
      return
    }
    // The archive must never take the viewer down: any setup failure degrades
    // to "archive off" and keeps the peek page serving.
    try {
      startUnsafe()
    } catch (error) {
      stats.state = 'error'
      stats.lastError = `start: ${String(error?.message ?? error)}`
      log(`[lx-dsh-peek] archive: start failed, viewer unaffected: ${stats.lastError}`)
    }
  }

  function startUnsafe() {
    ensureDirs()
    loadState()
    loadAuthFile()
    if (token === '') {
      stats.state = 'no-token'
      log('[lx-dsh-peek] archive: no token configured — events stay in memory only')
    } else if (lifetime.daysLeft !== null && lifetime.daysLeft <= 0) {
      stats.state = 'token-expired'
      log('[lx-dsh-peek] archive: token already expired — refreshing via login if possible')
    }
    if (username !== '' && readPassword() !== '') {
      // Kick a refresh when the credential is missing/expiring; harmless otherwise.
      void ensureToken().then(() => flush())
    }

    // Live capture: every committed event of every session (subagents included).
    disposers.push(
      ctx.on('session/event', (session, event) => {
        try {
          enqueue(session, event)
        } catch (error) {
          log(`[lx-dsh-peek] archive: enqueue failed: ${String(error?.message ?? error)}`)
        }
      }),
    )
    disposers.push(
      ctx.on('session/created', (session) => {
        try {
          const row = sessionRow(session.id)
          rememberSession(session.header ?? { id: session.id }, row.title ?? '')
          row.backfilled = false
          saveStateSoon()
        } catch {
          // metadata only; the poller retries
        }
      }),
    )

    const pollController = new AbortController()
    disposers.push(() => pollController.abort())
    const poll = () => {
      if (stopped) return
      void pollSessions(pollController.signal)
      void pollZcode()
    }
    // First sweep soon after mount (backfill all stored history), then periodic.
    const initial = setTimeout(poll, 2500)
    initial.unref?.()
    pollTimer = setInterval(poll, pollMs)
    pollTimer.unref?.()
    disposers.push(() => {
      clearTimeout(initial)
      clearInterval(pollTimer)
    })
    scheduleFlush(flushMs)
    stats.state = token === '' ? 'no-token' : 'ok'
  }

  function stop() {
    stopped = true
    if (flushTimer !== null) clearTimeout(flushTimer)
    if (pollTimer !== null) clearInterval(pollTimer)
    if (saveTimer !== null) clearTimeout(saveTimer)
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // best effort on teardown
      }
    }
    spillQueue()
    try {
      ensureDirs()
      writeFileSync(stateFile, JSON.stringify({ version: 1, sessions: state.sessions }))
    } catch {
      // shutting down; nothing else to do
    }
  }

  start()

  return {
    status() {
      let methods = []
      try {
        const target = ctx.sessionController
        const names = new Set()
        for (let proto = target; proto !== null && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
          for (const name of Object.getOwnPropertyNames(proto)) {
            if (name !== 'constructor') names.add(name)
          }
        }
        methods = [...names].sort()
      } catch {
        methods = []
      }
      return {
        enabled,
        mode,
        zcode: { enabled: zcodeEnabled },
        controllerMethods: methods,
        apiBase,
        state: stats.state,
        token: {
          configured: token !== '',
          daysLeft: lifetime.daysLeft === null ? null : Math.round(lifetime.daysLeft * 10) / 10,
          expiresAt: lifetime.expiresAt,
          autoRefresh: username !== '' && readPassword() !== '',
          lastLoginAt,
          lastLoginError,
        },
        queued: queue.length,
        inflight: inflight.size,
        spoolFiles: spoolFiles().length,
        sessionsTracked: Object.keys(state.sessions).length,
        backfilled: stats.backfilled,
        sent: stats.sent,
        batches: stats.batches,
        failures: stats.failures,
        lastError: stats.lastError,
        lastErrorAt: stats.lastErrorAt,
        lastSuccessAt: stats.lastSuccessAt,
      }
    },
    flush: () => flush(),
    poll: () => pollSessions(new AbortController().signal),
    stop,
  }
}

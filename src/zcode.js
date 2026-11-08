/**
 * lx_dsh_peek ZCode source — a read-only adapter over ZCode's session store.
 *
 * ZCode persists every session in `~/.zcode/cli/db/db.sqlite` (WAL mode). This
 * module opens that file read-only with `node:sqlite` (Node ≥ 22.5, which the
 * DSH runtime bundles) and maps its rows onto the same event shapes the peek
 * page already renders for DSH sessions, so the page keeps one transcript
 * model for both sources:
 *
 * - `session.time_updated` fresh (≤ 90 s) or an assistant message without
 *   `time.completed` (its row is written at generation start and marked only
 *   when the turn settles; steps chain immediately, so this covers long quiet
 *   tool runs) means the session is running. An errored turn is the exception:
 *   ZCode records `last_outcome` and freezes every timestamp at the error
 *   instant while leaving the message uncompleted, which reads as finished.
 * - `part` rows of an in-flight assistant message are diffed on each poll into
 *   text/reasoning deltas and tool call/result events.
 * - A watched session leaving the running state emits a live `turn/end`, which
 *   the page turns into the three-phase completion flash.
 *
 * Every failure path returns empty results and logs at most throttled lines:
 * ZCode support must never break the DSH paths.
 */

import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const ZCODE_PREFIX = 'z:'

/** A session whose store was touched this recently counts as running. */
const RUNNING_FRESH_MS = 90_000
/**
 * How long an in-flight turn (or a `running` tool part) may stay silent
 * before it is treated as dead. Measured ZCode turns run for hours, and tool
 * runs go silent for their whole duration, so this is generous on purpose.
 */
const TOUCHED_MAX_MS = 2 * 60 * 60_000
/** Recently finished sessions stay listed for the completion strip. */
const RECENT_KEEP_MS = 30 * 60_000
/** Store poll fallback period while a stream watches ZCode sessions; real wakes come from the stat loop. */
const POLL_MS = 1500
/** Store stat cadence: one cheap syscall; bounds the write-to-poll latency. */
const STAT_POLL_MS = 150
/** Bootstrap reads this many newest messages. */
const BOOTSTRAP_MESSAGES = 60
/** The watcher re-scans this many newest messages per poll. */
const WATCH_TAIL = 8
/** Upper bound of sessions reported in one listing. */
const MAX_ITEMS = 8

export function isZcodeSessionId(value) {
  return typeof value === 'string' && value.startsWith(ZCODE_PREFIX)
}

function safeParse(text) {
  try {
    const value = JSON.parse(text)
    return value !== null && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

function completedOf(messageData) {
  return safeParse(messageData)?.time?.completed !== undefined
}

/** Tool output can be a plain string or a structured value; render both. */
function outputText(state) {
  const output = state?.output
  if (typeof output === 'string') return output
  if (output === undefined || output === null) return ''
  try { return JSON.stringify(output, null, 2) } catch { return String(output) }
}

/**
 * Create the ZCode source. Lazy: nothing touches the filesystem until the
 * first list/bootstrap/watch call, and a missing `node:sqlite` or database
 * disables the source instead of throwing.
 */
export function createZcodeSource({ enabled = true, dbPath, log = () => {} } = {}) {
  const file = typeof dbPath === 'string' && dbPath.trim() !== ''
    ? dbPath
    : join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite')
  let moduleMissing = false
  let loaded = false
  let DatabaseSync = null
  let database = null
  let closed = false
  /** Sessions whose watched turn began after the recorded outcome: quiet
   * phases of those turns must never be settled by the stale outcome. */
  const postOutcomeSessions = new Set()
  let lastLoggedError = ''
  let lastErrorLogAt = 0

  function logError(message) {
    const now = Date.now()
    if (message === lastLoggedError && now - lastErrorLogAt < 60_000) return
    lastLoggedError = message
    lastErrorLogAt = now
    log(message)
  }

  function closeDb() {
    if (database === null) return
    try { database.close() } catch { /* already gone */ }
    database = null
  }

  async function connect() {
    if (closed || moduleMissing) return null
    if (database !== null) return database
    if (!loaded) {
      try {
        ({ DatabaseSync } = await import('node:sqlite'))
        loaded = true
      } catch {
        moduleMissing = true
        log('node:sqlite is unavailable (Node < 22.5) — ZCode support disabled')
        return null
      }
    }
    try {
      database = new DatabaseSync(file, { readOnly: true })
    } catch {
      // A crashed writer can leave a WAL that read-only mode cannot recover;
      // a normal open recovers it and still only reads through SQL.
      try {
        database = new DatabaseSync(file)
      } catch (error) {
        logError(`cannot open ${file}: ${error?.message ?? error}`)
        return null
      }
    }
    return database
  }

  /** Run one read query; any failure drops the handle and returns no rows. */
  async function query(sql, ...params) {
    const db = await connect()
    if (db === null) return []
    try {
      return db.prepare(sql).all(...params)
    } catch (error) {
      closeDb()
      logError(`zcode read failed: ${error?.message ?? error}`)
      return []
    }
  }

  async function queryRow(sql, ...params) {
    const rows = await query(sql, ...params)
    return rows.length > 0 ? rows[0] : undefined
  }

  /**
   * Running state of one session row, from measured ZCode store invariants:
   *
   * - Writes within the fresh window mean live streaming (parts update every
   *   ~10 s on average while a turn generates).
   * - An assistant message without `time.completed` is an in-flight turn,
   *   however old: the row is written at generation start and marked only
   *   when the turn settles, and mid-turn silences are real — long tool runs
   *   go quiet for their whole duration (Bash alone defaults to a 5 min
   *   timeout) and measured turns run up to hours.
   * - A tool part still marked `status: 'running'` is the store's own
   *   signature of a quiet command in flight; without it a multi-minute tool
   *   run is indistinguishable from silence.
   * - `last_outcome` is NOT a liveness authority: it stays from the previous
   *   turn while the next one runs (verified live). It only settles the
   *   session when the store has been quiet since — an errored turn leaves
   *   its message uncompleted with the outcome written and nothing after.
   *   The watcher's `postOutcome` memory (a user message observed arriving
   *   after the outcome) overrides this, covering generation stalls under
   *   active watch.
   */
  async function runningState(session, now, { postOutcome = false } = {}) {
    if (session.time_archived !== null || session.time_deleted !== null) return { running: false }
    const updated = Number(session.time_updated) || 0
    const fresh = now - updated < RUNNING_FRESH_MS
    if (fresh) return { running: true }
    const runningTool = await queryRow(
      `SELECT time_updated FROM part
       WHERE session_id = ? AND json_extract(data, '$.type') = 'tool'
         AND json_extract(data, '$.state.status') = 'running'
       ORDER BY time_updated DESC LIMIT 1`,
      session.id,
    )
    if (runningTool !== undefined && now - (Number(runningTool.time_updated) || 0) < TOUCHED_MAX_MS) {
      return { running: true }
    }
    const last = await queryRow(
      `SELECT data, time_created, time_updated FROM message
       WHERE session_id = ? AND json_extract(data, '$.role') = 'assistant'
       ORDER BY time_created DESC LIMIT 1`,
      session.id,
    )
    if (last !== undefined && !completedOf(last.data)) {
      const touched = Math.max(Number(last.time_updated) || 0, updated)
      const outcomeSettled = session.last_outcome !== null && now - updated >= RUNNING_FRESH_MS
      if ((!outcomeSettled || postOutcome) && now - touched < TOUCHED_MAX_MS) return { running: true }
    }
    // The turn was accepted but generation has not started: the newest row is
    // still the user's own message (model scheduling can easily sit out
    // minutes). Without this the pane dies ~90 s into the queue wait and only
    // revives at the first token — the observed "two minutes of nothing, then
    // the text arrives". Model-only rows (silent-turn reminders, interrupt
    // markers) are engine bookkeeping, not the user speaking, and must not
    // hold a settled turn open. An `error` outcome on record means the last
    // attempt died right after the message — settled, not queued.
    const newest = await queryRow(
      `SELECT data, time_created FROM message
       WHERE session_id = ? AND json_extract(data, '$.metadata.visibility') IS NULL
       ORDER BY time_created DESC LIMIT 1`,
      session.id,
    )
    if (newest !== undefined
      && safeParse(newest.data).role === 'user'
      && session.last_outcome !== 'error'
      && now - (Number(newest.time_created) || 0) < TOUCHED_MAX_MS) {
      return { running: true }
    }
    return { running: false }
  }

  async function sessionRow(rawId) {
    return queryRow(
      `SELECT id, title, directory, time_updated, last_outcome, time_archived, time_deleted
       FROM session WHERE id = ?`,
      rawId,
    )
  }

  function publicSession(session, extra) {
    return {
      sessionId: `${ZCODE_PREFIX}${session.id}`,
      title: session.title || session.id,
      cwd: session.directory || '',
      running: false,
      updatedAt: Number(session.time_updated) || 0,
      source: 'zcode',
      ...extra,
    }
  }

  /**
   * List running ZCode sessions plus recently finished ones. The running flag
   * drives pane creation on the page; `outcome`/`finishedAt` drive the
   * completion strip so a missed flash still answers "完成了没有".
   */
  async function list() {
    if (!enabled || closed) return []
    const now = Date.now()
    const rows = await query(
      `SELECT id, title, directory, time_updated, last_outcome, time_archived, time_deleted
       FROM session
       WHERE time_updated > ?
       ORDER BY time_updated DESC
       LIMIT 64`,
      now - Math.max(TOUCHED_MAX_MS, RECENT_KEEP_MS) - RUNNING_FRESH_MS,
    )
    const items = []
    for (const row of rows) {
      if (items.length >= MAX_ITEMS) break
      const state = await runningState(row, now, { postOutcome: postOutcomeSessions.has(row.id) })
      if (state.running) items.push(publicSession(row, { running: true }))
      else if (row.last_outcome && now - (Number(row.time_updated) || 0) < RECENT_KEEP_MS) {
        items.push(publicSession(row, { running: false, outcome: String(row.last_outcome), finishedAt: Number(row.time_updated) || 0 }))
      }
    }
    return items
  }

  async function messageParts(messageId) {
    return query(
      `SELECT id, data, time_created, time_updated FROM part
       WHERE message_id = ? ORDER BY coalesce(sequence, time_created), id`,
      messageId,
    )
  }

  function contentBlocks(parts) {
    const content = []
    for (const part of parts) {
      const data = safeParse(part.data)
      if ((data.type === 'text' || data.type === 'reasoning') && typeof data.text === 'string' && data.text !== '') {
        content.push({ type: data.type, text: data.text })
      }
    }
    return content
  }

  function toolCallEvent(part, data, fallbackTime) {
    return {
      type: 'tool/call',
      time: Number(part.time_created) || fallbackTime,
      data: { callId: data.callID ?? part.id, name: data.tool || 'tool', arguments: data.state?.input ?? '' },
    }
  }

  function toolResultEvent(part, data, fallbackTime) {
    const state = data.state ?? {}
    const isError = state.status === 'error'
    return {
      type: 'tool/result',
      time: Number(part.time_updated) || fallbackTime,
      data: {
        error: isError,
        message: {
          content: [{
            toolCallId: data.callID ?? part.id,
            isError,
            content: [{ type: 'text', text: outputText(state) }],
          }],
        },
      },
    }
  }

  /**
   * Build the snapshot records for one session the same way the DSH follow
   * snapshot does: an array of `{ type: 'event', event }` records. The caller
   * applies `fitSnapshot` for byte budgeting. The in-flight assistant
   * message's text is deliberately left out — the watcher streams it as live
   * deltas right after attach, which also gives a mid-turn reconnect the
   * streaming cursor instead of a pasted paragraph.
   */
  async function bootstrap(rawId) {
    if (!enabled || closed) return []
    const session = await sessionRow(rawId)
    if (session === undefined) return []
    const messages = await query(
      `SELECT id, data, time_created FROM message
       WHERE session_id = ? ORDER BY time_created DESC LIMIT ?`,
      rawId, BOOTSTRAP_MESSAGES,
    )
    const records = []
    for (const message of messages.reverse()) {
      const data = safeParse(message.data)
      const time = Number(message.time_created) || 0
      const parts = await messageParts(message.id)
      if (data.role === 'user') {
        if (data.metadata?.visibility === 'model-only') continue
        const text = contentBlocks(parts).filter((block) => block.type === 'text').map((block) => block.text).join('\n')
        if (text.trim() === '') continue
        records.push({ type: 'event', event: { type: 'user/message', time, data: { content: [{ type: 'text', text }] } } })
        continue
      }
      if (data.role !== 'assistant') continue
      // An in-flight message's text and reasoning are intentionally absent:
      // the watcher streams them as live deltas right after attach, so putting
      // them in the snapshot would render the same words twice on the page.
      const inflight = !completedOf(message.data)
      const content = inflight ? [] : contentBlocks(parts)
      let emitted = false
      const emitMessage = () => {
        if (emitted || content.length === 0) return
        emitted = true
        records.push({ type: 'event', event: { type: 'assistant/message', time, data: { message: { content } } } })
      }
      for (const part of parts) {
        const partData = safeParse(part.data)
        if (partData.type === 'text' || partData.type === 'reasoning') emitMessage()
        else if (partData.type === 'tool') {
          records.push({ type: 'event', event: toolCallEvent(part, partData, time) })
          const status = partData.state?.status
          if (status === 'completed' || status === 'error') {
            records.push({ type: 'event', event: toolResultEvent(part, partData, time) })
          }
        }
      }
      emitMessage()
    }
    // Synthesize the running turn's start so the pane shows its real elapsed
    // time; historical turn starts are not replayed.
    if ((await runningState(session, Date.now())).running) {
      records.push({ type: 'event', event: { type: 'turn/start', time: Number(session.time_updated) || Date.now(), data: {} } })
    }
    return records
  }

  /**
   * Watch one or more ZCode sessions until `signal` aborts, emitting the same
   * frames the DSH follow path emits: `event`, `delta`, and on completion the
   * live `turn/end` (the caller adds the flash frame).
   *
   * Polling is change-driven: the wait loop stats the store files and returns
   * as soon as one changed, so a ZCode commit reaches the page in ~150 ms
   * instead of a fixed second-and-a-half. A `PRAGMA data_version` check makes
   * content sync skip cycles where nothing was written; running-state
   * transitions are checked on every cycle either way.
   *
   * The first poll seeds silently — the page gets its history from this same
   * stream's snapshot frame — except for the in-flight message, whose text is
   * streamed from zero on purpose (see `bootstrap`).
   */
  async function watch(rawIds, emit, signal) {
    const states = new Map()
    for (const rawId of rawIds) states.set(rawId, { seeded: false, wasRunning: false, msgs: new Map(), parts: new Map() })
    let lastDataVersion = null
    let fingerprint = await storeFingerprint()
    while (!signal.aborted && !closed) {
      const version = await dataVersion()
      // A null version (no store, read failure) polls anyway: correctness
      // before thrift.
      const contentDirty = version === null || lastDataVersion === null || version !== lastDataVersion
      lastDataVersion = version
      for (const [rawId, state] of states) {
        if (signal.aborted || closed) break
        try {
          await pollSession(rawId, state, emit, contentDirty)
        } catch (error) {
          logError(`zcode watch failed: ${error?.message ?? error}`)
        }
      }
      fingerprint = await waitUntilStoreChanges(signal, fingerprint, POLL_MS)
    }
  }

  function sleep(ms, signal) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
    })
  }

  // ── Store change detection ─────────────────────────────────────────────────
  // ZCode has no subscribable event API (its only external IPC is a lifecycle
  // control socket; the realtime port is in-process for multi-host mirroring),
  // so the watcher detects store writes itself. fs.watch cannot carry it: on
  // macOS a kqueue directory watch fires for entry creation/removal but not
  // for SQLite's pwrite appends into an existing WAL, so steady-state
  // streaming would never wake it. Instead the wait loop stats the store
  // files every ~150 ms — one cheap syscall — and a mtime/size change wakes
  // the poll; a `PRAGMA data_version` check stays as the second opinion for
  // writes a same-millisecond, same-size stat could miss.
  const STORE_SUFFIXES = ['', '-wal', '-journal', '-shm']

  async function storeFingerprint() {
    const parts = []
    for (const suffix of STORE_SUFFIXES) {
      try {
        const stats = await stat(file + suffix)
        parts.push(`${stats.mtimeMs}:${stats.size}`)
      } catch {
        parts.push('-')
      }
    }
    return parts.join('|')
  }

  /** Stat-wait until a store file changed, the fallback fires, or abort. */
  async function waitUntilStoreChanges(signal, known, fallbackMs) {
    const deadline = Date.now() + fallbackMs
    while (!signal.aborted && !closed) {
      const current = await storeFingerprint()
      if (current !== known) return current
      if (Date.now() >= deadline) return known
      await sleep(STAT_POLL_MS, signal)
    }
    return known
  }

  /** Cheap liveness check: advances whenever another connection commits. */
  async function dataVersion() {
    const db = await connect()
    if (db === null) return null
    try {
      const row = db.prepare('PRAGMA data_version').get()
      return Number(row?.data_version) || null
    } catch {
      return null
    }
  }

  async function pollSession(rawId, state, emit, contentDirty) {
    const now = Date.now()
    const session = await sessionRow(rawId)
    if (session === undefined) {
      // The stream layer turns a live turn/end into the completion flash.
      if (state.wasRunning) {
        state.wasRunning = false
        emit(rawId, { t: 'event', event: { type: 'turn/end', time: now, data: {} } })
      }
      postOutcomeSessions.delete(rawId)
      return
    }
    const live = await runningState(session, now, { postOutcome: postOutcomeSessions.has(rawId) })
    const first = state.seeded !== true
    state.seeded = true
    if (first) {
      // The page gets history from this same stream: bootstrap records open
      // the watch, so snapshot truth and live tracking share one ordered
      // sequence and a reconnect just reseeds.
      emit(rawId, { t: 'snapshot', records: await bootstrap(rawId) })
    }
    if (!first && live.running && !state.wasRunning) {
      state.wasRunning = true
      emit(rawId, { t: 'event', event: { type: 'turn/start', time: now, data: {} } })
    }
    const wasRunning = state.wasRunning
    // Content is synced on every dirty poll of a running turn — and on the
    // poll that notices completion, so the final assistant message lands
    // before the turn/end that destroys the pane. Clean cycles (no writes
    // anywhere in the store) only recheck running-state transitions.
    if ((live.running || wasRunning) && (contentDirty || first)) {
      const tail = (await query(
        `SELECT id, data, time_created, time_updated FROM message
         WHERE session_id = ? ORDER BY time_created DESC LIMIT ?`,
        rawId, WATCH_TAIL,
      )).reverse()
      // The newest uncompleted assistant message is the one whose text streams.
      let inflightId = null
      for (const message of tail) {
        if (safeParse(message.data).role === 'assistant' && !completedOf(message.data)) inflightId = message.id
      }
      for (const message of tail) {
        const data = safeParse(message.data)
        const completed = completedOf(message.data)
        const known = state.msgs.get(message.id)
        if (known === undefined) {
          state.msgs.set(message.id, { role: data.role, completed })
          // On the seed poll the page already has this transcript from bootstrap.
          if (!first) await emitNewMessage(rawId, emit, message, data)
          // A user message arriving while an outcome is on record starts a
          // turn that postdates that outcome: remember it, so quiet phases of
          // this turn are never settled by the stale outcome. Cleared when the
          // turn's message completes or the turn ends.
          if (data.role === 'user' && session.last_outcome !== null) postOutcomeSessions.add(rawId)
        } else if (data.role === 'assistant' && known.completed === false && completed === true) {
          known.completed = true
          await emitAssistantFinal(rawId, emit, message)
        }
      }
      await emitToolTransitions(rawId, emit, tail, state, first ? (inflightId ?? null) : undefined)
      if (inflightId !== null) await emitInflightParts(rawId, emit, inflightId, state)
      else postOutcomeSessions.delete(rawId)
    }
    if (!first && !live.running && wasRunning) {
      // Two consecutive not-running polls before destroying the pane: one
      // misread must never flash "finished" over a live turn.
      state.notRunningStreak = (state.notRunningStreak ?? 0) + 1
      if (state.notRunningStreak >= 2) {
        state.wasRunning = false
        state.notRunningStreak = 0
        postOutcomeSessions.delete(rawId)
        emit(rawId, { t: 'event', event: { type: 'turn/end', time: now, data: {} } })
        return
      }
    } else {
      state.notRunningStreak = 0
    }
    // Inside the hysteresis window the turn still counts as running, so a
    // recovery on the next poll never produces a spurious turn/start.
    state.wasRunning = live.running || (state.notRunningStreak ?? 0) >= 1
  }

  async function emitNewMessage(rawId, emit, message, data) {
    if (data.role === 'user') {
      if (data.metadata?.visibility === 'model-only') return
      const parts = await messageParts(message.id)
      const text = contentBlocks(parts).filter((block) => block.type === 'text').map((block) => block.text).join('\n')
      if (text.trim() === '') return
      emit(rawId, { t: 'event', event: { type: 'user/message', time: Number(message.time_created) || Date.now(), data: { content: [{ type: 'text', text }] } } })
      return
    }
    if (data.role === 'assistant' && completedOf(message.data)) {
      await emitAssistantFinal(rawId, emit, message)
    }
  }

  async function emitAssistantFinal(rawId, emit, message) {
    const parts = await messageParts(message.id)
    const content = contentBlocks(parts)
    if (content.length === 0) return
    emit(rawId, {
      t: 'event',
      event: { type: 'assistant/message', time: Number(message.time_created) || Date.now(), data: { message: { content } } },
    })
  }

  /**
   * Diff the in-flight message's text/reasoning parts into deltas. Completed
   * messages never stream: their final `assistant/message` event carries the
   * whole text and the page swaps out the live item.
   */
  async function emitInflightParts(rawId, emit, messageId, state) {
    const parts = await messageParts(messageId)
    for (const part of parts) {
      const data = safeParse(part.data)
      if (data.type !== 'text' && data.type !== 'reasoning') continue
      const text = typeof data.text === 'string' ? data.text : ''
      const tracked = state.parts.get(part.id) ?? { textLen: 0, reasonLen: 0, inputJson: '', resultEmitted: false }
      const key = data.type === 'text' ? 'textLen' : 'reasonLen'
      if (text.length > tracked[key]) {
        emit(rawId, {
          t: 'delta',
          frame: { type: 'chunk', chunk: { type: data.type === 'text' ? 'text-delta' : 'reasoning-delta', text: text.slice(tracked[key]) } },
        })
      }
      tracked[key] = text.length
      state.parts.set(part.id, tracked)
    }
  }

  /**
   * Emit tool calls and results for every tail message. Calls repeat when the
   * streamed input grows — the page updates its existing item by callId. On
   * the seed poll every tail part is recorded (bootstrap already emitted the
   * completed ones into the snapshot), but only the in-flight message's parts
   * are surfaced as live frames.
   */
  async function emitToolTransitions(rawId, emit, tail, state, seedMessageId) {
    if (tail.length === 0) return
    const placeholders = tail.map(() => '?').join(', ')
    const parts = await query(
      `SELECT id, message_id, data, time_created, time_updated FROM part
       WHERE message_id IN (${placeholders}) ORDER BY coalesce(sequence, time_created), id`,
      ...tail.map((message) => message.id),
    )
    for (const part of parts) {
      const emitThis = seedMessageId === undefined || part.message_id === seedMessageId
      const data = safeParse(part.data)
      if (data.type !== 'tool') continue
      const status = data.state?.status
      const done = status === 'completed' || status === 'error'
      const tracked = state.parts.get(part.id) ?? { textLen: 0, reasonLen: 0, inputJson: '', resultEmitted: false }
      const inputJson = JSON.stringify(data.state?.input ?? null)
      if (emitThis && tracked.inputJson !== inputJson && !(done && tracked.resultEmitted)) {
        emit(rawId, { t: 'event', event: toolCallEvent(part, data, Number(part.time_created) || Date.now()) })
      }
      if (done && !tracked.resultEmitted) {
        tracked.resultEmitted = true
        if (emitThis) {
          emit(rawId, { t: 'event', event: toolResultEvent(part, data, Number(part.time_updated) || Date.now()) })
        }
      }
      tracked.inputJson = inputJson
      state.parts.set(part.id, tracked)
    }
  }

  function dispose() {
    closed = true
    closeDb()
  }

  return { list, bootstrap, watch, dispose, runningState, sessionRow }
}

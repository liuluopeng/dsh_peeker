import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { apply } from '../src/index.js'

const port = 32000 + (process.pid % 1000)
const base = `http://127.0.0.1:${port}`
let dispose = () => {}

const sessions = [
  {
    sessionId: 'session-test',
    cwd: '/tmp/demo',
    updatedAt: Date.now(),
    running: true,
    projections: { values: { 'session/title': 'Test task' } },
  },
  {
    sessionId: 'session-subagent',
    parentSessionId: 'session-test',
    origin: 'subagent',
    cwd: '/tmp/demo',
    updatedAt: Date.now() - 1000,
    running: true,
    projections: { values: { 'session/title': 'Subagent task' } },
  },
  {
    sessionId: 'session-bulk',
    cwd: '/tmp/demo',
    updatedAt: Date.now() - 2000,
    running: true,
    projections: { values: { 'session/title': 'Bulk task' } },
  },
]

const jobStartedAt = Date.now()
const job = {
  id: 'bash-test',
  kind: 'bash',
  label: 'npm test',
  owner: 'session-test',
  status: 'running',
  startedAt: jobStartedAt,
  output: { total: 0, earliest: 0 },
}
const jobController = {
  async *list(_request, signal) {
    yield { type: 'rows', jobs: [job] }
    await new Promise((resolve) => {
      if (signal.aborted) resolve()
      else signal.addEventListener('abort', resolve, { once: true })
    })
  },
  async *follow(_request, signal) {
    yield { type: 'opened', job, from: 0 }
    yield { type: 'output', chunks: [{ at: 0, text: 'live output\n', channel: 'stdout' }], next: 12 }
    await new Promise((resolve) => {
      if (signal.aborted) resolve()
      else signal.addEventListener('abort', resolve, { once: true })
    })
  },
}

const listeners = []
const followAddresses = []
const ctx = {
  get(name) {
    return name === 'jobController' ? jobController : undefined
  },
  on(event, listener) {
    listeners.push({ event, listener })
    return () => {
      const index = listeners.findIndex((entry) => entry.listener === listener)
      if (index >= 0) listeners.splice(index, 1)
    }
  },
  effect(fn) {
    dispose = fn()
    return dispose
  },
  sessionController: {
    async list() {
      return { items: sessions }
    },
    async *follow(request, signal) {
      followAddresses.push(request.address)
      const id = request.address.kind === 'session' ? request.address.sessionId : request.address.childSessionId
      if (id === 'session-bulk') {
        yield {
          type: 'snapshot',
          cursor: 25,
          records: Array.from({ length: 25 }, (_, index) => ({
            type: 'event',
            event: { type: 'user/message', seq: index + 1, time: Date.now(), data: { content: [{ type: 'text', text: `m${index}` }] } },
          })),
        }
        await new Promise((resolve) => {
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', resolve, { once: true })
        })
        return
      }
      yield {
        type: 'snapshot',
        records: [
          {
            type: 'event',
            event: {
              type: 'user/message',
              seq: 1,
              time: Date.now(),
              data: { content: [{ type: 'text', text: `hello ${id}` }] },
            },
          },
        ],
        assistantStream: {
          revision: 1,
          activeAttempt: {
            attemptId: 'attempt-test',
            startedAfterSeq: 0,
            turn: 1,
            step: 1,
            nextIndex: 1,
            stream: [{ time: Date.now(), chunk: { type: 'text-delta', text: 'partial-test' } }],
          },
        },
      }
      await sleep(20)
      if (signal.aborted) return
      yield { type: 'event', event: { type: 'turn/start', seq: 2, time: Date.now(), data: {} } }
      yield { type: 'assistant-stream', frame: { type: 'start' } }
      yield { type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'hi' } } }
      yield { type: 'assistant-stream', frame: { type: 'end' } }
      yield {
        type: 'event',
        event: {
          type: 'assistant/message',
          seq: 3,
          time: Date.now(),
          data: { message: { content: [{ type: 'text', text: 'hi' }] } },
        },
      }
      await sleep(20)
      if (signal.aborted) return
      yield { type: 'event', event: { type: 'turn/end', seq: 4, time: Date.now(), data: {} } }
      await new Promise((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', resolve, { once: true })
      })
    },
  },
}

before(async () => {
  // ZCode support is exercised by tests/zcode.test.mjs with its own store;
  // here it stays off so the DSH session list is exactly the mock's two rows.
  apply(ctx, { port, zcode: false })
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/health`)
      if (response.ok) return
    } catch {
      // The listener is still starting.
    }
    await sleep(100)
  }
  throw new Error('lx_dsh_peek did not start')
})

after(() => {
  dispose()
})

test('serves the light single-page peek UI', async () => {
  const response = await fetch(`${base}/`)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /text\/html/)
  const body = await response.text()
  assert.match(body, /LX <span>DSH<\/span> Peek/)
  assert.match(body, /id="orientation"/)
  assert.match(body, /MAX_PANES = 4/)
  assert.match(body, /reasoning-text/)
  assert.match(body, /job-output/)
  assert.match(body, /openSharedStream/)
  assert.match(body, /dispatchFrame/)
  assert.doesNotMatch(body, /nearBottom/)
  assert.match(body, /pane\.body\.scrollTop = pane\.body\.scrollHeight/)
  assert.doesNotMatch(body, /任务结束/)
  assert.doesNotMatch(body, /id="toast"/)
  assert.doesNotMatch(body, /KEEP_COMPLETED_MS/)
  assert.match(body, /touch-action: none/)
  assert.match(body, /pointer-events: none/)
  assert.match(body, /scrollbar-width: none/)
  assert.doesNotMatch(body, /<details/)
  assert.doesNotMatch(body, /overflow: auto/)
  assert.doesNotMatch(body, /pointerdown/)
  assert.match(body, /applyEvent\(pane, record\.event, true\)/)
  assert.match(body, /parentSessionId/)
  assert.match(body, /ensureStreamFresh/)
  assert.match(body, /lastStreamAt/)
  assert.match(body, /appendLiveText/)
  assert.match(body, /appendLiveReasoning/)
  assert.match(body, /hydrateAssistantStream/)
  assert.match(body, /handleToolCallDelta/)
  assert.match(body, /tool-call-delta/)
  assert.match(body, /MAX_RENDER_ITEMS/)
  assert.match(body, /reopenedEmpty/)
  assert.match(body, /terminalItemText/)
  assert.match(body, /appendTerm/)
  assert.match(body, /URLSearchParams\(location\.search\)/)
  assert.match(body, /startWakeVideo/)
  assert.match(body, /id="wake"/)
  assert.match(body, /视频常亮/)
  assert.match(body, /scrollBody\(pane\)/)
  assert.match(body, /flashTimer/)
  assert.match(body, /#fff/)
  assert.doesNotMatch(body, /#ffe066/)
  assert.doesNotMatch(body, /flashEl\.animate/)
  assert.match(body, /font: 15px/)
  // ZCode panes share the page: source-aware labels and the recently-finished strip.
  assert.match(body, /pane\.zcode === true \? 'ZCODE' : 'DSH'/)
  assert.match(body, /renderRecent/)
  assert.match(body, /id="recent"/)
  assert.match(body, /在 DSH 或 ZCode 里开始任务/)
  // dsh-Go-parity ordering discipline: snapshot-first chunks, dense seq gating,
  // per-attempt drafts committed by rowKey, and trim that keeps running tools.
  assert.match(body, /gateEvent/)
  assert.match(body, /pane\.lastSeq/)
  assert.match(body, /pane\.resyncing/)
  assert.match(body, /attemptId/)
  assert.match(body, /draft\.commitSeq/)
  assert.match(body, /draft\.turn === turn && draft\.step === step/)
  assert.match(body, /pendingSnapshot/)
  assert.match(body, /done !== true\) from -= 1/)
})

test('injects the official UI font, taller composer, and conversation-width overrides', () => {
  const table = []
  for (const entry of listeners) {
    if (entry.event === 'webserver/index-inject') entry.listener(table)
  }
  assert.equal(table.length, 2)
  const style = table.find((row) => row.kind === 'style')
  assert.ok(style, 'the stylesheet row is injected')
  const settings = table.find((row) => row.kind === 'global')
  assert.ok(settings, 'the client settings row is injected')
  assert.equal(settings.name, '__lxDshPeekUi')
  assert.deepEqual(settings.value, { expandReasoning: 'all', autoTerminal: 'open' })
  assert.match(style.text, /--dsh-content-font-size: 34px !important/)
  assert.match(style.text, /--dsh-code-font-size: 24px !important/)
  assert.match(style.text, /--dsh-terminal-font-size: 24px !important/)
  assert.match(style.text, /--dsh-chat-user-width: 10000px/)
  assert.match(style.text, /\[data-conversation-content\] \{\s*--dsh-chat-content-width: 10000px !important/)
  assert.match(style.text, /--dsh-composer-card-max-width: 10032px !important/)
  assert.match(style.text, /\[data-width-handle\] \{\s*display: none !important/)
  assert.match(style.text, /\[data-composer-input="true"\] \{\s*min-height: 200px !important/)
  assert.match(style.text, /--dsh-composer-text-max-height: 360px !important/)
})

test('rejects an invalid composer height', () => {
  assert.throws(() => apply({}, { port, composerHeight: 40 }), /composerHeight/)
  assert.throws(() => apply({}, { port, composerHeight: 601 }), /composerHeight/)
  assert.throws(() => apply({}, { port, composerHeight: 1.5 }), /composerHeight/)
})

test('rejects an invalid auto-terminal mode', () => {
  assert.throws(() => apply({}, { port, autoTerminal: 'always' }), /autoTerminal/)
  assert.throws(() => apply({}, { port, autoTerminal: 1 }), /autoTerminal/)
})

test('rejects an invalid reasoning expansion mode', () => {
  assert.throws(() => apply({}, { port, expandReasoning: 'sometimes' }), /expandReasoning/)
  assert.throws(() => apply({}, { port, expandReasoning: true }), /expandReasoning/)
})

test('rejects an invalid conversation width', () => {
  // Validation runs before the listener is mounted, so an empty context is enough.
  assert.throws(() => apply({}, { port, contentWidth: 100 }), /contentWidth/)
  assert.throws(() => apply({}, { port, contentWidth: 1.5 }), /contentWidth/)
  assert.throws(() => apply({}, { port, contentWidth: 2401 }), /contentWidth/)
  assert.throws(() => apply({}, { port, contentWidth: 'max' }), /contentWidth/)
})

test('contentWidth 0 keeps the official width and drag handles', () => {
  const injected = []
  const disposers = []
  const fake = {
    get() {
      return undefined
    },
    on(event, listener) {
      if (event === 'webserver/index-inject') injected.push(listener)
      return () => {}
    },
    effect(fn) {
      const off = fn()
      disposers.push(off)
      return off
    },
  }
  try {
    apply(fake, { port: port + 1, contentWidth: 0 })
    const table = []
    for (const listener of injected) listener(table)
    const style = table.find((row) => row.kind === 'style')
    assert.ok(style)
    assert.match(style.text, /--dsh-content-font-size: 34px !important/)
    assert.doesNotMatch(style.text, /--dsh-chat-content-width/)
    assert.doesNotMatch(style.text, /data-width-handle/)
  } finally {
    for (const off of disposers.reverse()) off()
  }
})

test('lists sessions and refuses writes', async () => {
  const response = await fetch(`${base}/api/sessions`)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('connection'), 'close')
  const body = await response.json()
  assert.equal(body.items.length, 3)
  assert.equal(body.items[0].title, 'Test task')
  assert.equal(body.items[0].running, true)
  const subagent = body.items.find((item) => item.sessionId === 'session-subagent')
  assert.ok(subagent)
  assert.equal(subagent.parentSessionId, 'session-test')

  const write = await fetch(`${base}/api/sessions`, { method: 'POST' })
  assert.equal(write.status, 405)
  assert.deepEqual(await write.json(), { error: 'read-only' })
})

test('reports a goal Session as active while its agent idles between rounds', async () => {
  const now = Date.now()
  const goalSession = {
    sessionId: 'session-goal',
    cwd: '/tmp/demo',
    updatedAt: now - 500,
    // The round driver waits between rounds, so the agent itself is idle here.
    running: false,
    projections: {
      values: {
        'session/title': 'Goal task',
        goal: {
          goal: {
            id: 'goal-1', revision: 1, objective: '逐步把 macOS ObjC 层迁移到 Swift',
            phase: 'active', maxGoalRounds: 40,
          },
          roundsStarted: 3,
          createdAt: now - 3_600_000,
          updatedAt: now - 500,
        },
      },
    },
  }
  sessions.push(goalSession)
  try {
    const body = await (await fetch(`${base}/api/sessions`)).json()
    const goal = body.items.find((item) => item.sessionId === 'session-goal')
    assert.ok(goal, 'the goal Session is listed')
    assert.equal(goal.running, false, 'the agent is idle between rounds')
    assert.equal(goal.goalActive, true, 'the durable goal keeps the task active')
    assert.equal(goal.goal.phase, 'active')
    assert.equal(goal.goal.roundsStarted, 3)
    assert.equal(goal.goal.maxGoalRounds, 40)
    assert.match(goal.goal.objective, /Swift/)
    const plain = body.items.find((item) => item.sessionId === 'session-bulk')
    assert.equal(plain.goalActive, false, 'a Session without a goal is not goal-active')
    assert.equal(plain.goal, undefined)
  } finally {
    sessions.splice(sessions.indexOf(goalSession), 1)
  }
})

test('serves the initial transcript over plain HTTP bootstrap', async () => {
  const response = await fetch(`${base}/api/bootstrap?sessionId=session-test`)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /application\/json/)
  const body = await response.json()
  assert.equal(body.dropped, 0)
  assert.match(JSON.stringify(body.records), /hello session-test/)
  assert.equal(body.assistantStream.activeAttempt.stream[0].chunk.text, 'partial-test')
})

test('streams the snapshot first, then live deltas and the completion flash', async () => {
  const controller = new AbortController()
  try {
    const response = await fetch(`${base}/api/stream?sessionId=session-test`, { signal: controller.signal })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('connection'), 'keep-alive')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let body = ''
    while (!body.includes('"t":"flash"')) {
      const { value, done } = await reader.read()
      if (done) break
      body += decoder.decode(value, { stream: true })
    }
    assert.match(body, /"t":"ready"/)
    // The follow snapshot opens the stream: history truth and live events
    // share one ordered connection, so a reconnect resyncs deterministically.
    assert.match(body, /"t":"snapshot"/)
    assert.match(body, /hello session-test/)
    assert.match(body, /"final":true/)
    assert.match(body, /partial-test/)
    assert.match(body, /"t":"delta"/)
    assert.match(body, /"t":"jobs"/)
    assert.match(body, /"t":"job-output"/)
    assert.match(body, /"t":"flash"/)
    // Durable events pass through with their dense seq for the page's gating.
    assert.match(body, /"seq":2/)
    assert.match(body, /"seq":3/)
    assert.doesNotMatch(body, /"sessionId"/)
  } finally {
    controller.abort()
  }
})

test('splits a large snapshot into ordered final:false chunks plus a final one', async () => {
  const controller = new AbortController()
  try {
    const response = await fetch(`${base}/api/stream?sessionId=session-bulk`, { signal: controller.signal })
    assert.equal(response.status, 200)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let body = ''
    // One sequential pump; racing reader.read() against a timeout would
    // abandon pending reads and silently swallow queued chunks.
    const pump = (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          body += decoder.decode(value, { stream: true })
        }
      } catch { /* aborted at the end of the test */ }
    })()
    const deadline = Date.now() + 8000
    while (Date.now() < deadline && !body.includes('"final":true')) await sleep(100)
    void pump
    const frames = body.split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => {
        try { return JSON.parse(line.slice(6)) } catch { return null }
      })
      .filter((frame) => frame?.t === 'snapshot')
    assert.equal(frames.length, 2)
    assert.equal(frames[0].final, false)
    assert.equal(frames[0].cursor, 25)
    assert.equal(frames[0].records.length, 20)
    assert.equal(frames[1].final, true)
    assert.equal(frames[1].cursor, undefined)
    assert.equal(frames[1].records.length, 5)
    assert.equal(frames[1].records.at(-1).event.data.content[0].text, 'm24')
  } finally {
    controller.abort()
  }
})

test('multiplexes several sessions over one SSE and tags every frame', async () => {
  const controller = new AbortController()
  try {
    const response = await fetch(`${base}/api/stream?sessionId=session-test&sessionId=session-second`, { signal: controller.signal })
    assert.equal(response.status, 200)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let body = ''
    for (let reads = 0; reads < 200; reads += 1) {
      const { value, done } = await reader.read()
      if (done) break
      body += decoder.decode(value, { stream: true })
      if (body.includes('"sessionId":"session-test"') && body.includes('"sessionId":"session-second"') && body.includes('"t":"flash"')) break
    }
    assert.match(body, /"sessionId":"session-test"/)
    assert.match(body, /"sessionId":"session-second"/)
    assert.match(body, /"t":"ready"/)
    assert.match(body, /"t":"snapshot"/)
    assert.match(body, /"t":"delta"/)
    assert.match(body, /"t":"jobs"/)
    assert.match(body, /"t":"job-output"/)
    assert.match(body, /"t":"flash"/)
    const frames = body.split('\n')
      .filter((line) => line.startsWith('data: '))
      .flatMap((line) => {
        try { return [JSON.parse(line.slice(6))] } catch { return [] }
      })
    assert.ok(frames.length > 0)
    for (const frame of frames) {
      if (frame.t === 'ready') continue
      assert.ok(frame.sessionId === 'session-test' || frame.sessionId === 'session-second')
    }
  } finally {
    controller.abort()
  }
})

test('bootstraps a subagent with its durable parent address', async () => {
  followAddresses.length = 0
  const response = await fetch(`${base}/api/bootstrap?sessionId=session-subagent&parentSessionId=session-test`)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.match(JSON.stringify(body), /hello session-subagent/)
  assert.deepEqual(followAddresses[0], {
    kind: 'subagent',
    parentSessionId: 'session-test',
    childSessionId: 'session-subagent',
    mode: 'unknown',
  })
})

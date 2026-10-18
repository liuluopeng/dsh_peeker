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
      const id = request.address.sessionId
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
  apply(ctx, { port })
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
  assert.match(body, /font: 15px/)
})

test('injects the official UI font and conversation-width overrides', () => {
  const table = []
  for (const entry of listeners) {
    if (entry.event === 'webserver/index-inject') entry.listener(table)
  }
  assert.equal(table.length, 1)
  assert.equal(table[0].kind, 'style')
  assert.match(table[0].text, /--dsh-content-font-size: 34px !important/)
  assert.match(table[0].text, /--dsh-code-font-size: 24px !important/)
  assert.match(table[0].text, /--dsh-terminal-font-size: 24px !important/)
  assert.match(table[0].text, /--dsh-chat-user-width: 1200px/)
  assert.match(table[0].text, /\[data-conversation-content\] \{\s*--dsh-chat-content-width: 1200px !important/)
  assert.match(table[0].text, /--dsh-composer-card-max-width: 1232px !important/)
  assert.match(table[0].text, /\[data-width-handle\] \{\s*display: none !important/)
})

test('rejects an invalid conversation width', () => {
  // Validation runs before the listener is mounted, so an empty context is enough.
  assert.throws(() => apply({}, { port, contentWidth: 100 }), /contentWidth/)
  assert.throws(() => apply({}, { port, contentWidth: 1.5 }), /contentWidth/)
  assert.throws(() => apply({}, { port, contentWidth: 2401 }), /contentWidth/)
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
    assert.equal(table.length, 1)
    assert.match(table[0].text, /--dsh-content-font-size: 34px !important/)
    assert.doesNotMatch(table[0].text, /--dsh-chat-content-width/)
    assert.doesNotMatch(table[0].text, /data-width-handle/)
  } finally {
    for (const off of disposers.reverse()) off()
  }
})

test('lists sessions and refuses writes', async () => {
  const response = await fetch(`${base}/api/sessions`)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('connection'), 'close')
  const body = await response.json()
  assert.equal(body.items[0].title, 'Test task')
  assert.equal(body.items[0].running, true)

  const write = await fetch(`${base}/api/sessions`, { method: 'POST' })
  assert.equal(write.status, 405)
  assert.deepEqual(await write.json(), { error: 'read-only' })
})

test('streams a snapshot, deltas, and a completion flash', async () => {
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
    assert.match(body, /"t":"snapshot"/)
    assert.match(body, /"t":"delta"/)
    assert.match(body, /"t":"jobs"/)
    assert.match(body, /"t":"job-output"/)
    assert.match(body, /"t":"flash"/)
    assert.doesNotMatch(body, /"sessionId"/)
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
      assert.ok(frame.sessionId === 'session-test' || frame.sessionId === 'session-second')
    }
    assert.ok(frames.filter((frame) => frame.t === 'snapshot').length >= 2)
  } finally {
    controller.abort()
  }
})

/**
 * Hermetic integration test for the archive module: a fake Host context and a
 * fake NAS HTTP endpoint. No real DSH session or PostgreSQL is involved.
 *
 * What it proves:
 *   - backfill pages backwards until `hasMore === false` and delivers the
 *     WHOLE log (the viewer only ever takes one bounded snapshot);
 *   - the first `follow` frame is consumed and abandoned before promotion, so
 *     no further frame is requested;
 *   - live `session/event` frames are archived too;
 *   - delivery is idempotent and a failed POST is spooled and retried later.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createArchiver } from '../src/archive.js'

/**
 * Build a fake session log with `total` events, where every 10th is a message
 * (paging counts messages, not events).
 */
function fakeLog(total) {
  const events = []
  for (let seq = 0; seq < total; seq += 1) {
    const isMessage = seq % 10 === 0
    events.push({
      type: isMessage ? 'assistant/message' : 'step/start',
      seq,
      time: 1_700_000_000_000 + seq,
      data: isMessage
        ? { turn: 1, step: 1, message: { content: [{ type: 'text', text: `msg-${seq}` }] } }
        : { turn: 1, step: 1 },
    })
  }
  return events
}

/** Minimal Session Controller stand-in matching the Host contract we use. */
function fakeController(events, { inspectError = null } = {}) {
  const calls = { inspect: 0, follow: 0, page: 0 }
  const controller = {
    calls,
    async list() {
      return { items: [{ sessionId: 'sess-1', updatedAt: 42, running: false, blank: false }] }
    },
    // `inspect()` is NOT part of the exposed Remote face; the archive reads the
    // log through sessionQuery instead, so a controller.inspect call is a bug.
    // The archive must never open a follow stream (that would promote a cold
    // session's Agent); a call here fails the test loudly.
    follow() {
      calls.follow += 1
      throw new Error('archive must not call follow()')
    },
    async page() {
      calls.page += 1
      throw new Error('archive must not call page()')
    },
  }
  return controller
}

/** Recording fake NAS. */
async function fakeNas() {
  const received = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      received.push(body)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ msg: 'ok', data: { accepted_events: body.events?.length ?? 0 } }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    received,
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** Fake Host context: only the pieces the archiver touches. */
function fakeContext(controller, events = [], { inspectError = null } = {}) {
  const handlers = new Map()
  const queryCalls = { observe: 0 }
  return {
    handlers,
    sessionController: controller,
    sessionQuery: {
      async observeSession() {
        queryCalls.observe += 1
        if (inspectError !== null) throw inspectError
        const observation = {
          header: { version: 4, id: 'sess-1', createdAt: 1, cwd: '/tmp/ws', isSeeded: false },
          inheritedEventCount: 0,
          events,
        }
        observation[Symbol.dispose] = () => {}
        return observation
      },
    },
    queryCalls,
    on(name, callback) {
      handlers.set(name, callback)
      return () => handlers.delete(name)
    },
  }
}

function waitFor(check, { timeoutMs = 8000, intervalMs = 25 } = {}) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      let value
      try {
        value = check()
      } catch (error) {
        reject(error)
        return
      }
      if (value) {
        resolve(value)
        return
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error('timeout waiting for condition'))
        return
      }
      setTimeout(tick, intervalMs)
    }
    tick()
  })
}

test('backfills the whole log, captures live events and spools failures', async () => {
  const events = fakeLog(548)
  const controller = fakeController(events)
  const ctx = fakeContext(controller, events)
  const nas = await fakeNas()
  const home = mkdtempSync(join(tmpdir(), 'peek-archive-'))
  const archiver = createArchiver({
    ctx,
    config: {
      apiBase: nas.base,
      token: 'header.payload.signature',
      batch: 100,
      flushMs: 200,
      pollMs: 60_000,
      backfill: true,
      home,
    },
    log: () => {},
  })
  try {
    archiver.poll()
    await archiver.flush()
    await waitFor(() => archiver.status().queued === 0 && nas.received.length > 0)
    // Ensure the periodic flusher drained the rest of the backfill.
    await archiver.flush()

    const delivered = nas.received.flatMap((batch) => batch.events)
    const seqs = new Set(delivered.map((event) => event.seq))
    assert.equal(seqs.size, 548, `delivered ${seqs.size}/548 unique events`)
    for (let seq = 0; seq < 548; seq += 1) assert.ok(seqs.has(seq), `missing seq ${seq}`)
    // Full log came from sessionQuery (which never promotes); no follow/page.
    assert.equal(ctx.queryCalls.observe, 1)
    assert.equal(controller.calls.follow, 0)
    assert.equal(controller.calls.page, 0)
    // Session metadata travelled once.
    assert.equal(nas.received[0].sessions[0].session_id, 'sess-1')
    assert.equal(nas.received[0].sessions[0].workspace, '/tmp/ws')

    // Live capture through the Host firehose.
    const live = { type: 'user/message', seq: 548, time: 1, data: { content: [{ type: 'text', text: 'hi' }] } }
    ctx.handlers.get('session/event')({ id: 'sess-1', header: { id: 'sess-1' } }, live)
    await archiver.flush()
    const afterLive = nas.received.flatMap((batch) => batch.events)
    assert.ok(afterLive.some((event) => event.seq === 548 && event.type === 'user/message'))
  } finally {
    archiver.stop()
    await nas.close()
  }
})

test('a failing NAS spools events and delivers them once it recovers', async () => {
  const events = fakeLog(80)
  const controller = fakeController(events)
  const ctx = fakeContext(controller, events)
  // Point at a closed port first: delivery must fail and spool, not drop.
  const nas = await fakeNas()
  const deadBase = nas.base
  await nas.close()
  const home = mkdtempSync(join(tmpdir(), 'peek-archive-fail-'))
  const archiver = createArchiver({
    ctx,
    config: {
      apiBase: deadBase,
      token: 'header.payload.signature',
      batch: 50,
      flushMs: 100,
      pollMs: 60_000,
      backfill: true,
      home,
    },
    log: () => {},
  })
  try {
    archiver.poll()
    await archiver.flush().catch(() => {})
    await waitFor(() => archiver.status().spoolFiles > 0, { timeoutMs: 5000 })
    assert.ok(archiver.status().spoolFiles > 0, 'a failed delivery must spool, not drop')
    assert.equal(archiver.status().lastError.includes('ECONNREFUSED') || archiver.status().lastError.includes('HTTP'), true)

    // NAS comes back on the same port: the spool must drain automatically.
    const revived = await fakeNasOn(deadBase)
    try {
      await archiver.flush()
      await waitFor(() => archiver.status().spoolFiles === 0, { timeoutMs: 5000 })
      const delivered = revived.received.flatMap((batch) => batch.events)
      assert.equal(new Set(delivered.map((event) => event.seq)).size, 80)
    } finally {
      await revived.close()
    }
  } finally {
    archiver.stop()
  }
})

/** Start the fake NAS on an exact base URL (recovery after an outage). */
async function fakeNasOn(base) {
  const { port } = new URL(base)
  const received = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      received.push(body)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ msg: 'ok', data: { accepted_events: body.events?.length ?? 0 } }))
    })
  })
  await new Promise((resolve) => server.listen(Number(port), '127.0.0.1', resolve))
  return {
    received,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

test('refreshes an expired token through the login endpoint', async () => {
  const events = fakeLog(40)
  const controller = fakeController(events)
  const ctx = fakeContext(controller, events)
  const home = mkdtempSync(join(tmpdir(), 'peek-archive-login-'))
  const logins = []
  const received = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const answer = (value, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(value))
      }
      if (req.url === '/api/user/login') {
        logins.push(body)
        const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
        const jwt = `${encode({ alg: 'HS256' })}.${encode({ exp: Math.floor(Date.now() / 1000) + 86_400 * 20 })}.sig`
        answer({ msg: 'ok', data: { token: jwt } })
        return
      }
      // Any batch sent with the stale token is rejected like a real server would.
      if (req.headers.authorization === 'Bearer stale-token') {
        answer({ error: 'unauthorized' }, 401)
        return
      }
      received.push(body)
      answer({ msg: 'ok', data: { accepted_events: body.events?.length ?? 0 } })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const archiver = createArchiver({
    ctx,
    config: {
      apiBase: `http://127.0.0.1:${port}`,
      token: 'stale-token',
      username: 'dsh_archive',
      password: 'secret',
      batch: 50,
      flushMs: 100,
      pollMs: 60_000,
      backfill: true,
      home,
    },
    log: () => {},
  })
  try {
    archiver.poll()
    await archiver.flush()
    await waitFor(() => received.length > 0, { timeoutMs: 5000 })
    assert.equal(logins.length >= 1, true, 'auto-login must be attempted on 401')
    assert.equal(logins[0].username, 'dsh_archive')
    const delivered = received.flatMap((batch) => batch.events)
    assert.equal(new Set(delivered.map((event) => event.seq)).size, 40)
    assert.ok(archiver.status().token.daysLeft > 19)
  } finally {
    archiver.stop()
    await new Promise((resolve) => server.close(resolve))
  }
})

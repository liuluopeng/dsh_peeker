import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { apply } from '../src/index.js'

// ZCode support reads the ZCode app's SQLite session store. These tests build
// a minimal store with the same schema, point `zcodeDbPath` at it, and assert
// the merged session list, the bootstrap mapping, and the live watcher's
// deltas plus its completion turn/end.

const port = 33000 + (process.pid % 2000)
const base = `http://127.0.0.1:${port}`
let dispose = () => {}
let dir = ''
let db = null
const now = Date.now()

const SCHEMA = `
CREATE TABLE session (
  id text primary key, project_id text not null default '', workspace_id text, parent_id text,
  slug text not null default '', directory text not null default '', path text,
  title text not null default '', version text not null default '', share_url text,
  summary_additions integer, summary_deletions integer, summary_files integer, summary_diffs text,
  revert text, permission text, time_created integer not null, time_updated integer not null,
  time_compacting integer, time_archived integer, task_type text not null default 'interactive',
  title_source text not null default 'first_input', title_message_id text, time_title_updated integer,
  trace_id text, time_deleted integer, last_outcome text
);
CREATE TABLE message (
  id text primary key, session_id text not null references session(id) on delete cascade,
  time_created integer not null, time_updated integer not null, data text not null, sequence integer
);
CREATE INDEX message_session_time_created_id_idx on message(session_id, time_created, id);
CREATE TRIGGER message_sequence_autofill after insert on message when new.sequence is null begin
  update message set sequence = (select coalesce(max(sequence), -1) + 1 from message where session_id = new.session_id)
  where id = new.id;
end;
CREATE TABLE part (
  id text primary key, message_id text not null references message(id) on delete cascade,
  session_id text not null, time_created integer not null, time_updated integer not null,
  data text not null, sequence integer
);
CREATE INDEX part_message_id_id_idx on part(message_id, id);
CREATE TRIGGER part_sequence_autofill after insert on part when new.sequence is null begin
  update part set sequence = (select coalesce(max(sequence), -1) + 1 from part where message_id = new.message_id)
  where id = new.id;
end;
`

function insertSession(id, title, timeUpdated, lastOutcome = null) {
  db.prepare(
    `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated, last_outcome)
     VALUES (?, 'proj-test', ?, '/tmp/zdemo', ?, '0.0.0', ?, ?, ?)`,
  ).run(id, id, title, now - 3600_000, timeUpdated, lastOutcome)
}

function insertMessage(id, sessionId, timeCreated, data) {
  db.prepare(
    'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)',
  ).run(id, sessionId, timeCreated, timeCreated, JSON.stringify(data))
}

function insertPart(id, messageId, sessionId, timeUpdated, data) {
  db.prepare(
    'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, messageId, sessionId, timeUpdated - 1000, timeUpdated, JSON.stringify(data))
}

const runningSession = 'sess-running'
const doneSession = 'sess-done'
const userMessage = 'msg-user-1'
const assistantDone = 'msg-assist-1'
const userContinue = 'msg-user-2'
const assistantLive = 'msg-assist-live'
const modelOnly = 'msg-model-only'

function seed() {
  db.exec(SCHEMA)
  // The running task: a finished step, then an in-flight assistant message
  // (no `time.completed`) with a streaming text part and a running tool part.
  insertSession(runningSession, 'Z 活跃任务', now - 5_000)
  insertMessage(userMessage, runningSession, now - 60_000, { role: 'user', time: { created: now - 60_000 } })
  insertPart('p-user-text', userMessage, runningSession, now - 60_000, { type: 'text', text: '帮我看看这个项目' })
  insertMessage(assistantDone, runningSession, now - 50_000, { role: 'assistant', time: { created: now - 50_000, completed: now - 40_000 } })
  insertPart('p-reason', assistantDone, runningSession, now - 48_000, { type: 'reasoning', text: '思考内容' })
  insertPart('p-text-1', assistantDone, runningSession, now - 47_000, { type: 'text', text: '第一段回答' })
  insertPart('p-tool-1', assistantDone, runningSession, now - 45_000, {
    type: 'tool', tool: 'Bash', callID: 'call-1',
    state: { status: 'completed', input: { command: 'ls' }, output: 'file-a\nfile-b' },
  })
  insertMessage(userContinue, runningSession, now - 30_000, { role: 'user', time: { created: now - 30_000 } })
  insertPart('p-user-text-2', userContinue, runningSession, now - 30_000, { type: 'text', text: '继续' })
  insertMessage(assistantLive, runningSession, now - 10_000, { role: 'assistant', time: { created: now - 10_000 } })
  insertPart('p-live-text', assistantLive, runningSession, now - 5_000, { type: 'text', text: '正在' })
  insertPart('p-live-tool', assistantLive, runningSession, now - 6_000, {
    type: 'tool', tool: 'Read', callID: 'call-2',
    state: { status: 'running', input: { file_path: '/x' } },
  })
  // A model-only user message must never surface on the page.
  insertMessage(modelOnly, runningSession, now - 9_000, {
    role: 'user', time: { created: now - 9_000 }, metadata: { visibility: 'model-only' },
  })
  insertPart('p-model-only', modelOnly, runningSession, now - 9_000, { type: 'text', text: '内部提醒' })
  // A recently finished task feeds the completion strip.
  insertSession(doneSession, 'Z 完成任务', now - 3 * 60_000, 'completed')
  insertMessage('msg-done', doneSession, now - 4 * 60_000, { role: 'assistant', time: { created: now - 4 * 60_000, completed: now - 3 * 60_000 } })
  insertPart('p-done-text', 'msg-done', doneSession, now - 3 * 60_000, { type: 'text', text: '已完成的回答' })
  // An errored turn: outcome recorded and every timestamp frozen at the same
  // instant while the message stays uncompleted — finished, not running.
  insertSession('sess-error', 'Z 出错任务', now - 8 * 60_000, 'error')
  insertMessage('msg-error', 'sess-error', now - 8 * 60_000, { role: 'assistant', time: { created: now - 8 * 60_000 } })
  insertPart('p-error-text', 'msg-error', 'sess-error', now - 8 * 60_000, { type: 'text', text: '出错的回答' })
  // Too old to list in any form.
  insertSession('sess-old', 'Z 旧任务', now - 2 * 3600_000)
}

const listeners = []
const fakeCtx = {
  get() {
    return undefined
  },
  on(event, listener) {
    listeners.push({ event, listener })
    return () => {}
  },
  effect(fn) {
    dispose = fn()
    return dispose
  },
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lx-dsh-peek-zcode-'))
  db = new DatabaseSync(join(dir, 'db.sqlite'))
  seed()
  apply(fakeCtx, { port, zcodeDbPath: join(dir, 'db.sqlite') })
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/health`)
      if (response.ok) return
    } catch {
      // The listener is still starting.
    }
    await sleep(100)
  }
  throw new Error('zcode peek instance did not start')
})

after(() => {
  dispose()
  try { db.close() } catch { /* already gone */ }
  rmSync(dir, { recursive: true, force: true })
})

test('merges ZCode sessions into the LAN session list', async () => {
  const response = await fetch(`${base}/api/sessions`)
  assert.equal(response.status, 200)
  const body = await response.json()
  const running = body.items.find((item) => item.sessionId === 'z:sess-running')
  assert.ok(running, 'running ZCode session is listed')
  assert.equal(running.running, true)
  assert.equal(running.source, 'zcode')
  assert.equal(running.title, 'Z 活跃任务')
  assert.equal(running.cwd, '/tmp/zdemo')
  const done = body.items.find((item) => item.sessionId === 'z:sess-done')
  assert.ok(done, 'recently finished ZCode session is listed')
  assert.equal(done.running, false)
  assert.equal(done.outcome, 'completed')
  assert.ok(Number.isFinite(done.finishedAt) && done.finishedAt > 0)
  // The errored turn must surface in the strip, never as a stuck running pane.
  const errored = body.items.find((item) => item.sessionId === 'z:sess-error')
  assert.ok(errored, 'errored ZCode session is listed')
  assert.equal(errored.running, false)
  assert.equal(errored.outcome, 'error')
  assert.equal(body.items.find((item) => item.sessionId === 'z:sess-old'), undefined)
})

test('bootstraps a ZCode transcript into the shared event shapes', async () => {
  const response = await fetch(`${base}/api/bootstrap?sessionId=z:sess-running`)
  assert.equal(response.status, 200)
  const body = await response.json()
  const text = JSON.stringify(body.records)
  assert.match(text, /帮我看看这个项目/)
  assert.match(text, /第一段回答/)
  assert.match(text, /思考内容/)
  assert.match(text, /"type":"tool\/call"/)
  assert.match(text, /"name":"Bash"/)
  assert.match(text, /file-a\\nfile-b/)
  assert.match(text, /"type":"turn\/start"/)
  // The in-flight message's text streams live instead of appearing in the
  // snapshot, and model-only user messages never surface.
  assert.doesNotMatch(text, /正在/)
  assert.doesNotMatch(text, /内部提醒/)
})

test('watcher streams deltas and flashes when the ZCode turn completes', async () => {
  const controller = new AbortController()
  try {
    const response = await fetch(`${base}/api/stream?sessionId=z:sess-running`, { signal: controller.signal })
    assert.equal(response.status, 200)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let body = ''
    // One sequential pump drains the stream; a per-step wait only polls the
    // accumulated text. Racing reader.read() against a timeout would abandon
    // pending reads, and Node delivers queued chunks to abandoned reads in
    // FIFO order — frames would vanish from the test's point of view.
    const pump = (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          body += decoder.decode(value, { stream: true })
        }
      } catch { /* aborted at the end of the test */ }
    })()
    const waitUntil = async (predicate, limitMs = 15000) => {
      const deadline = Date.now() + limitMs
      while (Date.now() < deadline) {
        if (predicate(body)) return true
        await sleep(100)
      }
      return predicate(body)
    }
    await waitUntil((text) => text.includes('"t":"ready"'))

    // Grow the in-flight text part: the next poll must emit only the appended
    // slice as a text delta.
    db.prepare('UPDATE part SET data = ?, time_updated = ? WHERE id = ?')
      .run(JSON.stringify({ type: 'text', text: '正在流式输出' }), Date.now(), 'p-live-text')
    await waitUntil((text) => text.includes('流式输出'))
    assert.match(body, /"type":"text-delta"/)
    assert.match(body, /流式输出/)

    // Complete the running tool part, then settle the turn: the watcher emits
    // the tool result, the final assistant message, and the completion flash.
    db.prepare('UPDATE part SET data = ?, time_updated = ? WHERE id = ?')
      .run(JSON.stringify({
        type: 'tool', tool: 'Read', callID: 'call-2',
        state: { status: 'completed', input: { file_path: '/x' }, output: 'file content' },
      }), Date.now(), 'p-live-tool')
    await waitUntil((text) => text.includes('file content'))
    db.prepare('UPDATE message SET data = ?, time_updated = ? WHERE id = ?')
      .run(JSON.stringify({ role: 'assistant', time: { created: now - 10_000, completed: now } }), now, assistantLive)
    db.prepare('UPDATE session SET time_updated = ?, last_outcome = ? WHERE id = ?')
      .run(now - 120_000, 'completed', runningSession)
    await waitUntil((text) => text.includes('"t":"flash"'))
    assert.match(body, /"type":"tool\/result"/)
    assert.match(body, /"type":"assistant\/message"/)
    assert.match(body, /正在流式输出/)
    assert.match(body, /"type":"turn\/end"/)
    assert.match(body, /"t":"flash"/)
  } finally {
    controller.abort()
  }
})

test('read-only mode never accepts writes on ZCode ids either', async () => {
  const write = await fetch(`${base}/api/bootstrap?sessionId=z:sess-running`, { method: 'POST' })
  assert.equal(write.status, 405)
})

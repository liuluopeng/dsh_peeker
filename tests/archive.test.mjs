import assert from 'node:assert/strict'
import test from 'node:test'

import { compactEvent, conversationText, sessionMeta, shouldArchive, tokenLifetime } from '../src/archive.js'

/** Build an unsigned JWT-shaped token with the given payload. */
function fakeJwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.signature`
}

/** An `assistant/message` event carrying the per-token stream duplicate. */
function assistantEvent() {
  return {
    type: 'assistant/message',
    seq: 18,
    time: 1_700_000_000_000,
    data: {
      turn: 1,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      stream: [{ type: 'text-delta', text: 'h' }, { type: 'text-delta', text: 'i' }],
    },
  }
}

test('tokenLifetime reads exp and reports remaining days', () => {
  const future = Math.floor(Date.now() / 1000) + 86400 * 10
  const lifetime = tokenLifetime(fakeJwt({ exp: future }))
  assert.equal(lifetime.expiresAt, future * 1000)
  assert.ok(lifetime.daysLeft > 9.9 && lifetime.daysLeft <= 10)
})

test('tokenLifetime tolerates missing or malformed tokens', () => {
  assert.deepEqual(tokenLifetime(''), { expiresAt: null, daysLeft: null })
  assert.deepEqual(tokenLifetime('not-a-jwt'), { expiresAt: null, daysLeft: null })
  assert.deepEqual(tokenLifetime(`${fakeJwt({})}.x`), { expiresAt: null, daysLeft: null })
  assert.deepEqual(tokenLifetime(fakeJwt({ exp: 'nope' })), { expiresAt: null, daysLeft: null })
})

test('compactEvent drops the per-token stream copy by default', () => {
  const compacted = compactEvent(assistantEvent(), false)
  assert.equal('stream' in compacted.data, false)
  assert.deepEqual(compacted.data.message, assistantEvent().data.message)
  assert.equal(compacted.seq, 18)
})

test('compactEvent keeps the stream when explicitly enabled', () => {
  const event = assistantEvent()
  assert.equal(compactEvent(event, true), event)
})

test('compactEvent leaves other event types untouched', () => {
  const event = { type: 'tool/result', seq: 22, time: 1, data: { message: { content: [] } } }
  assert.equal(compactEvent(event, false), event)
})

test('shouldArchive skips already archived and malformed events', () => {
  const event = assistantEvent()
  assert.equal(shouldArchive(event, 17), true)
  assert.equal(shouldArchive(event, 18), false)
  assert.equal(shouldArchive(event, 20), false)
  assert.equal(shouldArchive({ type: 'x' }, -1), false)
  assert.equal(shouldArchive(null, -1), false)
})

test('sessionMeta maps a wire header onto the ingest row', () => {
  const meta = sessionMeta({
    version: 4,
    id: 'abc',
    createdAt: 1_700_000_000_000,
    cwd: '/Volumes/six/dayly_service',
    origin: 'subagent',
    parentSession: 'session-parent',
    isSeeded: false,
    delegationDepth: 1,
    agentPreset: 'standard',
  })
  assert.equal(meta.session_id, 'abc')
  assert.equal(meta.workspace, '/Volumes/six/dayly_service')
  assert.equal(meta.origin, 'subagent')
  assert.equal(meta.parent_session_id, 'session-parent')
  assert.equal(meta.created_at, 1_700_000_000_000)
  assert.equal(meta.meta.agentPreset, 'standard')
  assert.equal(meta.meta.delegationDepth, 1)
})

test('sessionMeta refuses headerless sessions', () => {
  assert.equal(sessionMeta(null), null)
  assert.equal(sessionMeta({}), null)
  assert.equal(sessionMeta({ id: '' }), null)
})

test('conversationText keeps prose and reasoning, drops tool calls', () => {
  const assistant = {
    message: {
      content: [
        { type: 'reasoning', text: ' 先看结构 ' },
        { type: 'text', text: '答案在这' },
        { type: 'tool-call', name: 'bash', arguments: '{"command":"ls -la"}' },
      ],
    },
  }
  const text = conversationText('assistant/message', assistant)
  assert.equal(text, '[思考] 先看结构\n答案在这')
  assert.equal(conversationText('user/message', { content: [{ type: 'text', text: '我的问题' }] }), '我的问题')
  assert.equal(conversationText('session/title', { title: '某次会话' }), '某次会话')
  assert.equal(conversationText('step/start', { turn: 1 }), '')
})

test('shouldArchive in text mode only keeps conversation types', () => {
  const user = { type: 'user/message', seq: 3, time: 1, data: {} }
  const tool = { type: 'tool/result', seq: 4, time: 1, data: {} }
  const step = { type: 'step/end', seq: 5, time: 1, data: {} }
  assert.equal(shouldArchive(user, -1), true)
  assert.equal(shouldArchive(tool, -1), false)
  assert.equal(shouldArchive(step, -1), false)
  // full mode still keeps everything
  assert.equal(shouldArchive(tool, -1, 'full'), true)
})

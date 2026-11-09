import assert from 'node:assert/strict'
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { Store } from '../src/store.ts'
import { tempDir } from './helpers.ts'

const message = (index: number) => ({ id: `u:${index}`, messageId: String(index), user: 'u', at: new Date(index).toISOString(), text: `m${index}` })

test('the message ring keeps the newest entries and survives a reload', () => {
  const dir = tempDir()
  const store = new Store(dir, 3)
  for (let index = 0; index < 5; index += 1) store.appendMessage(message(index))
  assert.deepEqual(store.history('u', 10).map(item => item.id), ['u:2', 'u:3', 'u:4'])
  assert.deepEqual(new Store(dir, 3).history('u', 10).map(item => item.id), ['u:2', 'u:3', 'u:4'])
})

test('the token round-trips and clearing it is safe', () => {
  const dir = tempDir()
  const store = new Store(dir, 10)
  store.saveToken({ token: 't', baseUrl: 'https://api.test', accountId: 'b', userId: 'u', savedAt: 'now' })
  assert.equal(new Store(dir, 10).token?.token, 't')
  assert.equal(statSync(join(dir, 'sources', 'wechat', 'auth', 'token.json')).mode & 0o777, 0o600)
  store.clearToken()
  assert.equal(new Store(dir, 10).token, undefined)
})

test('inbound resets the send budget and refreshes the context token', () => {
  const dir = tempDir()
  const store = new Store(dir, 10)
  store.noteInbound('u', 'ctx-1')
  store.noteOutbound('u')
  store.noteOutbound('u')
  assert.equal(store.outboundOf('u').count, 2)
  store.noteInbound('u', 'ctx-2')
  assert.equal(store.outboundOf('u').count, 0)
  assert.equal(store.outboundOf('u').contextToken, 'ctx-2')
})

test('corrupt state files fall back to empty state and recover on the next write', () => {
  const dir = tempDir()
  const root = join(dir, 'sources', 'wechat')
  mkdirSync(join(root, 'auth'), { recursive: true })
  writeFileSync(join(root, 'auth', 'token.json'), '{"token": "trunc')
  writeFileSync(join(root, 'sync-buf.json'), '{"buffer": 7}')
  writeFileSync(join(root, 'messages.json'), '{}')
  // Valid JSON, wrong shape: an array is not an outbound map, and writing into
  // it used to vanish in JSON.stringify, silently resetting the send budget.
  writeFileSync(join(root, 'outbound.json'), '[]')

  const store = new Store(dir, 10)
  assert.equal(store.token, undefined)
  assert.equal(store.cursor, '')
  assert.deepEqual(store.history('u', 5), [])
  assert.deepEqual(store.outboundOf('u'), { count: 0 })

  // A damaged file must not block the next legitimate write.
  store.saveToken({ token: 't2', baseUrl: 'https://api.test', accountId: 'b', userId: 'u', savedAt: 'now' })
  store.appendMessage({ id: 'u:1', messageId: '1', user: 'u', at: 'now', text: 'hi' })
  store.noteOutbound('u')
  const reloaded = new Store(dir, 10)
  assert.equal(reloaded.token?.token, 't2')
  assert.equal(reloaded.history('u', 5).length, 1)
  assert.equal(reloaded.outboundOf('u').count, 1, 'the send counter must survive the reload')

  // A bare number used to reach `noteOutbound` and throw on the property write.
  writeFileSync(join(root, 'outbound.json'), '7')
  assert.doesNotThrow(() => new Store(dir, 10).noteOutbound('u'))
})

test('inbound without a context token keeps the previous one', () => {
  const dir = tempDir()
  const store = new Store(dir, 10)
  store.noteInbound('u', 'ctx-1')
  store.noteInbound('u', undefined)
  assert.equal(store.outboundOf('u').contextToken, 'ctx-1')
})

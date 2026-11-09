import assert from 'node:assert/strict'
import { test } from 'node:test'
import { wechatKind } from '../src/kind.ts'
import { TASK_PREFIX, toTrigger, threadOf } from '../src/trigger.ts'
import type { WeixinMessage } from '../src/ilink/types.ts'

const message = (overrides: Partial<WeixinMessage> = {}): WeixinMessage => ({
  message_id: '7000000000000000001',
  from_user_id: 'wxid_alice',
  create_time_ms: 1_760_000_000_000,
  message_type: 1,
  item_list: [{ type: 1, text_item: { text: '/task 修一下登录页的错别字' } }],
  context_token: 'ctx-1',
  ...overrides,
})

test('prefix match: addressed direct, prefix stripped, scope listens', () => {
  const trigger = toTrigger(message())
  assert.ok(trigger)
  assert.equal(trigger.addressed, 'direct')
  assert.equal(trigger.text, '修一下登录页的错别字')
  assert.equal(trigger.id, 'wechat:wxid_alice:7000000000000000001')
  assert.deepEqual(trigger.threads, [{ source: 'wechat', id: threadOf('wxid_alice') }])
  assert.equal(trigger.meta.prefixMatched, true)
  assert.equal(trigger.meta.contextToken, undefined, 'context_token must not leak into meta')
  assert.deepEqual(wechatKind.scope({ meta: trigger.meta }, wechatKind.schema.parse({})), { listened: true, observed: false, row: 'direct' })
})

test('no prefix: not addressed, text kept, scope filters with a reason', () => {
  const trigger = toTrigger(message({ item_list: [{ type: 1, text_item: { text: '今天天气不错' } }] }))
  assert.ok(trigger)
  assert.equal(trigger.addressed, undefined)
  assert.equal(trigger.text, '今天天气不错')
  assert.deepEqual(wechatKind.scope({ meta: trigger.meta }, wechatKind.schema.parse({})), { listened: false, reason: 'no_task_prefix' })
})

test('prefix is case-insensitive and tolerates a Chinese colon', () => {
  for (const text of ['/TASK 做事', '/task：做事', '/task，做事']) {
    const trigger = toTrigger(message({ item_list: [{ type: 1, text_item: { text } }] }))
    assert.ok(trigger, text)
    assert.equal(trigger.addressed, 'direct', text)
    assert.equal(trigger.text, '做事', text)
  }
  assert.equal(TASK_PREFIX.test('/tasking 不是前缀'), false)
})

test('group messages are dropped', () => {
  assert.equal(toTrigger(message({ group_id: 'group@chatroom' })), undefined)
})

test('the bot own messages are dropped', () => {
  assert.equal(toTrigger(message({ message_type: 2 })), undefined)
})

test('media-only messages are dropped', () => {
  assert.equal(toTrigger(message({ item_list: [{ type: 2 }] })), undefined)
})

test('id falls back to client_id, then to time+seq', () => {
  assert.equal(toTrigger(message({ message_id: undefined, client_id: 'c-1' }))?.id, 'wechat:wxid_alice:c-1')
  assert.equal(toTrigger(message({ message_id: undefined, client_id: undefined, seq: 9 }))?.id, 'wechat:wxid_alice:9')
})

test('human follows message_type USER', () => {
  assert.equal(toTrigger(message())?.human, true)
  assert.equal(toTrigger(message({ message_type: 0 }))?.human, false)
})

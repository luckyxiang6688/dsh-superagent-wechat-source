import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WechatConfigSchema, wechatKind } from '../src/kind.ts'

test('config defaults are filled and unknown keys rejected', () => {
  assert.deepEqual(WechatConfigSchema.parse({}), { historyLimit: 200, readPageSize: 20 })
  assert.throws(() => WechatConfigSchema.parse({ nope: 1 }))
  assert.throws(() => WechatConfigSchema.parse({ historyLimit: 1 }))
})

test('policy allows listed ids and rejects duplicates', () => {
  const policy = wechatKind.policy
  assert.deepEqual(policy.schema.parse({}), { allowed: [] })
  assert.equal(policy.schema.parse({ allowed: [{ id: 'wxid_alice', name: '我' }] }).allowed.length, 1)
  assert.throws(() => policy.schema.parse({ allowed: [{ id: 'a' }, { id: 'a' }] }))
  assert.throws(() => policy.schema.parse({ allowed: [{ id: '' }] }))
})

test('channel only accepts an address with a user', () => {
  assert.equal(wechatKind.channel.allowed({ user: 'wxid_alice' }, WechatConfigSchema.parse({})), true)
  assert.equal(wechatKind.channel.allowed({}, WechatConfigSchema.parse({})), false)
})

test('the kind declares one health entry and no admission table', () => {
  assert.deepEqual(wechatKind.health, ['wechat'])
  // A DM is always addressed, so a listed sender is explicit before any
  // admission cell is consulted; declaring rows would only invent dead config.
  assert.equal('rows' in wechatKind.policy, false)
  assert.deepEqual(wechatKind.scope({ meta: { prefixMatched: false } }, WechatConfigSchema.parse({})), { listened: true, observed: false, row: 'direct' })
})

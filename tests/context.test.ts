import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { Account } from '../src/account.ts'
import { wechatKind } from '../src/kind.ts'
import { setAccount } from '../src/runtime.ts'
import { tempDir } from './helpers.ts'

function boundAccount(historyLimit = 200): Account {
  const dir = tempDir()
  const auth = join(dir, 'sources', 'wechat', 'auth')
  mkdirSync(auth, { recursive: true })
  writeFileSync(join(auth, 'token.json'), JSON.stringify({ token: 't', baseUrl: 'https://api.test', accountId: 'b', userId: 'wxid_alice', savedAt: 'now' }))
  const account = new Account({ stateDir: dir, historyLimit, receive: () => {}, report: () => {} })
  setAccount(account)
  return account
}

const inbound = (index: number) => ({
  message_id: String(9000000000000000000 + index),
  from_user_id: 'wxid_alice',
  create_time_ms: 1_760_000_000_000 + index,
  message_type: 1,
  item_list: [{ type: 1 as const, text_item: { text: `/task 第${index}条` } }],
})

test('thread reads page oldest-first with a cursor', async () => {
  const account = boundAccount()
  for (let index = 0; index < 25; index += 1) account.ingest(inbound(index))
  const trigger = {
    id: 'wechat:wxid_alice:9000000000000000000', source: 'wechat', threads: [], actor: { source: 'wechat', id: 'wxid_alice' },
    human: true, at: new Date().toISOString(), text: '', meta: { messageId: '9000000000000000000' },
  }
  const config = { historyLimit: 200, readPageSize: 20 }
  const first = await wechatKind.threadContext.read(undefined, trigger as never, 'thread', undefined, config)
  assert.equal(first.messages.length, 20)
  assert.equal(first.next, '20')
  assert.equal(wechatKind.threadContext.messageId(trigger as never), '9000000000000000000')
  const second = await wechatKind.threadContext.read(undefined, trigger as never, 'thread', first.next, config)
  assert.equal(second.messages.length, 5)
  assert.equal(second.next, undefined)
  const root = await wechatKind.threadContext.read(undefined, trigger as never, 'root', undefined, config)
  assert.equal(root.status, 'no_root')
  const parent = await wechatKind.threadContext.read(undefined, trigger as never, 'parent', undefined, config)
  assert.equal(parent.status, 'no_parent')
})

test('history respects the ring limit from config', () => {
  const account = boundAccount(30)
  for (let index = 0; index < 50; index += 1) account.ingest(inbound(index))
  assert.equal(account.history('wxid_alice', 500).length, 30)
})

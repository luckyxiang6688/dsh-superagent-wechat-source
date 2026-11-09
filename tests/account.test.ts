import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { Account, dshWechatAccount } from '../src/account.ts'
import type { Trigger } from '../src/contract.ts'
import { fakeFetch, tempDir, waitFor } from './helpers.ts'

function seededAccount(options: { fetchImpl?: typeof fetch; received?: Trigger[]; reports?: string[] } = {}): { account: Account; dir: string } {
  const dir = tempDir()
  const auth = join(dir, 'sources', 'wechat', 'auth')
  mkdirSync(auth, { recursive: true })
  writeFileSync(join(auth, 'token.json'), JSON.stringify({ token: 'bot-token', baseUrl: 'https://api.example', accountId: 'bot-1', userId: 'wxid_alice', savedAt: new Date().toISOString() }))
  const account = new Account({
    stateDir: dir,
    historyLimit: 200,
    receive: trigger => { options.received?.push(trigger) },
    report: (state, detail) => { options.reports?.push(`${state}:${detail}`) },
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  })
  return { account, dir }
}

const inbound = (text: string, id = '9000000000000000001') => ({
  message_id: id,
  from_user_id: 'wxid_alice',
  create_time_ms: 1_760_000_000_000,
  message_type: 1,
  context_token: 'ctx-42',
  item_list: [{ type: 1 as const, text_item: { text } }],
})

test('reply needs an inbound context_token first', async () => {
  const { account } = seededAccount()
  await assert.rejects(() => account.sendText('wxid_alice', 'hi', 'reply-1'), /context_token/)
})

test('reply payload carries to_user_id, context_token and a stable client_id', async () => {
  const { fetch, calls } = fakeFetch(() => ({ ret: 0 }))
  const { account } = seededAccount({ fetchImpl: fetch })
  account.ingest(inbound('hello'))
  await account.sendText('wxid_alice', '第一条回复', 'reply-1')
  await account.sendText('wxid_alice', '重试同一条', 'reply-1')
  const sends = calls.filter(call => call.url.endsWith('/ilink/bot/sendmessage'))
  assert.equal(sends.length, 2)
  const first = JSON.parse(sends[0]!.body).msg
  const second = JSON.parse(sends[1]!.body).msg
  assert.equal(first.to_user_id, 'wxid_alice')
  assert.equal(first.context_token, 'ctx-42')
  assert.equal(first.message_type, 2)
  assert.deepEqual(first.item_list, [{ type: 1, text_item: { text: '第一条回复' } }])
  assert.equal(first.client_id, second.client_id, 'the same Outbox message must reuse its client_id')
  assert.match(first.client_id, /^dsh-[0-9a-f]{32}$/)
  assert.notEqual(JSON.parse(sends[1]!.body).msg.item_list[0].text_item.text, '第一条回复')
})

test('the consecutive-send budget stops at 10 and resets on inbound', async () => {
  const { fetch } = fakeFetch(() => ({ ret: 0 }))
  const { account } = seededAccount({ fetchImpl: fetch })
  account.ingest(inbound('start'))
  for (let index = 0; index < 10; index += 1) await account.sendText('wxid_alice', `m${index}`, `reply-${index}`)
  await assert.rejects(() => account.sendText('wxid_alice', 'm10', 'reply-10'), /连发上限/)
  account.ingest(inbound('again', '9000000000000000002'))
  await account.sendText('wxid_alice', 'after reset', 'reply-11')
})

test('long text is split into several messages under the same Outbox id', async () => {
  const { fetch, calls } = fakeFetch(() => ({ ret: 0 }))
  const { account } = seededAccount({ fetchImpl: fetch })
  account.ingest(inbound('start'))
  const long = Array.from({ length: 900 }, (_, index) => `第${index}行`).join('\n')
  await account.sendText('wxid_alice', long, 'reply-long')
  const sends = calls.filter(call => call.url.endsWith('/ilink/bot/sendmessage'))
  assert.ok(sends.length > 1)
  const ids = sends.map(call => JSON.parse(call.body).msg.client_id)
  assert.equal(new Set(ids).size, ids.length)
})

test('monitor polls, resets the budget, stores history and hands Trigger to the host', async () => {
  const received: Trigger[] = []
  let polls = 0
  const { fetch } = fakeFetch(async call => {
    if (call.url.includes('notifystart') || call.url.includes('notifystop')) return { ret: 0 }
    polls += 1
    if (polls > 1) {
      // The real long poll waits for the server; without a pause this loop
      // would spin as fast as the fake resolves and starve the test's timers.
      await new Promise(resolve => { setTimeout(resolve, 10) })
      return { ret: 0, msgs: [], get_updates_buf: 'buf-1' }
    }
    return { ret: 0, msgs: [inbound('/task 做事'), { ...inbound('群消息'), group_id: 'g', message_id: '9000000000000000009' }], get_updates_buf: 'buf-1' }
  })
  const { account, dir } = seededAccount({ fetchImpl: fetch, received })
  account.start()
  await waitFor(() => received.length > 0)
  account.stop()
  assert.equal(received.length, 1, 'group messages never reach the host')
  assert.equal(received[0]!.text, '做事')
  assert.equal(received[0]!.addressed, 'direct')
  assert.equal(account.history('wxid_alice', 10).length, 1)
  const sync = JSON.parse(readFileSync(join(dir, 'sources', 'wechat', 'sync-buf.json'), 'utf-8'))
  assert.equal(sync.buffer, 'buf-1')
  assert.equal(statSync(join(dir, 'sources', 'wechat', 'sync-buf.json')).mode & 0o777, 0o600)
})

test('a dsh-wechat login on this machine is reported as a conflict', () => {
  const home = tempDir()
  mkdirSync(join(home, '.dsh-wechat', 'auth'), { recursive: true })
  writeFileSync(join(home, '.dsh-wechat', 'auth', 'token.json'), JSON.stringify({ userId: 'wxid_alice' }))
  const found = dshWechatAccount(home)
  assert.equal(found?.userId, 'wxid_alice')
  assert.equal(dshWechatAccount(join(home, 'nobody')), undefined)
})

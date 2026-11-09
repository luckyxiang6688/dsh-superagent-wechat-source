import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clientVersionOf, CHANNEL_VERSION, parseLossless, textMessage } from '../src/ilink/api.ts'
import { splitText } from '../src/text.ts'
import { fakeFetch } from './helpers.ts'
import { sendMessage } from '../src/ilink/api.ts'

test('channel_version keeps the official 3.x prefix and our marker in the suffix', () => {
  assert.match(CHANNEL_VERSION, /^3\.\d+\.\d+\//)
  assert.equal(clientVersionOf('3.0.1'), (3 << 16) | 1)
  assert.equal(clientVersionOf('3.0.0/dsh-0.1'), 3 << 16)
})

test('parseLossless keeps 19-digit message ids as strings', () => {
  const parsed = parseLossless<{ msgs: { message_id: string }[] }>('{"msgs":[{"message_id":9007199254740993001}]}')
  assert.equal(parsed.msgs[0]!.message_id, '9007199254740993001')
})

test('send headers carry the bot token and app id', async () => {
  const { fetch, calls } = fakeFetch(() => ({ ret: 0 }))
  await sendMessage({ baseUrl: 'https://api.test/', token: 'bot-token', body: textMessage({ to: 'wxid_alice', text: 'hi', clientId: 'c' }), fetchImpl: fetch })
  assert.equal(calls[0]!.url, 'https://api.test/ilink/bot/sendmessage')
  const parsed = JSON.parse(calls[0]!.body)
  assert.equal(parsed.msg.to_user_id, 'wxid_alice')
  assert.equal(parsed.base_info.channel_version, CHANNEL_VERSION)
  assert.equal(parsed.base_info.bot_agent.startsWith('DSHSuperagentWechat/'), true)
})

test('sendMessage throws on a non-zero ret', async () => {
  const { fetch } = fakeFetch(() => ({ ret: -2, errmsg: 'prepare failed' }))
  await assert.rejects(() => sendMessage({ baseUrl: 'https://api.test', token: 't', body: textMessage({ to: 'u', text: 'x', clientId: 'c' }), fetchImpl: fetch }), /ret=-2/)
})

test('splitText respects the limit and prefers line breaks', () => {
  assert.deepEqual(splitText('短消息'), ['短消息'])
  const text = Array.from({ length: 50 }, (_, index) => `line-${index}`).join('\n')
  const pieces = splitText(text, 40)
  assert.ok(pieces.length > 1)
  for (const piece of pieces) assert.ok(Array.from(piece).length <= 40)
  assert.equal(pieces.join('\n'), text)
})

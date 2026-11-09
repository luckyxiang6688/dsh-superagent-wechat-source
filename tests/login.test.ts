import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LoginSession } from '../src/login.ts'
import type { TokenData } from '../src/store.ts'
import { fakeFetch, waitFor } from './helpers.ts'

const qr = { qrcode: 'Q-1', qrcode_img_content: 'https://qr.test/Q-1' }

test('confirmed stores the four credential fields', async () => {
  const tokens: TokenData[] = []
  const { fetch, calls } = fakeFetch((_call, index) => {
    if (index === 0) return qr
    return { status: 'confirmed', bot_token: 'bot-token', ilink_bot_id: 'bot-1', baseurl: 'https://api2.test', ilink_user_id: 'wxid_alice' }
  })
  const session = new LoginSession({ localTokenList: () => ['existing-token'], onConfirmed: token => tokens.push(token), fetchImpl: fetch })
  session.start()
  await waitFor(() => tokens.length === 1)
  assert.equal(tokens[0]!.token, 'bot-token')
  assert.equal(tokens[0]!.accountId, 'bot-1')
  assert.equal(tokens[0]!.userId, 'wxid_alice')
  assert.equal(tokens[0]!.baseUrl, 'https://api2.test')
  assert.equal(session.state().phase, 'confirmed')
  assert.match(calls[0]!.url, /get_bot_qrcode\?bot_type=3/)
  assert.deepEqual(JSON.parse(calls[0]!.body), { local_token_list: ['existing-token'] })
})

test('need_verifycode asks for the PIN and resubmits it', async () => {
  const tokens: TokenData[] = []
  let statusCalls = 0
  const { fetch, calls } = fakeFetch((call, index) => {
    if (index === 0) return qr
    statusCalls += 1
    if (call.url.includes('verify_code=')) {
      return statusCalls === 1 ? { status: 'scaned' } : { status: 'confirmed', bot_token: 't', ilink_bot_id: 'b', ilink_user_id: 'u' }
    }
    return { status: 'need_verifycode' }
  })
  const session = new LoginSession({ localTokenList: () => [], onConfirmed: token => tokens.push(token), fetchImpl: fetch })
  session.start()
  await waitFor(() => session.state().phase === 'need_verifycode')
  assert.equal(session.submitCode('123456'), true)
  await waitFor(() => tokens.length === 1)
  assert.ok(calls.some(call => call.url.includes('verify_code=123456')))
})

test('binded_redirect means the account is bound elsewhere; no credentials are taken', async () => {
  const tokens: TokenData[] = []
  const { fetch } = fakeFetch((_call, index) => index === 0 ? qr : { status: 'binded_redirect' })
  const session = new LoginSession({ localTokenList: () => [], onConfirmed: token => tokens.push(token), fetchImpl: fetch })
  session.start()
  await waitFor(() => session.state().phase === 'already_bound')
  assert.equal(tokens.length, 0)
  assert.match(session.state().error ?? '', /另一个客户端/)
})

test('a QR that keeps expiring gives up after three refreshes', async () => {
  // get_bot_qrcode, then get_qrcode_status answering "expired", repeated.
  let qrCalls = 0
  const { fetch, calls } = fakeFetch(() => {
    qrCalls += 1
    return qrCalls % 2 === 1 ? qr : { status: 'expired' }
  })
  const session = new LoginSession({
    localTokenList: () => [],
    onConfirmed: () => { throw new Error('an expired QR must never confirm') },
    fetchImpl: fetch,
  })
  session.start()
  await waitFor(() => session.state().phase === 'expired', 5000)
  assert.match(session.state().error ?? '', /多次失效/)
  assert.equal(calls.filter(call => call.url.includes('get_bot_qrcode')).length, 4)
})

test('scaned_but_redirect switches the polling host', async () => {
  const tokens: TokenData[] = []
  let statusCalls = 0
  const { fetch, calls } = fakeFetch((_call, index) => {
    if (index === 0) return qr
    statusCalls += 1
    if (statusCalls === 1) return { status: 'scaned_but_redirect', redirect_host: 'redirect.test' }
    return { status: 'confirmed', bot_token: 't', ilink_bot_id: 'b', ilink_user_id: 'u' }
  })
  const session = new LoginSession({ localTokenList: () => [], onConfirmed: token => tokens.push(token), fetchImpl: fetch })
  session.start()
  await waitFor(() => tokens.length === 1)
  const statusUrls = calls.filter(call => call.url.includes('get_qrcode_status')).map(call => call.url)
  assert.ok(statusUrls.some(url => url.startsWith('https://redirect.test/')))
})

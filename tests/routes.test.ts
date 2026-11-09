import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { test } from 'node:test'
import { registerRoutes, type WebServerLike } from '../src/routes.ts'
import type { Account } from '../src/account.ts'

type Handler = (req: IncomingMessage, res: ServerResponse) => unknown

function harness(account: Partial<Account>): { handlers: Map<string, Handler>; call: (path: string, options?: { header?: boolean; body?: string; origin?: string }) => Promise<{ status: number; json: Record<string, unknown> }> } {
  const handlers = new Map<string, Handler>()
  const server: WebServerLike = { register: route => { handlers.set(route.path, route.handler) } }
  registerRoutes(server, account as Account)
  const call = async (path: string, options: { header?: boolean; body?: string; origin?: string } = {}) => {
    const handler = handlers.get(path)
    assert.ok(handler, path)
    let status = 200
    let payload = ''
    const res = {
      setHeader: () => res,
      end: (value: string) => { payload = value },
      get statusCode() { return status },
      set statusCode(value: number) { status = value },
    } as unknown as ServerResponse
    const headers: Record<string, string> = options.header === false ? {} : { 'x-agent-wechat-request': '1', host: 'localhost:3082' }
    if (options.origin) headers.origin = options.origin
    const req = {
      headers,
      async *[Symbol.asyncIterator]() { if (options.body) yield Buffer.from(options.body) },
    }
    await handler(req as unknown as IncomingMessage, res)
    return { status, json: payload ? JSON.parse(payload) : {} }
  }
  return { handlers, call }
}

const stub = {
  status: () => ({ loggedIn: false, polling: false, login: { phase: 'waiting' } }),
  qr: () => ({ phase: 'waiting', qrUrl: 'https://qr.test/x' }),
  submitVerifyCode: (code: string) => code === '123456',
  relogin: () => {},
  logout: () => {},
} as unknown as Account

test('requests without the request header are refused', async () => {
  const { call } = harness(stub)
  assert.equal((await call('/agent-wechat/api/status', { header: false })).status, 403)
})

test('status is served to the settings page', async () => {
  const { call } = harness(stub)
  const result = await call('/agent-wechat/api/status')
  assert.equal(result.status, 200)
  assert.equal(result.json.loggedIn, false)
})

test('the QR route encodes the login URL into SVG', async () => {
  const { call } = harness(stub)
  const result = await call('/agent-wechat/api/qr')
  assert.match(String(result.json.svg), /^<svg/)
})

test('verify-code accepts digits and rejects empty input', async () => {
  const { call } = harness(stub)
  assert.equal((await call('/agent-wechat/api/verify-code', { body: '{"code":"123456"}' })).status, 200)
  assert.equal((await call('/agent-wechat/api/verify-code', { body: '{"code":"abc"}' })).status, 400)
})

test('an Origin from another site is refused even with the request header', async () => {
  const { call } = harness(stub)
  assert.equal((await call('/agent-wechat/api/status', { origin: 'http://evil.test' })).status, 403)
  assert.equal((await call('/agent-wechat/api/status', { origin: 'http://localhost:3082' })).status, 200)
})

test('a body over 4 KB or malformed JSON is a 400, not a crash', async () => {
  const { call } = harness(stub)
  const oversized = JSON.stringify({ code: '1'.repeat(5000) })
  assert.equal((await call('/agent-wechat/api/verify-code', { body: oversized })).status, 400)
  assert.equal((await call('/agent-wechat/api/verify-code', { body: '{"code":' })).status, 400)
  const arrayBody = await call('/agent-wechat/api/verify-code', { body: '[1,2]' })
  assert.equal(arrayBody.status, 400)
  // Without the object-shape guard this would be parsed, `code` would be
  // missing, and the message would be the "enter the digits" one instead.
  assert.match(String(arrayBody.json.message), /JSON 对象/)
})

test('only the five settings routes are registered', () => {
  const { handlers } = harness(stub)
  assert.deepEqual([...handlers.keys()].sort(), [
    '/agent-wechat/api/logout',
    '/agent-wechat/api/qr',
    '/agent-wechat/api/relogin',
    '/agent-wechat/api/status',
    '/agent-wechat/api/verify-code',
  ])
})

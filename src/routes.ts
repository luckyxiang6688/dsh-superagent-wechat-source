/** Settings-page HTTP API: login status, QR, PIN, relogin, logout. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Account } from './account.ts'
import { qrSvgFor } from './qr.ts'

export interface WebServerLike {
  register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => unknown }): unknown
}

const HEADER = 'x-agent-wechat-request'

/** Allows the local settings page only: an explicit request header and a same-origin Origin when present. */
function sameOrigin(req: IncomingMessage): boolean {
  if (req.headers[HEADER] !== '1') return false
  const origin = req.headers.origin
  return origin === undefined || origin === `http://${req.headers.host}`
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(value))
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 4096) throw new Error('请求体过大')
    chunks.push(buffer)
  }
  if (!size) return {}
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请求体必须是 JSON 对象')
  return parsed as Record<string, unknown>
}

export function registerRoutes(server: WebServerLike, account: Account): void {
  server.register({
    kind: 'exact',
    path: '/agent-wechat/api/status',
    handler: (req, res) => {
      if (!sameOrigin(req)) return sendJson(res, 403, { ok: false })
      sendJson(res, 200, { ok: true, ...account.status() })
    },
  })

  server.register({
    kind: 'exact',
    path: '/agent-wechat/api/qr',
    handler: (req, res) => {
      if (!sameOrigin(req)) return sendJson(res, 403, { ok: false })
      const state = account.qr()
      let svg = ''
      if (state.qrUrl) {
        try { svg = qrSvgFor(state.qrUrl) }
        catch { svg = '' }
      }
      sendJson(res, 200, { ok: true, ...state, svg })
    },
  })

  server.register({
    kind: 'exact',
    path: '/agent-wechat/api/verify-code',
    handler: async (req, res) => {
      if (!sameOrigin(req)) return sendJson(res, 403, { ok: false })
      try {
        const body = await readJson(req)
        const code = typeof body.code === 'string' ? body.code.replace(/\D/g, '') : ''
        if (!code) return sendJson(res, 400, { ok: false, message: '请输入手机上显示的数字' })
        const accepted = account.submitVerifyCode(code)
        sendJson(res, accepted ? 200 : 409, { ok: accepted, message: accepted ? '已提交，等待确认' : '当前不需要输入数字' })
      } catch (error) {
        sendJson(res, 400, { ok: false, message: String(error).slice(0, 200) })
      }
    },
  })

  server.register({
    kind: 'exact',
    path: '/agent-wechat/api/relogin',
    handler: (req, res) => {
      if (!sameOrigin(req)) return sendJson(res, 403, { ok: false })
      account.relogin()
      sendJson(res, 200, { ok: true })
    },
  })

  server.register({
    kind: 'exact',
    path: '/agent-wechat/api/logout',
    handler: (req, res) => {
      if (!sameOrigin(req)) return sendJson(res, 403, { ok: false })
      account.logout()
      sendJson(res, 200, { ok: true })
    },
  })
}

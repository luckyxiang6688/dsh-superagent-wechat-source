/**
 * QR login state machine.
 *
 * States and transitions follow Tencent/openclaw-weixin's protocol docs:
 * wait / scaned / confirmed / expired / scaned_but_redirect /
 * need_verifycode / verify_code_blocked / binded_redirect.
 * Only the self-bind path is implemented (no `bot_spam_ticket`, no real-name CGI).
 */
import { getBotQrcode, getQrcodeStatus, QR_BASE_URL } from './ilink/api.ts'
import type { TokenData } from './store.ts'

export type LoginPhase = 'idle' | 'waiting' | 'scanned' | 'need_verifycode' | 'confirmed' | 'expired' | 'error' | 'already_bound'

export interface LoginState {
  phase: LoginPhase
  qrUrl?: string
  startedAt?: string
  expiresAt?: string
  error?: string
}

export interface LoginOptions {
  /** Tokens this client already holds; lets the server answer `binded_redirect`. */
  localTokenList: () => string[]
  onConfirmed: (token: TokenData) => void
  fetchImpl?: typeof fetch
  log?: (line: string) => void
}

const LOGIN_TIMEOUT_MS = 5 * 60_000
const MAX_QR_REFRESH = 3
const CODE_WAIT_MS = 25_000

const wait = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

export class LoginSession {
  private controller: AbortController | undefined
  private running: Promise<void> | undefined
  private current: LoginState = { phase: 'idle' }
  private pendingCode: string | undefined
  private codeWaiter: (() => void) | undefined

  private readonly options: LoginOptions

  constructor(options: LoginOptions) {
    this.options = options
  }

  state(): LoginState { return { ...this.current } }

  /** Starts the flow unless it is already running. `restart()` stops first. */
  start(): void {
    if (this.running) return
    this.controller = new AbortController()
    this.running = this.loop(this.controller.signal).finally(() => { this.running = undefined; this.controller = undefined })
  }

  stop(): void {
    this.controller?.abort()
    this.codeWaiter?.()
  }

  /** Supplies the phone PIN; returns false when the flow is not asking for one. */
  submitCode(code: string): boolean {
    if (this.current.phase !== 'need_verifycode') return false
    this.pendingCode = code.trim()
    const waiter = this.codeWaiter
    this.codeWaiter = undefined
    waiter?.()
    return true
  }

  private async waitForCode(signal: AbortSignal): Promise<void> {
    if (this.pendingCode || signal.aborted) return
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { this.codeWaiter = undefined; resolve() }, CODE_WAIT_MS)
      this.codeWaiter = () => { clearTimeout(timer); this.codeWaiter = undefined; resolve() }
      signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
    })
  }

  private async loop(signal: AbortSignal): Promise<void> {
    const startedAt = new Date()
    const deadline = startedAt.getTime() + LOGIN_TIMEOUT_MS
    let refreshCount = 0
    let baseUrl = QR_BASE_URL

    while (!signal.aborted && Date.now() < deadline) {
      let qrcode: string
      try {
        const response = await getBotQrcode({
          baseUrl: QR_BASE_URL,
          localTokenList: this.options.localTokenList(),
          fetchImpl: this.options.fetchImpl,
          signal,
        })
        qrcode = response.qrcode
        baseUrl = QR_BASE_URL
        this.current = { phase: 'waiting', qrUrl: response.qrcode_img_content, startedAt: startedAt.toISOString(), expiresAt: new Date(deadline).toISOString() }
      } catch (error) {
        if (signal.aborted) return
        this.current = { phase: 'error', error: `获取二维码失败：${String(error).slice(0, 300)}`, startedAt: startedAt.toISOString() }
        return
      }

      let refresh = false
      while (!signal.aborted && Date.now() < deadline) {
        if (this.current.phase === 'need_verifycode') await this.waitForCode(signal)
        if (signal.aborted) return
        const verifyCode = this.pendingCode
        let status
        try {
          status = await getQrcodeStatus({ baseUrl, qrcode, ...(verifyCode ? { verifyCode } : {}), fetchImpl: this.options.fetchImpl, signal })
        } catch (error) {
          if (signal.aborted) return
          this.current = { ...this.current, phase: 'error', error: `查询扫码状态失败：${String(error).slice(0, 300)}` }
          return
        }
        if (signal.aborted) return

        const value = String(status.status ?? '')
        if (value.includes('need_verifycode')) {
          this.pendingCode = undefined
          this.current = { ...this.current, phase: 'need_verifycode' }
          continue
        }
        if (value === 'scaned') {
          if (verifyCode) this.pendingCode = undefined
          this.current = { ...this.current, phase: 'scanned' }
          continue
        }
        if (value === 'confirmed') {
          if (typeof status.bot_token !== 'string' || !status.bot_token) {
            this.current = { ...this.current, phase: 'error', error: '登录已确认，但服务端没有返回 bot_token' }
            return
          }
          const token: TokenData = {
            token: status.bot_token,
            baseUrl: status.baseurl || baseUrl,
            accountId: String(status.ilink_bot_id ?? ''),
            userId: String(status.ilink_user_id ?? ''),
            savedAt: new Date().toISOString(),
          }
          this.current = { phase: 'confirmed' }
          this.options.onConfirmed(token)
          return
        }
        if (value === 'scaned_but_redirect') {
          if (status.redirect_host) baseUrl = `https://${status.redirect_host}`
          continue
        }
        if (value === 'binded_redirect') {
          this.current = { ...this.current, phase: 'already_bound', error: '这个微信号已经绑定到另一个客户端；请先停用那边，或换一个微信号' }
          return
        }
        if (value === 'expired' || value === 'verify_code_blocked') {
          refreshCount += 1
          this.pendingCode = undefined
          if (refreshCount > MAX_QR_REFRESH) {
            this.current = { ...this.current, phase: 'expired', error: '二维码多次失效，请稍后再试' }
            return
          }
          refresh = true
          break
        }
        // `wait` and unknown statuses: keep long-polling.
      }
      if (!refresh) {
        if (!signal.aborted) this.current = { ...this.current, phase: 'expired', error: '登录超时，请重新获取二维码' }
        return
      }
      if (Date.now() >= deadline) {
        this.current = { ...this.current, phase: 'expired', error: '登录超时，请重新获取二维码' }
        return
      }
      await wait(500)
    }
    if (!signal.aborted) this.current = { phase: 'expired', error: '登录超时，请重新获取二维码' }
  }
}

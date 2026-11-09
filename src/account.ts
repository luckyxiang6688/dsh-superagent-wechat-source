/** Owns the bot account: QR login, long-poll receive, outbound send, durable state. */
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import type { Trigger } from './contract.ts'
import { getUpdates, notifyStart, notifyStop, sendMessage, textMessage } from './ilink/api.ts'
import type { WeixinMessage } from './ilink/types.ts'
import { LoginSession, type LoginState } from './login.ts'
import { Store, type StoredMessage, type TokenData } from './store.ts'
import { splitText } from './text.ts'
import { textOf, toTrigger } from './trigger.ts'

export interface AccountDeps {
  stateDir: string
  historyLimit: number
  fetchImpl?: typeof fetch
  receive: (trigger: Trigger) => unknown
  report: (state: 'starting' | 'ready' | 'paused' | 'error', detail: string) => void
  log?: (line: string) => void
}

export interface WechatBridgeAccount {
  path: string
  userId?: string
}

/**
 * Reads whether dsh-wechat already logged this machine in. One WeChat account
 * can be bound to only one bot client, so an existing dsh-wechat login means a
 * second binding will very likely be refused.
 */
export function dshWechatAccount(home = homedir()): WechatBridgeAccount | undefined {
  const path = join(home, '.dsh-wechat', 'auth', 'token.json')
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { userId?: unknown }
    return { path, ...(typeof parsed.userId === 'string' && parsed.userId ? { userId: parsed.userId } : {}) }
  } catch {
    return undefined
  }
}

export interface AccountStatus {
  loggedIn: boolean
  botId?: string
  userId?: string
  polling: boolean
  lastPollAt?: string
  error?: string
  login: LoginState
  conflict?: { path: string; userId?: string; sameAccount: boolean }
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise(resolve => {
  const timer = setTimeout(done, ms)
  function done(): void { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
  signal.addEventListener('abort', done, { once: true })
})

export class Account {
  private readonly store: Store
  private readonly login: LoginSession
  private monitor: AbortController | undefined
  private polling = false
  private lastPollAt: string | undefined
  private error: string | undefined

  private readonly deps: AccountDeps

  constructor(deps: AccountDeps) {
    this.deps = deps
    this.store = new Store(deps.stateDir, deps.historyLimit)
    this.login = new LoginSession({
      localTokenList: () => (this.store.token ? [this.store.token.token] : []),
      onConfirmed: token => {
        this.store.saveToken(token)
        this.error = undefined
        this.startMonitor()
      },
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.log ? { log: deps.log } : {}),
    })
  }

  start(): void {
    if (this.store.token) this.startMonitor()
    else {
      this.login.start()
      this.deps.report('paused', '等待扫码登录')
    }
  }

  stop(): void {
    this.login.stop()
    this.monitor?.abort()
  }

  status(): AccountStatus {
    const token = this.store.token
    const bridge = dshWechatAccount()
    return {
      loggedIn: !!token,
      ...(token ? { botId: token.accountId, userId: token.userId } : {}),
      polling: this.polling,
      ...(this.lastPollAt ? { lastPollAt: this.lastPollAt } : {}),
      ...(this.error ? { error: this.error } : {}),
      login: this.login.state(),
      ...(bridge ? { conflict: { path: bridge.path, ...(bridge.userId ? { userId: bridge.userId } : {}), sameAccount: !!token && bridge.userId === token.userId } } : {}),
    }
  }

  /** Returns a login QR, starting the flow on first request. */
  qr(): LoginState {
    if (!this.store.token) {
      const phase = this.login.state().phase
      if (phase === 'idle' || phase === 'expired' || phase === 'error' || phase === 'already_bound') this.login.start()
    }
    return this.login.state()
  }

  submitVerifyCode(code: string): boolean { return this.login.submitCode(code) }

  relogin(): void {
    this.monitor?.abort()
    this.monitor = undefined
    this.polling = false
    this.store.clearToken()
    this.login.stop()
    this.login.start()
  }

  logout(): void {
    this.monitor?.abort()
    this.monitor = undefined
    this.polling = false
    this.store.clearToken()
    this.login.stop()
    this.deps.report('paused', '已退出登录')
  }

  history(user: string, limit: number): StoredMessage[] { return this.store.history(user, limit) }

  /** Sends one text reply; throws when a later retry may succeed. */
  async sendText(user: string, text: string, messageId: string): Promise<'sent' | 'gone'> {
    const token = this.store.token
    if (!token) throw new Error('微信未登录')
    const outbound = this.store.outboundOf(user)
    if (!outbound.contextToken) throw new Error('缺少 context_token：需要该用户先发一条消息')
    const chunks = splitText(text)
    if (!chunks.length) throw new Error('回复内容为空')
    if (outbound.count + chunks.length > 10) throw new Error('微信连发上限（10 条）将超出：等该用户发一条消息后再发送')
    for (const [index, chunk] of chunks.entries()) {
      // Deterministic per chunk, so an Outbox retry re-sends identical client_ids.
      const clientId = `dsh-${createHash('sha1').update(`${messageId}#${index}`).digest('hex').slice(0, 32)}`
      await sendMessage({
        baseUrl: token.baseUrl,
        token: token.token,
        body: textMessage({ to: user, text: chunk, clientId, contextToken: outbound.contextToken }),
        ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
      })
      this.store.noteOutbound(user)
    }
    return 'sent'
  }

  private startMonitor(): void {
    const token = this.store.token
    if (!token || this.monitor) return
    const controller = new AbortController()
    this.monitor = controller
    this.polling = true
    this.deps.report('starting', '正在接收微信消息')
    void this.monitorLoop(token, controller.signal).finally(() => {
      this.polling = false
      if (this.monitor === controller) this.monitor = undefined
    })
  }

  private async monitorLoop(token: TokenData, signal: AbortSignal): Promise<void> {
    const api = () => ({ baseUrl: token.baseUrl, token: token.token, signal, ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}) })
    try { await notifyStart(api()) }
    catch { /* lifecycle notice is advisory */ }

    let failures = 0
    let backoff = 5_000
    try {
      while (!signal.aborted) {
        try {
          const response = await getUpdates({ ...api(), getUpdatesBuf: this.store.cursor })
          if (signal.aborted) return
          if (response.errcode === -14 || response.ret === -14) {
            this.deps.report('paused', '会话已失效：暂停一小时后再试')
            await sleep(60 * 60_000, signal)
            try { await notifyStart(api()) } catch { /* retried on the next poll */ }
            continue
          }
          if (response.ret && response.ret !== 0) throw new Error(`getUpdates ret=${response.ret} errmsg=${response.errmsg ?? ''}`)
          failures = 0
          backoff = 5_000
          this.lastPollAt = new Date().toISOString()
          if (response.get_updates_buf) this.store.saveCursor(response.get_updates_buf)
          for (const message of response.msgs ?? []) this.ingest(message)
          this.deps.report('ready', '正在接收微信消息')
        } catch (error) {
          if (signal.aborted) return
          failures += 1
          this.error = String(error).slice(0, 300)
          this.deps.report('error', `轮询失败 ${failures} 次：${this.error}`)
          await sleep(backoff, signal)
          backoff = Math.min(backoff * 2, 60_000)
        }
      }
    } finally {
      try { await notifyStop(api()) } catch { /* best effort */ }
    }
  }

  /** Records one inbound message and hands its Trigger to the host. */
  ingest(message: WeixinMessage): void {
    if (message.group_id || !message.from_user_id) return
    // Any inbound message resets the consecutive-send budget.
    this.store.noteInbound(message.from_user_id, message.context_token)
    const text = textOf(message)
    if (text === undefined) return
    const trigger = toTrigger(message)
    if (!trigger) return
    this.store.appendMessage({
      id: `${message.from_user_id}:${String(message.message_id ?? message.client_id ?? message.seq ?? '')}`,
      messageId: String(message.message_id ?? ''),
      user: message.from_user_id,
      at: trigger.at,
      text,
    })
    try { this.deps.receive(trigger) }
    catch (error) { this.deps.log?.(`receive failed: ${String(error).slice(0, 200)}`) }
  }
}

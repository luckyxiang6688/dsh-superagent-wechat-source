/** Durable account state: bot token, poll cursor, message ring, outbound counters. */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface TokenData {
  token: string
  baseUrl: string
  /** `ilink_bot_id` */
  accountId: string
  /** `ilink_user_id` — the WeChat user who scanned the QR. */
  userId: string
  savedAt: string
}

export interface StoredMessage {
  /** Trigger-shaped message id: `<from_user_id>:<message_id>`. */
  id: string
  messageId: string
  user: string
  at: string
  text: string
  bot?: true
}

export interface OutboundState {
  /** Consecutive bot messages since the user last spoke; the gateway allows 10. */
  count: number
  /** Latest inbound `context_token`; a reply must carry it. */
  contextToken?: string
}

const privateDir = (path: string): void => { mkdirSync(path, { recursive: true, mode: 0o700 }) }

/** Atomic 0600 write; the temp file never holds a token in a world-readable place. */
function writePrivate(path: string, value: unknown): void {
  privateDir(dirname(path))
  const temp = `${path}.tmp`
  writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 })
  chmodSync(temp, 0o600)
  renameSync(temp, path)
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined
  try { return JSON.parse(readFileSync(path, 'utf-8')) as T }
  catch { return undefined }
}

export class Store {
  readonly root: string
  private tokenData: TokenData | undefined
  private buffer = ''
  private messages: StoredMessage[] = []
  private outbound: Record<string, OutboundState> = {}

  private readonly historyLimit: number

  constructor(stateDir: string, historyLimit: number) {
    this.historyLimit = historyLimit
    this.root = join(stateDir, 'sources', 'wechat')
    privateDir(this.root)
    const stored = readJson<TokenData>(join(this.root, 'auth', 'token.json'))
    this.tokenData = stored && typeof stored.token === 'string' && stored.token ? stored : undefined
    this.buffer = readJson<{ buffer: string }>(join(this.root, 'sync-buf.json'))?.buffer ?? ''
    this.messages = readJson<StoredMessage[]>(join(this.root, 'messages.json')) ?? []
    this.outbound = readJson<Record<string, OutboundState>>(join(this.root, 'outbound.json')) ?? {}
  }

  get token(): TokenData | undefined { return this.tokenData }

  saveToken(token: TokenData): void {
    this.tokenData = token
    writePrivate(join(this.root, 'auth', 'token.json'), token)
  }

  clearToken(): void {
    this.tokenData = undefined
    writePrivate(join(this.root, 'auth', 'token.json'), {})
  }

  get cursor(): string { return this.buffer }

  saveCursor(buffer: string): void {
    if (buffer === this.buffer) return
    this.buffer = buffer
    writePrivate(join(this.root, 'sync-buf.json'), { buffer })
  }

  /** Appends one inbound message, keeping the newest `historyLimit` entries. */
  appendMessage(message: StoredMessage): void {
    this.messages = [...this.messages, message].slice(-this.historyLimit)
    writePrivate(join(this.root, 'messages.json'), this.messages)
  }

  history(user: string, limit = this.historyLimit): StoredMessage[] {
    return this.messages.filter(message => message.user === user).slice(-limit)
  }

  outboundOf(user: string): OutboundState {
    return this.outbound[user] ?? { count: 0 }
  }

  /** A user message resets the consecutive-send counter and refreshes the reply token. */
  noteInbound(user: string, contextToken: string | undefined): void {
    const previous = this.outbound[user]
    this.outbound[user] = { count: 0, ...(contextToken ? { contextToken } : previous?.contextToken ? { contextToken: previous.contextToken } : {}) }
    writePrivate(join(this.root, 'outbound.json'), this.outbound)
  }

  noteOutbound(user: string): void {
    const previous = this.outboundOf(user)
    this.outbound[user] = { ...previous, count: previous.count + 1 }
    writePrivate(join(this.root, 'outbound.json'), this.outbound)
  }
}

/**
 * Minimal iLink HTTP client: headers, long-poll receive, text send, lifecycle.
 *
 * Implemented from the protocol documented by Tencent/openclaw-weixin (MIT,
 * Copyright (C) 2026 Tencent). See docs/protocol_zh_CN.md upstream; no upstream
 * source file was copied.
 */
import { randomBytes } from 'node:crypto'
import type { BaseInfo, GetUpdatesResp, QrStatusResp, SendMessageReq, SendMessageResp, WeixinMessage } from './types.ts'

export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
/** Fixed host for QR requests, as documented upstream. */
export const QR_BASE_URL = DEFAULT_BASE_URL
export const ILINK_APP_ID = 'bot'

/**
 * `channel_version` is parsed as major.minor.patch and must be the official
 * generation (3.x). Our own marker lives in the suffix.
 */
export const CHANNEL_VERSION = '3.0.0/dsh-superagent-wechat-0.1.0'
export const BOT_AGENT = 'DSHSuperagentWechat/0.1.0'

/** `iLink-App-ClientVersion`: 0x00MMNNPP of the leading official version. */
export function clientVersionOf(version: string): number {
  const parts = version.split('/')[0]!.split('.').map(part => Number.parseInt(part, 10))
  const [major = 0, minor = 0, patch = 0] = parts
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff)
}

export const ILINK_APP_CLIENT_VERSION = clientVersionOf(CHANNEL_VERSION)

export interface ApiOptions {
  baseUrl: string
  token?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  signal?: AbortSignal
  baseInfo?: BaseInfo
}

const DEFAULT_API_TIMEOUT_MS = 15_000
export const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000

function buildCommonHeaders(): Record<string, string> {
  return { 'iLink-App-Id': ILINK_APP_ID, 'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION) }
}

/** X-WECHAT-UIN: a random uint32 rendered as a decimal string, then base64. */
function randomWechatUin(): string {
  return Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf-8').toString('base64')
}

function buildPostHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
    ...buildCommonHeaders(),
  }
  if (token?.trim()) headers.Authorization = `Bearer ${token.trim()}`
  return headers
}

async function request(
  method: 'GET' | 'POST',
  url: string,
  init: { headers: Record<string, string>; body?: string; timeoutMs: number; signal?: AbortSignal; fetchImpl?: typeof fetch },
): Promise<string> {
  const fetchImpl = init.fetchImpl ?? fetch
  const timeout = AbortSignal.timeout(init.timeoutMs)
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
  const response = await fetchImpl(url, { method, headers: init.headers, body: init.body, signal })
  const text = await response.text()
  if (!response.ok) throw new Error(`${method} ${url} -> HTTP ${response.status}: ${text.slice(0, 300)}`)
  return text
}

const join = (baseUrl: string, endpoint: string): string => `${baseUrl.replace(/\/+$/, '')}/${endpoint.replace(/^\/+/, '')}`

/**
 * JSON.parse, but uint64 identifiers that arrive as bare numbers are quoted
 * first so `message_id` does not lose precision.
 */
export function parseLossless<T>(raw: string): T {
  const quoted = raw.replace(/("(?:message_id|msg_id|svr_id)"\s*:\s*)(-?\d{16,})/g, '$1"$2"')
  return JSON.parse(quoted) as T
}

/** `POST ilink/bot/get_bot_qrcode?bot_type=3` — a new bind QR for the self-bind path. */
export async function getBotQrcode(options: ApiOptions & { botType?: string; localTokenList?: string[]; baseInfo?: BaseInfo }): Promise<{ qrcode: string; qrcode_img_content: string }> {
  const botType = options.botType ?? '3'
  const raw = await request('POST', join(options.baseUrl, `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`), {
    headers: buildPostHeaders(),
    body: JSON.stringify({ local_token_list: options.localTokenList ?? [] }),
    timeoutMs: options.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
  })
  return JSON.parse(raw) as { qrcode: string; qrcode_img_content: string }
}

/** `GET ilink/bot/get_qrcode_status` — a 35-second long poll of the bind QR state. */
export async function getQrcodeStatus(options: ApiOptions & { qrcode: string; verifyCode?: string }): Promise<QrStatusResp> {
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(options.qrcode)}`
  if (options.verifyCode) endpoint += `&verify_code=${encodeURIComponent(options.verifyCode)}`
  try {
    const raw = await request('GET', join(options.baseUrl, endpoint), {
      headers: buildCommonHeaders(),
      timeoutMs: options.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS,
      signal: options.signal,
      fetchImpl: options.fetchImpl,
    })
    return JSON.parse(raw) as QrStatusResp
  } catch (error) {
    // Timeout, cancellation, or a gateway hiccup all mean "keep polling".
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) return { status: 'wait' }
    if (String(error).includes('HTTP 5')) return { status: 'wait' }
    throw error
  }
}

function baseInfoOf(options: ApiOptions): BaseInfo {
  return options.baseInfo ?? { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT }
}

/** `POST ilink/bot/getupdates` — long poll. Returns an empty page on timeout. */
export async function getUpdates(options: ApiOptions & { getUpdatesBuf: string; timeoutMs?: number }): Promise<GetUpdatesResp> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS
  try {
    const raw = await request('POST', join(options.baseUrl, 'ilink/bot/getupdates'), {
      headers: buildPostHeaders(options.token),
      body: JSON.stringify({ get_updates_buf: options.getUpdatesBuf ?? '', base_info: baseInfoOf(options) }),
      timeoutMs,
      signal: options.signal,
      fetchImpl: options.fetchImpl,
    })
    return parseLossless<GetUpdatesResp>(raw)
  } catch (error) {
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      // A long poll with no traffic ends this way in normal operation, but it
      // is not evidence that the connection works: mark it so the caller does
      // not mistake "no answer" for "answered empty".
      return { ret: 0, msgs: [], get_updates_buf: options.getUpdatesBuf, timedOut: true }
    }
    throw error
  }
}

/** `POST ilink/bot/sendmessage` — one text message. Throws on a non-zero `ret`. */
export async function sendMessage(options: ApiOptions & { body: SendMessageReq }): Promise<SendMessageResp> {
  const raw = await request('POST', join(options.baseUrl, 'ilink/bot/sendmessage'), {
    headers: buildPostHeaders(options.token),
    body: JSON.stringify({ ...options.body, base_info: baseInfoOf(options) }),
    timeoutMs: options.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
  })
  const response = parseLossless<SendMessageResp>(raw)
  if (response.ret && response.ret !== 0) throw new Error(`sendMessage ret=${response.ret} errmsg=${response.errmsg ?? '(none)'}`)
  return response
}

async function lifecycle(options: ApiOptions, verb: 'notifystart' | 'notifystop'): Promise<void> {
  await request('POST', join(options.baseUrl, `ilink/bot/msg/${verb}`), {
    headers: buildPostHeaders(options.token),
    body: JSON.stringify({ base_info: baseInfoOf(options) }),
    timeoutMs: options.timeoutMs ?? 10_000,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
  })
}

export const notifyStart = (options: ApiOptions): Promise<void> => lifecycle(options, 'notifystart')
export const notifyStop = (options: ApiOptions): Promise<void> => lifecycle(options, 'notifystop')

/** Builds the outbound text message body shared by every reply. */
export function textMessage(input: { to: string; text: string; clientId: string; contextToken?: string }): SendMessageReq {
  return {
    msg: {
      from_user_id: '',
      to_user_id: input.to,
      client_id: input.clientId,
      message_type: 2,
      message_state: 2,
      item_list: input.text ? [{ type: 1, text_item: { text: input.text } }] : undefined,
      ...(input.contextToken ? { context_token: input.contextToken } : {}),
    } as WeixinMessage,
  }
}

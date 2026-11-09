/**
 * iLink (WeChat ClawBot) wire types used by this plugin.
 *
 * Protocol source: Tencent/openclaw-weixin (MIT, Copyright (C) 2026 Tencent),
 * docs/protocol_zh_CN.md and src/api/types.ts. Only the text/DM subset this
 * plugin needs is declared here; media, quoting and typing are out of scope.
 */

/** Common metadata attached to every CGI request. */
export interface BaseInfo {
  /** Must start with the official 3.x version; our own marker goes in the suffix. */
  channel_version: string
  /** Observability only; not used for auth or routing. */
  bot_agent?: string
}

export const MessageType = { NONE: 0, USER: 1, BOT: 2 } as const
export const MessageItemType = { NONE: 0, TEXT: 1 } as const
export const MessageState = { NEW: 0, GENERATING: 1, FINISH: 2 } as const

export interface TextItem {
  text?: string
}

/** Only the item kinds this plugin consumes; unknown kinds are ignored. */
export interface MessageItem {
  type?: number
  create_time_ms?: number
  msg_id?: string
  text_item?: TextItem
}

/** Inbound message (proto: WeixinMessage). `message_id` is a uint64 parsed as a string. */
export interface WeixinMessage {
  seq?: number
  message_id?: string
  from_user_id?: string
  to_user_id?: string
  client_id?: string
  create_time_ms?: number
  session_id?: string
  /** Present on group messages; this plugin drops those. */
  group_id?: string
  message_type?: number
  message_state?: number
  item_list?: MessageItem[]
  context_token?: string
  run_id?: string
}

export interface GetUpdatesResp {
  ret?: number
  /** -14 means the server-side session expired; the client pauses for an hour. */
  errcode?: number
  errmsg?: string
  msgs?: WeixinMessage[]
  get_updates_buf?: string
  longpolling_timeout_ms?: number
}

export interface SendMessageReq {
  msg?: WeixinMessage
}

export interface SendMessageResp {
  message_id?: string
  ret?: number
  errmsg?: string
}

export type QrStatus =
  | 'wait'
  | 'scaned'
  | 'confirmed'
  | 'expired'
  | 'scaned_but_redirect'
  | 'need_verifycode'
  | 'confirmed_but_need_verifycode'
  | 'verify_code_blocked'
  | 'binded_redirect'

export interface QrStatusResp {
  status: QrStatus | string
  bot_token?: string
  ilink_bot_id?: string
  baseurl?: string
  ilink_user_id?: string
  redirect_host?: string
}

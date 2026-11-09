/** Normalizes an inbound iLink message into a dsh-superagent Trigger. */
import type { Trigger } from './contract.ts'
import { MessageItemType, type WeixinMessage } from './ilink/types.ts'

export const SOURCE = 'wechat'

/**
 * `/task` at the start of a DM creates work. Everything else is recorded but
 * filtered (scope returns `no_task_prefix`), so the trace shows the drop.
 */
export const TASK_PREFIX = /^\/task(?:[\s：:，,]+|$)/i

export const threadOf = (user: string): string => `${SOURCE}:${user}`

/** The first text item of a message, or undefined for media-only messages. */
export function textOf(message: WeixinMessage): string | undefined {
  for (const item of message.item_list ?? []) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) return String(item.text_item.text)
  }
  return undefined
}

/** Stable per-message key: the server message id, else the client id, else the sequence. */
function messageKey(message: WeixinMessage): string | undefined {
  const candidate = message.message_id ?? message.client_id ?? (message.seq !== undefined ? String(message.seq) : undefined)
  if (candidate && candidate !== '0') return candidate
  if (message.create_time_ms !== undefined) return `${message.create_time_ms}-${message.seq ?? 0}`
  return undefined
}

/**
 * Returns undefined for messages this Source must not ingest: group messages,
 * the bot's own output, messages without a sender, and media-only messages.
 */
export function toTrigger(message: WeixinMessage, now = Date.now()): Trigger | undefined {
  if (message.group_id) return undefined
  if (!message.from_user_id) return undefined
  if (message.message_type === 2) return undefined
  const key = messageKey(message)
  if (!key) return undefined
  const text = textOf(message)
  if (text === undefined) return undefined

  const match = TASK_PREFIX.exec(text)
  const body = match ? text.slice(match[0].length).trim() : text
  const user = message.from_user_id
  const thread = threadOf(user)
  const atMs = message.create_time_ms ?? now
  return {
    id: `${SOURCE}:${user}:${key}`,
    source: SOURCE,
    threads: [{ source: SOURCE, id: thread }],
    actor: { source: SOURCE, id: user },
    human: message.message_type === 1,
    ...(match ? { addressed: 'direct' as const } : {}),
    at: new Date(atMs).toISOString(),
    text: body,
    channel: { source: SOURCE, thread, address: { user } },
    meta: {
      messageId: message.message_id ?? key,
      ...(message.client_id ? { clientId: message.client_id } : {}),
      atMs,
      prefixMatched: match !== null,
    },
  }
}

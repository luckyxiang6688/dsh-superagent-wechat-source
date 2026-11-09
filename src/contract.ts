/**
 * Structural mirrors of the dsh-superagent Source contract.
 *
 * The plugin declares these shapes itself and never imports `@deepseek-ai/*`
 * at runtime, so it loads in a DSH host that does not expose those packages to
 * third-party plugins (the same approach dsh-wechat uses).
 */

export interface Localized {
  zh: string
  en: string
}

export interface ThreadRef {
  source: string
  id: string
}

export interface ActorRef {
  source: string
  id: string
}

export interface ChannelRef {
  source: string
  thread: string
  address: Record<string, string>
}

export interface Trigger {
  id: string
  source: string
  threads: ThreadRef[]
  actor: ActorRef
  human: boolean
  addressed?: 'mention' | 'direct'
  at: string
  text: string
  channel?: ChannelRef
  meta: Record<string, unknown>
}

export type ScopeResult = { listened: true; observed: boolean; row?: string } | { listened: false; reason: string }

export interface OutboundMessage {
  id: string
  channel: ChannelRef
  text: string
  kind: 'acknowledgement' | 'reply' | 'notice'
  ticketId?: string
}

export interface ContextMessage {
  id: string
  from: string
  at: string
  text: string
  bot?: true
}

export interface ContextPart {
  messages: ContextMessage[]
  next?: string | undefined
  body: Record<string, unknown>
  status?: string
}

export type ContextPartName = 'thread' | 'root' | 'parent'

/** Commands is passed through but not used by this Source's read paths. */
export type Commands = unknown

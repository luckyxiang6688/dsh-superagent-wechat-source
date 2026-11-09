/** The `wechat` SourceKind: config, listening scope, policy, channel, thread context. */
import { z } from 'zod'
import { currentAccount } from './runtime.ts'
import type { ContextPart, Localized, OutboundMessage, ScopeResult, Trigger } from './contract.ts'

export const SOURCE = 'wechat'

export const WechatConfigSchema = z.object({
  /** How many inbound messages the local ring keeps for thread context. */
  historyLimit: z.number().int().min(20).max(1000).default(200),
  /** Page size when an assessment reads the thread. */
  readPageSize: z.number().int().min(5).max(100).default(20),
}).strict()

export type WechatConfig = z.infer<typeof WechatConfigSchema>

const localized = (zh: string, en: string): Localized => ({ zh, en })

export const wechatKind = {
  kind: SOURCE,
  title: localized('微信私聊', 'WeChat DM'),
  description: localized(
    '接收你发给自己微信机器人的私聊；每条私聊都交给裁定判断是否建单，结果回帖到同一个对话。',
    'Receives DMs to your own WeChat bot; every DM is assessed for whether it opens a ticket, and results are posted back to the same chat.',
  ),
  schema: WechatConfigSchema,
  fields: [
    { key: 'historyLimit', type: 'number' as const, advanced: true as const, min: 20, max: 1000,
      label: localized('本地保留的消息数', 'Messages kept locally'),
      hint: localized('智能体读取线程上下文时最多回溯的条数。', 'How far back agents can read this thread.') },
    { key: 'readPageSize', type: 'number' as const, advanced: true as const, min: 5, max: 100,
      label: localized('每页消息数', 'Messages per page'),
      hint: localized('智能体读取线程时每页返回的条数。', 'Messages per page when agents read the thread.') },
  ],
  health: ['wechat'],

  /**
   * Every DM to the bot is listened to. The Trigger carries
   * `addressed: 'direct'`, so a listed sender's message is admitted as an
   * explicit request and the assessor decides whether it is work.
   */
  scope(_input: { meta: Record<string, unknown> }, _config?: WechatConfig): ScopeResult {
    return { listened: true, observed: false, row: 'direct' }
  },

  channel: {
    allowed: (address: Record<string, string>, _config?: WechatConfig): boolean => typeof address.user === 'string' && address.user.length > 0,
    async send(_host: unknown, message: OutboundMessage): Promise<'sent' | 'gone'> {
      const user = message.channel.address.user
      if (!user) throw new Error('缺少微信收件人')
      const account = currentAccount()
      if (!account) throw new Error('微信来源尚未初始化')
      return account.sendText(user, message.text, message.id)
    },
    link: (address: Record<string, string>): { url: string; label: Localized } => ({
      url: typeof address.user === 'string' && address.user ? `weixin://` : '',
      label: localized('微信私聊', 'WeChat DM'),
    }),
  },

  threadContext: {
    messageId: (trigger: Trigger): string => String(trigger.meta.messageId ?? trigger.id),
    async read(_commands: unknown, trigger: Trigger, part: 'thread' | 'root' | 'parent', cursor: string | undefined, config: WechatConfig): Promise<ContextPart> {
      if (part !== 'thread') {
        return { messages: [], body: {}, status: part === 'root' ? 'no_root' : 'no_parent' }
      }
      const account = currentAccount()
      const all = account?.history(trigger.actor.id, config.historyLimit) ?? []
      const offset = cursor ? Math.max(0, Number.parseInt(cursor, 10) || 0) : 0
      const page = all.slice(offset, offset + config.readPageSize)
      const next = offset + config.readPageSize < all.length ? String(offset + config.readPageSize) : undefined
      return {
        messages: page.map(message => ({ id: message.id, from: message.user, at: message.at, text: message.text })),
        ...(next ? { next } : {}),
        body: {},
      }
    },
    images: (): string[] => [],
  },

  policy: {
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().trim().min(1).max(128), name: z.string().trim().max(100).optional() }).strict())
        .refine(entries => new Set(entries.map(entry => entry.id)).size === entries.length, 'Duplicate user ids')
        .default([]),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows' as const, label: localized('能发起任务的微信用户', 'WeChat users who may originate work'),
        hint: localized('登录后设置页会显示你的 ilink_user_id，复制到这里。只有名单内的人的私聊会被裁定，名单外的一律忽略。',
          'After login the settings page shows your ilink_user_id; copy it here. Only listed users’ DMs are assessed; everyone else is ignored.'),
        columns: [
          { key: 'id', type: 'text' as const, label: localized('用户 ID', 'User ID') },
          { key: 'name', type: 'text' as const, label: localized('名字', 'Name'), optional: true },
        ] },
    ],
    explicit: localized('名单内的人私聊机器人，总是明确的请求；是否属于工作由接单规则判断。',
      'A listed user who DMs the bot always makes an explicit request; the accept rules decide whether it is work.'),
    unnamed: { person: localized('微信用户', 'WeChat user'), bot: localized('微信机器人', 'WeChat bot') },
    // No admission table: a DM is always addressed, and a listed sender who
    // addresses the agent is explicit before any table cell is consulted.
  },
}

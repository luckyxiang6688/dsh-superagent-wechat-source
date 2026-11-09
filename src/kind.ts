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
    '接收你发给自己微信机器人的私聊；以 /task 开头的消息建工单，结果回帖到同一个对话。',
    'Receives DMs to your own WeChat bot; a message starting with /task opens a ticket and the result is posted back to the same chat.',
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

  /** Only `/task …` is listened to; every other DM is recorded and filtered. */
  scope({ meta }: { meta: Record<string, unknown> }, _config?: WechatConfig): ScopeResult {
    return meta.prefixMatched === true
      ? { listened: true, observed: false, row: 'direct' }
      : { listened: false, reason: 'no_task_prefix' }
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
        hint: localized('登录后设置页会显示你的 ilink_user_id，复制到这里。只有名单内的人发 /task 才会建单。',
          'After login the settings page shows your ilink_user_id; copy it here. Only listed users create tickets with /task.'),
        columns: [
          { key: 'id', type: 'text' as const, label: localized('用户 ID', 'User ID') },
          { key: 'name', type: 'text' as const, label: localized('名字', 'Name'), optional: true },
        ] },
    ],
    explicit: localized('名单内的人私聊机器人并发 /task，总是明确的请求。', 'A listed user who DMs the bot with /task always makes an explicit request.'),
    unnamed: { person: localized('微信用户', 'WeChat user'), bot: localized('微信机器人', 'WeChat bot') },
    rows(_stored?: Record<string, unknown>) {
      return [{ id: 'direct', label: localized('私聊', 'Direct messages'), note: localized('仅 /task', '/task only'),
        cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: false } }]
    },
  },
}

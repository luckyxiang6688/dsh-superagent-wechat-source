/** Client entry: registers the WeChat panel under Settings. */
import type { ComponentType } from 'react'
import { Settings } from './Settings.tsx'

interface SlotsLike {
  inject(name: string, setup: () => unknown): unknown
  register(slot: Record<string, unknown>, component: ComponentType<never>): unknown
}

export const name = 'dsh-superagent-wechat-source'
export const inject = ['slots']

export function apply(ctx: { slots: SlotsLike; effect?: (work: () => unknown) => unknown }): void {
  const register = (): unknown => ctx.slots.inject('settings.section', () => ctx.slots.register(
    { name: 'settings.section', id: 'agent-wechat', order: 41, label: '微信任务' },
    Settings as unknown as ComponentType<never>,
  ))
  if (ctx.effect) ctx.effect(register)
  else register()
}

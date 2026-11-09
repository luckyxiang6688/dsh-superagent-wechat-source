/**
 * dsh-superagent-wechat-source — host plugin entry.
 *
 * Registers the `wechat` Source kind, starts the QR login or the long poll,
 * and serves the settings-page API. Runtime imports stay free of
 * `@deepseek-ai/*`: the host is reached through the `orchestrator` service.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Account } from './account.ts'
import { wechatKind } from './kind.ts'
import { registerRoutes, type WebServerLike } from './routes.ts'
import { setAccount } from './runtime.ts'

export const name = 'dsh-superagent-wechat-source'
export const inject = ['orchestrator']

interface SourceHostLike {
  sources: { register(kind: unknown): () => void }
  context(kind: { kind: string; health: readonly string[] }): {
    receive(trigger: unknown): unknown
    report(entry: string, value: { state: 'starting' | 'ready' | 'paused' | 'error'; detail: string }): void
  }
}

interface ContextLike {
  orchestrator: SourceHostLike
  effect(work: () => unknown): void
  inject(services: string[], callback: (child: { get(name: string): unknown }) => void): void
  logger?: { warn(message: string): void }
}

/** Where account state goes when the profile does not point at dsh-superagent's stateDir. */
export const DEFAULT_STATE_DIR = join(homedir(), '.dsh-superagent-wechat')

export interface PluginConfig {
  /** Account state lives under `<stateDir>/sources/wechat`; defaults to `DEFAULT_STATE_DIR`. */
  stateDir?: string
  historyLimit?: number
}

export function apply(ctx: ContextLike, config: PluginConfig = {}): void {
  const stateDir = typeof config.stateDir === 'string' && config.stateDir ? config.stateDir : DEFAULT_STATE_DIR
  const source = { kind: wechatKind.kind, health: wechatKind.health }
  const account = new Account({
    stateDir,
    historyLimit: typeof config.historyLimit === 'number' ? config.historyLimit : wechatKind.schema.parse({}).historyLimit,
    receive: trigger => ctx.orchestrator.context(source).receive(trigger),
    report: (state, detail) => {
      try { ctx.orchestrator.context(source).report('wechat', { state, detail }) }
      catch { /* the kind may be unregistered while shutting down */ }
    },
  })
  setAccount(account)

  ctx.effect(() => ctx.orchestrator.sources.register(wechatKind))
  ctx.effect(() => {
    account.start()
    return () => { account.stop(); setAccount(undefined) }
  })

  // The webServer service activates after `webStartup`; conditional inject
  // registers the routes once it exists (the login flow works without them).
  ctx.inject(['webServer'], child => {
    const server = child.get('webServer') as WebServerLike | undefined
    if (server) registerRoutes(server, account)
  })
}

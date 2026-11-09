import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { tempDir } from './helpers.ts'

/**
 * `apply()` is what a fresh install runs. These tests cover the two things the
 * module-level defaults decide: where state lands, and whether the settings
 * routes exist.
 */

const routes = [
  '/agent-wechat/api/logout',
  '/agent-wechat/api/qr',
  '/agent-wechat/api/relogin',
  '/agent-wechat/api/status',
  '/agent-wechat/api/verify-code',
]

test('a profile without stateDir lands under ~/.dsh-superagent-wechat', async () => {
  const home = tempDir()
  const previousHome = process.env.HOME
  // DEFAULT_STATE_DIR is computed at module load, so HOME must move first.
  process.env.HOME = home
  const previousFetch = globalThis.fetch
  // No network: a missing token starts the QR login, which must fail fast here.
  globalThis.fetch = (async () => { throw new Error('offline') }) as typeof fetch
  try {
    const { apply, DEFAULT_STATE_DIR, name, inject } = await import('../src/index.ts')
    assert.equal(name, 'dsh-superagent-wechat-source')
    assert.deepEqual(inject, ['orchestrator'])
    assert.equal(DEFAULT_STATE_DIR, join(home, '.dsh-superagent-wechat'))

    const registered: unknown[] = []
    const effects: Array<() => unknown> = []
    const ctx = {
      orchestrator: {
        sources: { register: (kind: unknown) => { registered.push(kind); return () => {} } },
        context: () => ({ receive: () => {}, report: () => {} }),
      },
      effect: (work: () => unknown) => { effects.push(work) },
      inject: () => {},
    }
    apply(ctx as never, {})

    assert.equal(effects.length, 2, 'one effect registers the kind, one starts the account')
    const disposers = effects.map(work => work())
    try {
      assert.equal(registered.length, 1)
      assert.ok(existsSync(join(home, '.dsh-superagent-wechat', 'sources', 'wechat')))
    } finally {
      for (const dispose of disposers) if (typeof dispose === 'function') dispose()
    }
  } finally {
    // Assigning undefined would store the literal string "undefined".
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    globalThis.fetch = previousFetch
  }
})

test('the settings routes are mounted when a web server is injected', async () => {
  const { apply } = await import('../src/index.ts')
  const registered: string[] = []
  const ctx = {
    orchestrator: {
      sources: { register: () => () => {} },
      context: () => ({ receive: () => {}, report: () => {} }),
    },
    effect: () => {},
    inject: (services: string[], callback: (child: { get(name: string): unknown }) => void) => {
      assert.deepEqual(services, ['webServer'])
      callback({ get: () => ({ register: (route: { path: string }) => { registered.push(route.path) } }) })
    },
  }
  apply(ctx as never, { stateDir: tempDir() })
  assert.deepEqual([...registered].sort(), routes)
})

test('an inject callback with no usable web server still applies', async () => {
  const { apply } = await import('../src/index.ts')
  const ctx = {
    orchestrator: {
      sources: { register: () => () => {} },
      context: () => ({ receive: () => {}, report: () => {} }),
    },
    effect: () => {},
    inject: (_services: string[], callback: (child: { get(name: string): unknown }) => void) => {
      callback({ get: () => undefined })
    },
  }
  assert.doesNotThrow(() => apply(ctx as never, { stateDir: tempDir() }))
})

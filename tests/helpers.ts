import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-wechat-source-'))
}

export function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

export interface Call { url: string; body: string }

/** A fetch that records every request and answers through `handler`. */
export function fakeFetch(handler: (call: Call, index: number) => unknown | Promise<unknown>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const body = typeof init?.body === 'string' ? init.body : ''
    const call = { url, body }
    calls.push(call)
    return jsonResponse(await handler(call, calls.length - 1))
  }) as typeof fetch
  return { fetch: impl, calls }
}

export async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out')
    await new Promise(resolve => { setTimeout(resolve, 10) })
  }
}

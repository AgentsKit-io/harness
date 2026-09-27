import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LoadedLoopConfig } from '../src/loop/config.js'
import type { IssueBoardCache } from '../src/ui/api/board.js'
import { snapshotErrorText, sseNeedsPolling } from '../src/ui/app/src/lib/api.js'
import { startUiServer, type UiServerHandle, type UiSnapshot } from '../src/ui/api/server.js'

const servers: UiServerHandle[] = []
const roots: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const server of servers.splice(0)) await server.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const loadedWith = (notifications: Record<string, unknown> | undefined): LoadedLoopConfig => {
  const root = mkdtempSync(join(tmpdir(), 'harness-ui-sse-')); roots.push(root)
  return { root, stateDir: join(root, '.ak-loop'), path: join(root, 'loop.config.yaml'), configHash: 'hash', unknownKeys: [], config: { project: { name: 'app', repo: 'acme/app', baseBranch: 'main' }, notifications } } as unknown as LoadedLoopConfig
}
const snapshotOf = (): UiSnapshot => ({
  schemaVersion: 1, generatedAt: new Date().toISOString(), project: { name: 'app', repo: 'acme/app', baseBranch: 'main', root: '/', stateDir: '/', configHash: 'h' },
  capacity: { maxAgents: 1, running: 0, free: 1 }, board: null, issues: [], automations: [],
})

/** Reads the SSE stream until the first complete message (blank-line terminated). */
const firstMessage = async (server: UiServerHandle): Promise<string> => {
  const controller = new AbortController()
  const response = await fetch(`${server.url}api/v1/events?session=${server.token}`, { signal: controller.signal })
  const reader = response.body!.getReader()
  let text = ''
  while (!text.includes('\n\n')) { const { value, done } = await reader.read(); if (done) break; text += new TextDecoder().decode(value) }
  controller.abort()
  return text
}

describe('SSE snapshot failures', () => {
  it('are sent as `snapshot-error`, never as `error` (which EventSource treats as a dropped connection)', async () => {
    const server = await startUiServer({ port: 0, snapshot: () => { throw new Error('orca exploded') } })
    servers.push(server)
    const message = await firstMessage(server)
    expect(message).toMatch(/^event: snapshot-error\n/)
    expect(message).not.toMatch(/^event: error\n/m)
    expect(snapshotErrorText(message.split('data: ')[1]!.trim())).toBe('orca exploded')
  })

  it('the client polls only when the source is not open, and shows the server error text', () => {
    // EventSource.CONNECTING = 0, OPEN = 1, CLOSED = 2.
    expect(sseNeedsPolling(1)).toBe(false)
    expect(sseNeedsPolling(0)).toBe(true)
    expect(sseNeedsPolling(2)).toBe(true)
    expect(snapshotErrorText('not json')).toBe('The server could not build a snapshot.')
  })
})

describe('the snapshot poll with no SSE client', () => {
  // Only the interval is faked; sockets and the rest of Node keep real time.
  const idleCalls = async (notifications: Record<string, unknown> | undefined, seconds: number): Promise<number> => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    let calls = 0
    const server = await startUiServer({ port: 0, loaded: loadedWith(notifications), board: {} as IssueBoardCache, snapshot: () => { calls += 1; return snapshotOf() } })
    servers.push(server)
    await vi.advanceTimersByTimeAsync(seconds * 1_000)
    return calls
  }

  it('does not run at all when nothing is watching and no alert channel is configured', async () => {
    expect(await idleCalls({ events: [] }, 120)).toBe(0)
  })

  it('runs about once a minute, not every second, when attention alerts still need it', async () => {
    const calls = await idleCalls({ events: [], command: ['notify-send', '{summary}'] }, 120)
    expect(calls).toBeGreaterThanOrEqual(1)
    expect(calls).toBeLessThanOrEqual(3)
  })
})

describe('SSE dedupe', () => {
  it('does not resend a snapshot whose only change is its clock fields', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    const server = await startUiServer({ port: 0, snapshot: snapshotOf })
    servers.push(server)
    const controller = new AbortController()
    const response = await fetch(`${server.url}api/v1/events?session=${server.token}`, { signal: controller.signal })
    const reader = response.body!.getReader()
    let text = ''
    // One read always outstanding, so no chunk is dropped between drains.
    const pump = (): void => { void reader.read().then(({ value, done }) => { if (done) return; text += new TextDecoder().decode(value); pump() }, () => undefined) }
    pump()
    // Real-time pause so the socket delivers whatever the faked interval wrote.
    const drain = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30))
    await drain()
    for (let second = 0; second < 10; second += 1) { await vi.advanceTimersByTimeAsync(1_000); await drain() }
    controller.abort()
    // The connect snapshot plus at most the first poll (which seeds the digest); never one per second.
    expect(text.match(/event: snapshot\n/g)?.length ?? 0).toBeLessThanOrEqual(2)
  })
})

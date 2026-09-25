import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { CommandResult, CommandRunner } from '../src/adapters/command.js'
import type { LoadedLoopConfig } from '../src/loop/config.js'
import { createHitlStore } from '../src/loop/hitl.js'
import type { IssueBoardCache } from '../src/ui/api/board.js'
import { startUiServer, type UiServerHandle } from '../src/ui/api/server.js'

const cleanups: string[] = []
const servers: UiServerHandle[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true })
})

const emptyBoard: IssueBoardCache = { read: async () => ({ provider: 'github', repo: 'acme/app', status: 'fresh', fetchedAt: new Date().toISOString(), issues: [], truncated: false, error: null }) }
const runner: CommandRunner = { run: async (): Promise<CommandResult> => ({ code: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 }) }

const loadedFor = (root: string): LoadedLoopConfig => {
  const stateDir = join(root, '.ak-loop')
  mkdirSync(stateDir, { recursive: true })
  return {
    root, stateDir, path: join(root, 'loop.config.yaml'), configHash: 'hash', unknownKeys: [],
    config: {
      connectors: { tracker: 'github' }, project: { name: 'app', repo: 'acme/app', baseBranch: 'main' },
      delivery: { returnState: 'Todo', maxFixRounds: 3 }, budget: { perIssueTokens: 0 }, resilience: { pausedLabel: 'loop:paused' },
      orca: { bin: 'orca' }, machine: { ceiling: 4, floor: 1 }, flows: { profiles: {}, default: null },
      linear: { doneState: 'Done' }, models: { builder: [['codex/gpt-5']], providers: { codex: {} } },
    },
  } as unknown as LoadedLoopConfig
}

const start = async (loaded: LoadedLoopConfig): Promise<UiServerHandle> => {
  const server = await startUiServer({ loaded, runner, port: 0, board: emptyBoard })
  servers.push(server)
  return server
}
const api = (server: UiServerHandle, path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`${server.url}${path.replace(/^\//, '')}`, { ...init, headers: { 'x-harness-session': server.token, 'content-type': 'application/json', ...init.headers } })

describe('the control-plane HTTP surface', () => {
  it('refuses every api route without the session token', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-ui-server-')); cleanups.push(root)
    const server = await start(loadedFor(root))
    const response = await fetch(`${server.url}api/v1/state`)
    expect(response.status).toBe(401)
  })

  it('reports health and an empty state snapshot for a fresh project', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-ui-server-')); cleanups.push(root)
    const server = await start(loadedFor(root))
    expect((await (await api(server, 'api/v1/health')).json())).toMatchObject({ status: 'ok' })
    const state = await (await api(server, 'api/v1/state')).json() as { readonly project: { readonly repo: string }; readonly issues: readonly unknown[]; readonly capacity: { readonly maxAgents: number } }
    expect(state.project.repo).toBe('acme/app')
    expect(state.issues).toEqual([])
    expect(state.capacity.maxAgents).toBe(4)
  })

  it('enqueues a run and reflects it in the next state read', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-ui-server-')); cleanups.push(root)
    const server = await start(loadedFor(root))
    const response = await api(server, 'api/v1/runs', { method: 'POST', body: JSON.stringify({ issue: 'ENG-1', configHash: 'hash', builder: 'codex/gpt-5', contractDigest: 'digest-1', preflight: true }) })
    expect(response.status).toBe(202)
    const state = await (await api(server, 'api/v1/state')).json() as { readonly issues: readonly { readonly issue: string; readonly phase: string }[] }
    expect(state.issues).toHaveLength(1)
    expect(state.issues[0]).toMatchObject({ issue: 'ENG-1', phase: 'running' })
  })

  it('rejects an enqueue whose builder is not a declared, routable candidate', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-ui-server-')); cleanups.push(root)
    const server = await start(loadedFor(root))
    const response = await api(server, 'api/v1/runs', { method: 'POST', body: JSON.stringify({ issue: 'ENG-2', configHash: 'hash', builder: 'openai/not-declared', contractDigest: 'digest-1', preflight: true }) })
    expect(response.status).toBe(400)
  })

  it('cancels a queued run end to end through the REST route', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-ui-server-')); cleanups.push(root)
    const server = await start(loadedFor(root))
    await api(server, 'api/v1/runs', { method: 'POST', body: JSON.stringify({ issue: 'ENG-3', configHash: 'hash', builder: 'codex/gpt-5', contractDigest: 'digest-1', preflight: true }) })
    const cancel = await api(server, 'api/v1/issues/ENG-3/cancel', { method: 'POST', body: JSON.stringify({ reason: 'operator cancelled' }) })
    expect(cancel.status).toBe(200)
    const state = await (await api(server, 'api/v1/state')).json() as { readonly issues: readonly { readonly issue: string; readonly run: { readonly status: string } | null }[] }
    expect(state.issues[0]?.run?.status).toBe('cancelled')
  })

  it('archives and restores a (terminal) run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-ui-server-')); cleanups.push(root)
    const server = await start(loadedFor(root))
    await api(server, 'api/v1/runs', { method: 'POST', body: JSON.stringify({ issue: 'ENG-4', configHash: 'hash', builder: 'codex/gpt-5', contractDigest: 'digest-1', preflight: true }) })
    // queue.ts refuses to archive an active (queued/dispatching/running) run — cancel it first.
    await api(server, 'api/v1/issues/ENG-4/cancel', { method: 'POST', body: '{}' })
    expect((await api(server, 'api/v1/issues/ENG-4/archive', { method: 'POST' })).status).toBe(200)
    let state = await (await api(server, 'api/v1/state')).json() as { readonly issues: readonly { readonly run: { readonly archived: boolean } | null }[] }
    expect(state.issues[0]?.run?.archived).toBe(true)
    expect((await api(server, 'api/v1/issues/ENG-4/restore', { method: 'POST' })).status).toBe(200)
    state = await (await api(server, 'api/v1/state')).json() as typeof state
    expect(state.issues[0]?.run?.archived).toBe(false)
  })

  it('answers a HITL decision through the REST route and reports whether the batch is now ready', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-ui-server-')); cleanups.push(root)
    const loaded = loadedFor(root)
    const created = createHitlStore(loaded.stateDir).create({ requestId: 'req-1', batchId: 'batch-1', issue: 'ENG-5', role: 'orchestrator', stage: 'contract', question: 'Which rollout?', context: '', options: [{ id: 'a', title: 'A', description: 'a' }, { id: 'b', title: 'B', description: 'b' }, { id: 'c', title: 'C', description: 'c' }], recommendedOptionId: 'c', digest: 'digest-1' })
    const server = await start(loaded)
    const response = await api(server, 'api/v1/issues/ENG-5/decisions/req-1/answer', { method: 'POST', body: JSON.stringify({ optionId: 'c', expectedDigest: created.digest, actor: 'alice' }) })
    expect(response.status).toBe(200)
    const body = await response.json() as { readonly batchReady: boolean }
    expect(body.batchReady).toBe(true)
  })

  it('404s a mutation for an issue with no run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-ui-server-')); cleanups.push(root)
    const server = await start(loadedFor(root))
    expect((await api(server, 'api/v1/issues/ENG-6/cancel', { method: 'POST', body: '{}' })).status).toBe(404)
  })

  it('serves the built frontend with the session token injected before </head>', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-ui-server-')); cleanups.push(root)
    const appDir = fileURLToPath(new URL('../dist/app', import.meta.url))
    const server = await startUiServer({ loaded: loadedFor(root), runner, port: 0, board: emptyBoard, appDir })
    servers.push(server)
    const html = await (await fetch(server.url)).text()
    expect(html).toContain(`window.__HARNESS_SESSION__=${JSON.stringify(server.token)}`)
    expect(html).toMatch(/<script>window\.__HARNESS_SESSION__=.*<\/script><\/head>/)
    // Any unknown client-side route falls back to the same index.html for the SPA router to own.
    const deepLink = await fetch(`${server.url}wizard/ENG-1`)
    expect(await deepLink.text()).toContain('window.__HARNESS_SESSION__')
  })
})

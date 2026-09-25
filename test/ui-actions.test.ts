import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createInboxStore, createIssueQueue, createUiJobManager, parseUiAction, startUiServer, UiJobConflictError, type CommandResult, type CommandRunner, type LoadedLoopConfig, type UiSnapshot } from '../src/index.js'

const cleanups: string[] = []
afterEach(() => { for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true }) })

const loaded = (): LoadedLoopConfig => {
  const root = mkdtempSync(join(tmpdir(), 'agentskit-ui-actions-')); cleanups.push(root)
  mkdirSync(join(root, '.ak-loop'), { recursive: true })
  return { root, stateDir: join(root, '.ak-loop'), path: join(root, 'loop.config.yaml'), configHash: 'hash', unknownKeys: [], config: { connectors: { tracker: 'github' } } } as never
}

const runner: CommandRunner = { run: async (): Promise<CommandResult> => ({ code: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 }) }
const waitFor = async (read: () => { readonly status: string } | null): Promise<{ readonly status: string }> => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const value = read()
    if (value && value.status !== 'running' && value.status !== 'cancel-pending') return value
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('job did not settle')
}

describe('UI action seam', () => {
  it('requires actor and reason for mutating typed actions', () => {
    expect(() => parseUiAction({ type: 'loop.tick' })).toThrow(/requires actor, reason and explicit confirmation/)
    expect(parseUiAction({ type: 'loop.tick', actor: 'alice', reason: 'start task', confirm: true })).toMatchObject({ type: 'loop.tick', actor: 'alice' })
    expect(parseUiAction({ type: 'loop.doctor' })).toMatchObject({ type: 'loop.doctor', probe: false })
    expect(() => parseUiAction({ type: 'loop.stage', stage: 'release', actor: 'alice', reason: 'ship', confirm: true })).toThrow(/additional release confirmation/)
    expect(parseUiAction({ type: 'loop.stage', stage: 'release', actor: 'alice', reason: 'ship', confirm: true, confirmRelease: true })).toMatchObject({ stage: 'release', confirmRelease: true })
  })

  it('rejects a conflicting stage and retries a failed attempt as a new job', async () => {
    const actions: string[] = []
    const manager = createUiJobManager({
      loaded: loaded(), runner,
      execute: async ({ emit }, action) => { actions.push(action.type); emit({ phase: 'work', detail: 'done', output: 'tail' }); if (actions.length === 1) throw new Error('first attempt failed'); return { ok: true } },
    })
    const action = parseUiAction({ type: 'loop.tick', actor: 'alice', reason: 'run', confirm: true })
    const first = await manager.submit(action)
    await expect(manager.submit(action)).rejects.toBeInstanceOf(UiJobConflictError)
    const failed = await waitFor(() => manager.get(first.id))
    expect(failed.status).toBe('failed')
    const retry = await manager.retry(first.id)
    const succeeded = await waitFor(() => manager.get(retry.id))
    expect(succeeded.status).toBe('succeeded')
    expect(retry.id).not.toBe(first.id)
    expect(retry.parentJobId).toBe(first.id)
    expect(succeeded.outputTail).toContain('tail')
    manager.close()
  })

  it('protects action creation and exposes job control through the local server', async () => {
    const manager = createUiJobManager({ loaded: loaded(), runner, execute: async () => ({ status: 'ok' }) })
    const sample: UiSnapshot = {
      schemaVersion: 2, generatedAt: new Date().toISOString(), windowHours: 24,
      project: { name: 'Harness', repo: 'acme/app', baseBranch: 'main', root: 'C:/repo', stateDir: 'C:/repo/.ak-loop', configHash: 'hash' },
      summary: { totalIssues: 0, inFlight: 0, held: 0, completed: 0, blocked: 0, eventCount: 0 }, issues: [], events: [], board: null, jobs: [],
    }
    const server = await startUiServer({ port: 0, snapshot: () => sample, jobs: manager })
    const unauthorized = await fetch(`${server.url}api/v1/actions`, { method: 'POST', body: '{}' })
    expect(unauthorized.status).toBe(401)
    const response = await fetch(`${server.url}api/v1/actions`, { method: 'POST', headers: { 'x-harness-session': server.token, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'loop.doctor' }) })
    expect(response.status).toBe(202)
    const body = await response.json() as { readonly job: { readonly id: string } }
    expect((await fetch(`${server.url}api/v1/jobs`, { headers: { 'x-harness-session': server.token } })).status).toBe(200)
    expect((await fetch(`${server.url}api/v1/jobs/${body.job.id}`, { headers: { 'x-harness-session': server.token } })).status).toBe(200)
    await server.close()
  })

  it('accepts localhost as the browser origin when the server is bound to 127.0.0.1', async () => {
    const manager = createUiJobManager({ loaded: loaded(), runner, execute: async () => ({ status: 'ok' }) })
    const sample: UiSnapshot = {
      schemaVersion: 2, generatedAt: new Date().toISOString(), windowHours: 24,
      project: { name: 'Harness', repo: 'acme/app', baseBranch: 'main', root: 'C:/repo', stateDir: 'C:/repo/.ak-loop', configHash: 'hash' },
      summary: { totalIssues: 0, inFlight: 0, held: 0, completed: 0, blocked: 0, eventCount: 0 }, issues: [], events: [], board: null, jobs: [],
    }
    const server = await startUiServer({ host: '127.0.0.1', port: 0, snapshot: () => sample, jobs: manager })
    const response = await fetch(`${server.url}api/v1/actions`, {
      method: 'POST',
      headers: { 'x-harness-session': server.token, origin: `http://localhost:${new URL(server.url).port}`, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'loop.doctor' }),
    })
    expect(response.status).toBe(202)
    await server.close()
  })

  it('returns a named job when polling a failed contract-generation job', async () => {
    const configLoaded = loaded()
    let attempts = 0
    const manager = createUiJobManager({ loaded: configLoaded, runner, execute: async () => { attempts += 1; if (attempts === 1) throw new Error('orchestrator rejected the issue contract'); return { ok: true } } })
    const submitted = await manager.submit(parseUiAction({ type: 'loop.contract', identifier: 'ENG-9', actor: 'alice', reason: 'prepare contract', confirm: true }))
    const failed = await waitFor(() => manager.get(submitted.id))
    expect(failed.status).toBe('failed')
    expect(createInboxStore(configLoaded.stateDir).list({ status: 'open' })).toEqual(expect.arrayContaining([expect.objectContaining({ issue: 'ENG-9', gate: 'failure.final', message: 'orchestrator rejected the issue contract' })]))
    const sample: UiSnapshot = {
      schemaVersion: 2, generatedAt: new Date().toISOString(), windowHours: 24,
      project: { name: 'Harness', repo: 'acme/app', baseBranch: 'main', root: configLoaded.root, stateDir: configLoaded.stateDir, configHash: 'hash' },
      summary: { totalIssues: 0, inFlight: 0, held: 0, completed: 0, blocked: 0, eventCount: 0 }, issues: [], events: [], board: null, jobs: [],
    }
    const server = await startUiServer({ port: 0, loaded: configLoaded, snapshot: () => sample, jobs: manager })
    const response = await fetch(`${server.url}api/v1/jobs/${submitted.id}`, { headers: { 'x-harness-session': server.token } })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ job: { status: 'failed', error: { message: 'orchestrator rejected the issue contract' } } })
    const retry = await fetch(`${server.url}api/v1/inbox/${encodeURIComponent('ENG-9::failure.final')}/resolve`, { method: 'POST', headers: { 'x-harness-session': server.token, 'content-type': 'application/json' }, body: JSON.stringify({ actor: 'alice', action: 'retry' }) })
    expect(retry.status).toBe(200)
    await expect(waitFor(() => manager.list().find((job) => job.parentJobId === submitted.id) ?? null)).resolves.toMatchObject({ status: 'succeeded' })
    await server.close()
  })

  it('requires a frozen contract and preflight before the issue-first start endpoint accepts a run', async () => {
    const configLoaded = loaded()
    ;(configLoaded as { config: unknown }).config = {
      project: { name: 'Harness', repo: 'acme/app', baseBranch: 'main', root: configLoaded.root, stateDir: '.ak-loop' },
      queue: { mode: 'explicit', order: 'fifo' }, connectors: { tracker: 'github', scm: 'github', runner: 'orca' },
      models: { builder: [['codex/gpt-5']], orchestrator: [['codex/gpt-5']], reviewer: [['codex/gpt-5']], watcher: [['codex/gpt-5']], providers: { codex: {} } },
      flows: { default: 'safe', profiles: { safe: {} }, select: [] },
      delivery: { maxFixRounds: 2, returnState: 'Todo' }, budget: { perIssueTokens: 0 }, machine: { floor: 1, ceiling: 1 },
      github: { issues: { refreshSeconds: 60, labels: {} } }, orca: { bin: 'orca', timeoutMs: 1000 }, linear: { inProgressState: 'In Progress' },
    }
    const queue = createIssueQueue({ stateDir: configLoaded.stateDir }); const inbox = createInboxStore(configLoaded.stateDir)
    const sample: UiSnapshot = { schemaVersion: 2, generatedAt: new Date().toISOString(), windowHours: 24, project: { name: 'Harness', repo: 'acme/app', baseBranch: 'main', root: configLoaded.root, stateDir: configLoaded.stateDir, configHash: 'hash' }, summary: { totalIssues: 0, inFlight: 0, held: 0, completed: 0, blocked: 0, eventCount: 0 }, issues: [], events: [], board: null, jobs: [] }
    const server = await startUiServer({ port: 0, loaded: configLoaded, snapshot: () => sample, queue, inbox })
    const headers = { 'x-harness-session': server.token, 'content-type': 'application/json' }
    const missing = await fetch(`${server.url}api/v1/runs`, { method: 'POST', headers, body: JSON.stringify({ issue: 'ENG-1', builder: 'codex/gpt-5', preflight: true }) })
    expect(missing.status).toBe(400)
    const unknownFlow = await fetch(`${server.url}api/v1/runs`, { method: 'POST', headers, body: JSON.stringify({ issue: 'ENG-1', flow: 'unknown', builder: 'codex/gpt-5', contractDigest: 'contract-1', preflight: true }) })
    expect(unknownFlow.status).toBe(400)
    const accepted = await fetch(`${server.url}api/v1/runs`, { method: 'POST', headers, body: JSON.stringify({ issue: 'ENG-1', flow: 'safe', builder: 'codex/gpt-5', contractDigest: 'contract-1', preflight: true }) })
    expect(accepted.status).toBe(202)
    expect(queue.list()[0]).toMatchObject({ issue: 'ENG-1', config: { builder: { provider: 'codex', model: 'gpt-5' } } })
    await server.close()
  })

  it('lets Inbox clean a dispatching run that never acquired an Orca resource, then leaves it retryable', async () => {
    const configLoaded = loaded()
    const queue = createIssueQueue({ stateDir: configLoaded.stateDir })
    const run = queue.enqueue({ issue: 'Dev4LifeV/mais-thopp-sistemas#217', title: 'cleanup', config: { configHash: 'hash', flow: null, builder: { provider: 'codex', model: 'gpt-5' }, maxFixRounds: 2, perIssueTokens: 1000, roles: { orchestrator: 'project', reviewer: 'project', watcher: 'project', delivery: 'snapshot' } }, contract: { digest: 'contract-217', status: 'valid', frozenAt: new Date().toISOString() }, preflight: { status: 'passed', checkedAt: new Date().toISOString() } })
    queue.consumeFifo()
    const inbox = createInboxStore(configLoaded.stateDir)
    const item = inbox.upsert({ issue: run.issue, gate: 'cleanup.failed', message: 'dispatch record was missing' })
    const sample: UiSnapshot = { schemaVersion: 2, generatedAt: new Date().toISOString(), windowHours: 24, project: { name: 'Harness', repo: 'acme/app', baseBranch: 'main', root: configLoaded.root, stateDir: configLoaded.stateDir, configHash: 'hash' }, summary: { totalIssues: 0, inFlight: 0, held: 0, completed: 0, blocked: 0, eventCount: 0 }, issues: [], events: [], board: null, jobs: [] }
    const server = await startUiServer({ port: 0, loaded: configLoaded, snapshot: () => sample, queue, inbox })
    const response = await fetch(`${server.url}api/v1/inbox/${encodeURIComponent(item.id)}/resolve`, { method: 'POST', headers: { 'x-harness-session': server.token, 'content-type': 'application/json' }, body: JSON.stringify({ actor: 'alice', action: 'cleanup' }) })
    expect(response.status).toBe(200)
    expect(queue.get(run.id)).toMatchObject({ status: 'cancelled', projection: { stage: 'cancelled' } })
    expect(inbox.get(item.id)).toMatchObject({ status: 'resolved', data: { resolution: 'cleanup' } })
    await server.close()
  })

  it('protects run archive/restore and retries a blocked run as a new run', async () => {
    const queue = createIssueQueue({ stateDir: loaded().stateDir })
    const first = queue.enqueue({ issue: 'ENG-archive', title: 'archive', config: { configHash: 'hash', flow: null, builder: { provider: 'codex', model: 'gpt-5' }, maxFixRounds: 2, perIssueTokens: 1000, roles: { orchestrator: 'project', reviewer: 'project', watcher: 'project', delivery: 'snapshot' } }, contract: { digest: 'contract', status: 'valid', frozenAt: new Date().toISOString() }, preflight: { status: 'passed', checkedAt: new Date().toISOString() } })
    queue.update(first.id, { status: 'needs-input', error: 'blocked', projection: { stage: 'blocked' } })
    const server = await startUiServer({ port: 0, snapshot: () => ({ schemaVersion: 2, generatedAt: new Date().toISOString(), windowHours: 24, project: { name: 'Harness', repo: 'acme/app', baseBranch: 'main', root: 'C:/repo', stateDir: 'C:/repo/.ak-loop', configHash: 'hash' }, summary: { totalIssues: 0, inFlight: 0, held: 0, completed: 0, blocked: 0, eventCount: 0 }, issues: [], events: [], board: null, jobs: [] }), queue })
    const headers = { 'x-harness-session': server.token, 'content-type': 'application/json' }
    expect((await fetch(`${server.url}api/v1/runs/${first.id}/archive`, { method: 'POST', headers, body: JSON.stringify({}) })).status).toBe(409)
    expect((await fetch(`${server.url}api/v1/runs/${first.id}/archive`, { method: 'POST', headers, body: JSON.stringify({ confirm: true }) })).status).toBe(200)
    expect(queue.get(first.id)?.archived).toBe(true)
    expect((await fetch(`${server.url}api/v1/runs/${first.id}/restore`, { method: 'POST', headers })).status).toBe(200)
    const retried = await fetch(`${server.url}api/v1/runs/${first.id}/retry`, { method: 'POST', headers })
    expect(retried.status).toBe(202)
    const retryBody = await retried.json() as { readonly run: { readonly id: string; readonly attempt: number } }
    expect(retryBody.run).toMatchObject({ attempt: 2 })
    expect(retryBody.run.id).not.toBe(first.id)
    await server.close()
  })

  it('deletes an Inbox card only with confirmation and suppresses its exact fingerprint', async () => {
    const configLoaded = loaded()
    const inbox = createInboxStore(configLoaded.stateDir)
    const item = inbox.upsert({ issue: 'ENG-delete', gate: 'delivery.pr-closed', message: 'closed', fingerprint: 'pr:1:closed:a' })
    const server = await startUiServer({ port: 0, snapshot: () => ({ schemaVersion: 2, generatedAt: new Date().toISOString(), windowHours: 24, project: { name: 'Harness', repo: 'acme/app', baseBranch: 'main', root: 'C:/repo', stateDir: 'C:/repo/.ak-loop', configHash: 'hash' }, summary: { totalIssues: 0, inFlight: 0, held: 0, completed: 0, blocked: 0, eventCount: 0 }, issues: [], events: [], board: null, jobs: [] }), inbox })
    const headers = { 'x-harness-session': server.token, 'content-type': 'application/json' }
    expect((await fetch(`${server.url}api/v1/inbox/${encodeURIComponent(item.id)}/delete`, { method: 'POST', headers, body: JSON.stringify({ actor: 'alice' }) })).status).toBe(409)
    expect((await fetch(`${server.url}api/v1/inbox/${encodeURIComponent(item.id)}/delete`, { method: 'POST', headers, body: JSON.stringify({ actor: 'alice', confirm: true }) })).status).toBe(200)
    expect(inbox.list({ status: 'open' })).toHaveLength(0)
    expect(inbox.suppressions()).toEqual(expect.arrayContaining([expect.objectContaining({ issue: 'ENG-delete', fingerprint: 'pr:1:closed:a' })]))
    await server.close()
  })
})

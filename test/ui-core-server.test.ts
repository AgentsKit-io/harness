import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CommandResult, CommandRunner } from '../src/adapters/command.js'
import { createDispatchLedger, readActiveClaims } from '../src/execution/coordination.js'
import type { LoadedLoopConfig } from '../src/loop/config.js'
import { writeStoredContract } from '../src/loop/contract.js'
import { deliveryStatePath, readDeliveryState } from '../src/loop/deliver.js'
import { writeJsonAtomic } from '../src/loop/fs-atomic.js'
import { createHitlStore } from '../src/loop/hitl.js'
import { createIssueQueue } from '../src/loop/queue.js'
import { appendLoopEvent, writeDispatchRecord, type DispatchRecordFile } from '../src/loop/tick.js'
import { enqueueRun } from '../src/ui/api/actions.js'
import { alertsStatePath, createAlertSender, readAlertsState } from '../src/ui/api/alerts.js'
import type { BoardSnapshot, IssueBoardCache } from '../src/ui/api/board.js'
import type { AttentionItem, IssueDetail, SnapshotExtras } from '../src/ui/api/contract.js'
import { startUiServer, type UiServerHandle } from '../src/ui/api/server.js'

const cleanups: string[] = []
const servers: UiServerHandle[] = []
const httpServers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const server of httpServers.splice(0)) await new Promise((resolve) => server.close(resolve))
  for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true })
})

/** A fake Orca: one live worktree `wt-1` with terminal `term-1`; every other command answers an empty envelope. */
const orcaReply = (argv: readonly string[]): unknown => argv.includes('ps') ? { worktrees: [{ worktreeId: 'wt-1', path: '/wt' }] } : argv.includes('terminal') ? { terminals: [{ handle: 'term-1', preview: 'line 1\nline 2', lastOutputAt: 1_767_225_600_000 }] } : argv.includes('automations') ? [] : {}
const runner: CommandRunner = { run: async (argv): Promise<CommandResult> => ({ code: 0, stdout: JSON.stringify({ ok: true, result: orcaReply(argv) }), stderr: '', timedOut: false, durationMs: 1 }) }
const boardOf = (issues: BoardSnapshot['issues']): IssueBoardCache => ({ read: async () => ({ provider: 'linear', repo: 'acme/app', status: 'fresh', fetchedAt: new Date().toISOString(), issues, truncated: false, error: null }) })
const doneIssue = (identifier: string): BoardSnapshot['issues'][number] => ({ identifier, title: identifier, url: 'https://tracker.example/i', state: 'Done', lane: 'done', labels: [], assignees: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' })

const loadedFor = (root: string, patch: Record<string, unknown> = {}): LoadedLoopConfig => {
  const stateDir = join(root, '.ak-loop')
  mkdirSync(stateDir, { recursive: true })
  return {
    root, stateDir, path: join(root, 'loop.config.yaml'), configHash: 'hash', unknownKeys: [],
    config: {
      connectors: { tracker: 'linear' }, project: { name: 'app', repo: 'acme/app', baseBranch: 'main' },
      delivery: { returnState: 'Todo', maxFixRounds: 3 }, budget: { perIssueTokens: 1_000 }, resilience: { pausedLabel: 'loop:paused' },
      orca: { bin: 'orca' }, machine: { ceiling: 4, floor: 1 }, flows: { profiles: {}, default: null }, schedule: { tick: '*/2 * * * *' },
      linear: { doneState: 'Done' }, models: { builder: [['codex/gpt-5']], providers: { codex: {} } }, github: { issues: { refreshSeconds: 60 } },
      dod: { items: [{ id: 'tests', kind: 'command', description: 'Tests pass', command: ['pnpm', 'test'], paths: [] }], evidenceFile: '.ak-loop/dod.json' },
      ...patch,
    },
  } as unknown as LoadedLoopConfig
}

const dispatch = (issue: string, worktreePath: string): DispatchRecordFile => ({
  issue, worktreeId: 'wt-1', worktree: 'wt', branch: 'feature/x', terminal: 'term-1', provider: 'codex', model: 'gpt-5', contractDigest: 'digest-1',
  leaseKey: 'k', leaseId: 'l', dispatchedAt: new Date(Date.now() - 60_000).toISOString(), url: 'https://tracker.example/i', briefDigest: 'b', skills: [], setup: null,
  effort: 'medium', initialRemainingPercent: null, worktreePath,
} as unknown as DispatchRecordFile)

const start = async (loaded: LoadedLoopConfig, board: IssueBoardCache): Promise<UiServerHandle> => {
  const server = await startUiServer({ loaded, runner, port: 0, board })
  servers.push(server)
  return server
}
const api = (server: UiServerHandle, path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`${server.url}${path}`, { ...init, headers: { 'x-harness-session': server.token, 'content-type': 'application/json', ...init.headers } })
const extrasOf = async (server: UiServerHandle): Promise<SnapshotExtras> => ((await (await api(server, 'api/v1/state')).json()) as { extras: SnapshotExtras }).extras

describe('control plane core: extras, locks, reconcile, issue detail', () => {
  it('ships attention, drift, freshness and a stale window of twice the tick cadence in the snapshot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-ui-core-')); cleanups.push(root)
    const loaded = loadedFor(root)
    createHitlStore(loaded.stateDir).create({ requestId: 'req-1', batchId: 'batch-1', issue: 'ENG-9', role: 'orchestrator', stage: 'contract', question: 'Which rollout?', context: '', options: [{ id: 'a', title: 'A', description: 'a' }, { id: 'b', title: 'B', description: 'b' }, { id: 'c', title: 'C', description: 'c' }], recommendedOptionId: 'c', digest: 'digest-1' })
    const extras = await extrasOf(await start(loaded, boardOf([])))
    expect(extras.staleAfterMs).toBe(240_000)
    expect(extras.freshness.map((item) => item.source)).toEqual(['loop', 'tracker', 'orca'])
    expect(extras.freshness.find((item) => item.source === 'tracker')?.stale).toBe(false)
    expect(extras.attention).toEqual([expect.objectContaining({ id: 'hitl:req-1', group: 'human', kind: 'hitl', issue: 'ENG-9' })])
  })

  it('refuses cancel on a drifted issue with 409, then reconcile releases the lease, frees the slot and clears the drift', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-ui-core-')); cleanups.push(root)
    const loaded = loadedFor(root)
    const context = { loaded, runner }
    const { runId } = enqueueRun(context, { issue: 'ENG-1', configHash: 'hash', flow: null, builder: { provider: 'codex', model: 'gpt-5' }, contractDigest: 'digest-1', maxFixRounds: 3, perIssueTokens: 0 })
    writeDispatchRecord(loaded.stateDir, dispatch('ENG-1', join(root, 'wt')))
    createDispatchLedger(loaded.stateDir).claim({ tracker: 'linear', repository: 'acme/app', issue: 'ENG-1', worktree: 'wt', branch: 'feature/x', owner: 'loop' })
    const server = await start(loaded, boardOf([doneIssue('ENG-1')]))

    const extras = await extrasOf(server)
    expect(extras.drift).toEqual([expect.objectContaining({ issue: 'ENG-1', kind: 'tracker-closed' })])
    expect(extras.locks['ENG-1']).toMatch(/Reconcile first/)
    expect(extras.attention.find((item) => item.kind === 'drift')).toMatchObject({ id: 'drift:ENG-1:tracker-closed', locked: true, actions: [{ id: 'reconcile', destructive: true }, { id: 'open' }] })

    const cancel = await api(server, 'api/v1/issues/ENG-1/cancel', { method: 'POST', body: '{}' })
    expect(cancel.status).toBe(409)
    expect(await cancel.json()).toMatchObject({ error: 'locked', reason: expect.stringMatching(/Reconcile first/) })
    expect((await api(server, 'api/v1/issues/ENG-1/decision', { method: 'POST', body: JSON.stringify({ action: 'reopen' }) })).status).toBe(409)

    const reconcile = await api(server, 'api/v1/issues/ENG-1/reconcile', { method: 'POST', body: '{}' })
    expect(reconcile.status).toBe(200)
    expect(await reconcile.json()).toMatchObject({ issue: 'ENG-1', drift: [], actions: ['lease released', 'dispatch marked finished', `run ${runId} cancelled`] })
    expect(readActiveClaims(loaded.stateDir)).toEqual([])
    expect(readDeliveryState(loaded.stateDir, 'ENG-1').finishedAt).not.toBeNull()
    expect(createIssueQueue({ stateDir: loaded.stateDir }).get(runId)?.status).toBe('cancelled')
    expect((await extrasOf(server)).locks).toEqual({})
    // No drift left: reconcile is not a blind force-cancel.
    expect((await api(server, 'api/v1/issues/ENG-1/reconcile', { method: 'POST', body: '{}' })).status).toBe(409)
  })

  it('returns the issue detail: contract, criteria joined with DoD proofs, latest review, spend, fix rounds, next step', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-ui-core-')); cleanups.push(root)
    const loaded = loadedFor(root)
    const worktree = join(root, 'wt'); mkdirSync(join(worktree, '.ak-loop'), { recursive: true })
    writeDispatchRecord(loaded.stateDir, dispatch('ENG-2', worktree))
    writeStoredContract(loaded.stateDir, {
      schemaVersion: 1, issue: 'ENG-2', issueUpdatedAt: '2026-01-01T00:00:00.000Z', generatedAt: '2026-01-01T00:00:00.000Z', provider: 'codex', model: 'gpt-5', digest: 'digest-1', source: 'llm',
      assessment: { dispatchable: true, reasons: [] },
      contract: { intent: 'Add export', scope: { inScope: ['export button'], outOfScope: ['import'] }, outcomes: [{ id: 'o1', description: 'CSV downloads', check: { kind: 'test' } }, { id: 'o2', description: 'Empty state', check: { kind: 'manual' } }], ambiguities: [], hitl: [], touchpoints: [], risks: [] },
    })
    writeFileSync(join(worktree, '.ak-loop', 'dod.json'), JSON.stringify({ project: [{ id: 'tests', status: 'passed', evidence: '42 passed' }], outcomes: [{ id: 'o1', status: 'failed', evidence: 'no file' }] }))
    const head = 'a'.repeat(40)
    writeJsonAtomic(deliveryStatePath(loaded.stateDir, 'ENG-2'), { issue: 'ENG-2', prNumber: 7, reviews: { [head]: { status: 'findings', at: '2026-01-01T00:00:00.000Z', provider: 'claude', model: 'opus', blocking: 1, attempts: 1 } }, fixRounds: 2, nudges: [], handoffs: [], heldFor: null, finishedAt: null, finalOutcome: null })
    writeFileSync(join(loaded.stateDir, 'issues', 'ENG-2', `review-${head.slice(0, 12)}.json`), JSON.stringify({ findings: [{ severity: 'high', title: 'Missing null check', location: { file: 'src/a.ts', line: 3 } }] }))
    appendLoopEvent(loaded.stateDir, { at: new Date().toISOString(), type: 'model.usage', issue: 'ENG-2', totalTokens: 300 })
    appendLoopEvent(loaded.stateDir, { at: new Date().toISOString(), type: 'worker.stuck', issue: 'ENG-2', reason: 'idle for 30 min', worktreeId: 'wt-1' })

    const server = await start(loaded, boardOf([]))
    const response = await api(server, 'api/v1/issues/ENG-2/detail')
    expect(response.status).toBe(200)
    const detail = await response.json() as IssueDetail
    expect(detail.contract).toEqual({ digest: 'digest-1', intent: 'Add export', inScope: ['export button'], outOfScope: ['import'], frozenAt: '2026-01-01T00:00:00.000Z' })
    expect(detail.criteria.map((item) => [item.id, item.status, item.evidence])).toEqual([['dod:tests', 'proven', '42 passed'], ['o1', 'failed', 'no file'], ['o2', 'missing', 'check: manual']])
    expect(detail.review).toMatchObject({ head, status: 'findings', blocking: 1, provider: 'claude', model: 'opus', findings: [{ severity: 'high', text: 'Missing null check', file: 'src/a.ts' }] })
    expect(detail.spend).toEqual({ tokens: 300, cap: 1_000, calls: 1 })
    expect(detail.fixRounds).toEqual({ used: 2, max: 3 })
    expect(detail.worker).toEqual({ terminal: 'term-1', preview: 'line 1\nline 2', lastOutputAt: new Date(1_767_225_600_000).toISOString() })
    expect(detail.nextStep).toMatchObject({ reason: expect.stringMatching(/stopped producing output/), detail: 'idle for 30 min' })
    expect((await api(server, 'api/v1/issues/..%2Fetc/detail')).status).toBe(400)
  })
})

describe('attention alerts', () => {
  const item = (id: string, group: AttentionItem['group'] = 'human'): AttentionItem => ({ id, group, kind: 'hitl', issue: 'ENG-1', title: 'Which rollout?', reason: 'A decision is needed.', detail: null, since: '2026-01-01T00:00:00.000Z', actions: [], locked: false, lockReason: null })

  it('posts each human/failed item once through the notifications webhook, and a restart does not resend', async () => {
    const received: Record<string, unknown>[] = []
    const hook = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk: Buffer) => { body += chunk.toString() })
      request.on('end', () => { received.push(JSON.parse(body) as Record<string, unknown>); response.writeHead(204); response.end() })
    })
    httpServers.push(hook)
    await new Promise<void>((resolve) => hook.listen(0, '127.0.0.1', resolve))
    const address = hook.address() as { port: number }
    const root = mkdtempSync(join(tmpdir(), 'harness-ui-core-alerts-')); cleanups.push(root)
    const loaded = loadedFor(root, { notifications: { events: [], webhook: { url: `http://127.0.0.1:${address.port}/hook`, method: 'POST', headers: {}, timeoutMs: 10_000 }, commandTimeoutMs: 10_000 } })

    const sender = createAlertSender(loaded)
    await sender.observe([item('hitl:1'), item('stage-paused:tick', 'system')])
    await sender.observe([item('hitl:1')])
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ event: 'attention.entered', issue: 'ENG-1', payload: { type: 'attention.entered', issue: 'ENG-1', group: 'human', kind: 'hitl', title: 'Which rollout?', reason: 'A decision is needed.' } })
    expect(readAlertsState(loaded.stateDir)).toMatchObject({ seen: ['hitl:1'], lastDelivery: { status: 204 } })

    // A restart reads the persisted ids back: nothing is resent; a new item still is.
    const restarted = createAlertSender(loaded)
    await restarted.observe([item('hitl:1'), item('blocked:ENG-2', 'failed')])
    expect(received.map((body) => (body['payload'] as { group: string }).group)).toEqual(['human', 'failed'])
    expect(JSON.parse(readFileSync(alertsStatePath(loaded.stateDir), 'utf8'))).toMatchObject({ seen: ['hitl:1', 'blocked:ENG-2'], lastDelivery: { at: expect.any(String), status: 204 } })
  })

  it('records an unreachable webhook as an error delivery, and stays silent when nothing is configured', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-ui-core-alerts-')); cleanups.push(root)
    const broken = loadedFor(root, { notifications: { events: [], webhook: { url: 'http://127.0.0.1:9/unreachable', method: 'POST', headers: {}, timeoutMs: 1_000 }, commandTimeoutMs: 10_000 } })
    await createAlertSender(broken).observe([item('hitl:1')])
    expect(readAlertsState(broken.stateDir).lastDelivery?.status).toBe('error')
    const quietRoot = mkdtempSync(join(tmpdir(), 'harness-ui-core-alerts-')); cleanups.push(quietRoot)
    const quiet = loadedFor(quietRoot, { notifications: { events: [], commandTimeoutMs: 10_000 } })
    await createAlertSender(quiet).observe([item('hitl:1')])
    expect(readAlertsState(quiet.stateDir)).toEqual({ seen: [], lastDelivery: null })
  })
})

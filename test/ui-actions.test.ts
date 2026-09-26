import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CommandResult, CommandRunner } from '../src/adapters/command.js'
import { loadLoopConfig, type LoadedLoopConfig } from '../src/loop/config.js'
import { deliveryStatePath, readDeliveryState } from '../src/loop/deliver.js'
import { writeJsonAtomic } from '../src/loop/fs-atomic.js'
import { readLearningsLedger, writeLearningsLedger } from '../src/loop/memory.js'
import { readPlanState, startPlan, writePlanState } from '../src/loop/plan-stage.js'
import { createIssueQueue } from '../src/loop/queue.js'
import { readReleaseState } from '../src/loop/release.js'
import { isStagePaused, pauseStage, recordStageRunResult, resumeStage, stageEntry } from '../src/loop/resilience-state.js'
import { readLoopEvents } from '../src/loop/retro.js'
import type { ContractResult } from '../src/ui/api/actions.js'
import type { IssueBoardCache } from '../src/ui/api/board.js'
import { createUiJobManager, type UiJobManager, type UiJobRecord } from '../src/ui/api/jobs.js'
import { createActionRoutes, type ActionRouteDeps } from '../src/ui/api/routes-actions.js'
import type { RouteContext, RouteModule } from '../src/ui/api/routes.js'

const exampleYaml = readFileSync(join(process.cwd(), 'loop.config.example.yaml'), 'utf8').replace('person: my-linear-display-name', 'person: Pat Operator')
const cleanups: (() => void)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

const result = (stdout: string, code = 0): CommandResult => ({ code, stdout, stderr: '', timedOut: false, durationMs: 1 })

interface Harness { readonly loaded: LoadedLoopConfig; readonly jobs: UiJobManager; readonly calls: string[][]; readonly post: (path: string, body?: unknown) => Promise<{ readonly status: number; readonly body: Record<string, unknown> }> }

const harness = async (deps: Partial<ActionRouteDeps> = {}): Promise<Harness> => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-ui-actions-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'loop.config.yaml'), exampleYaml)
  const loaded = loadLoopConfig(join(dir, 'loop.config.yaml'))
  const calls: string[][] = []
  const runner: CommandRunner = {
    run: async (argv) => {
      calls.push([...argv])
      if (argv.includes('rev-parse') && argv.includes(loaded.config.project.baseBranch)) return result('abcdef1234567890\n')
      if (argv.includes('log')) return result('abcdef1234567890\u001fENG-7 add export\n1234567abcdef\u001fENG-8 fix totals\n')
      return result('', 127)
    },
  }
  const jobs = createUiJobManager({ stateDir: loaded.stateDir })
  cleanups.push(() => jobs.close())
  const route: RouteModule = createActionRoutes({
    contract: deps.contract ?? (async () => { throw new Error('no contract in this test') }),
    tick: deps.tick ?? (async () => { throw new Error('no tick in this test') }),
    deliver: deps.deliver ?? (async () => { throw new Error('no deliver in this test') }),
  })
  const context: RouteContext = { loaded, runner, board: {} as IssueBoardCache, jobs, snapshot: () => { throw new Error('unused') } }
  const server: Server = createServer((request, response) => {
    void route(context, request, response, new URL(request.url ?? '/', 'http://localhost')).then((handled) => { if (!handled) { response.writeHead(404); response.end('{"error":"not_found"}') } })
      .catch((error: unknown) => { response.writeHead(400); response.end(JSON.stringify({ error: String(error) })) })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => server.close())
  const address = server.address()
  const port = address && typeof address !== 'string' ? address.port : 0
  const post = async (path: string, body: unknown = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/${path}`, { method: 'POST', body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  }
  return { loaded, jobs, calls, post }
}

const settled = async (jobs: UiJobManager, id: string): Promise<UiJobRecord> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = jobs.get(id)
    if (job && !['running', 'cancel-pending'].includes(job.status)) return job
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`job ${id} did not settle`)
}

describe('pauseStage (kernel)', () => {
  it('pauses on purpose, survives re-pausing with the original time, and only resumeStage clears it', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'harness-ui-pause-'))
    cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }))
    recordStageRunResult(stateDir, 'tick', { succeeded: false, reason: 'boom' }, 5)
    const first = pauseStage(stateDir, 'tick', 'maintenance window', new Date('2026-09-01T00:00:00Z'))
    expect(isStagePaused(stateDir, 'tick')).toBe(true)
    expect(isStagePaused(stateDir, 'deliver')).toBe(false)
    expect(first).toMatchObject({ consecutiveFailures: 1, pausedAt: '2026-09-01T00:00:00.000Z', pausedReason: 'maintenance window' })
    const again = pauseStage(stateDir, 'tick', 'still down', new Date('2026-09-02T00:00:00Z'))
    expect(again.pausedAt).toBe('2026-09-01T00:00:00.000Z')
    expect(stageEntry(stateDir, 'tick').pausedReason).toBe('still down')
    resumeStage(stateDir, 'tick')
    expect(isStagePaused(stateDir, 'tick')).toBe(false)
  })
})

describe('action routes', () => {
  it('approves a held PR only for the exact held head, recorded under the configured person', async () => {
    const { loaded, post } = await harness()
    writeJsonAtomic(deliveryStatePath(loaded.stateDir, 'ENG-1'), { ...readDeliveryState(loaded.stateDir, 'ENG-1'), prNumber: 12, heldFor: 'abcdef1234567890' })
    expect((await post('issues/ENG-1/approve', {})).status).toBe(400)
    expect((await post('issues/ENG-1/approve', { head: 'not-a-sha' })).status).toBe(400)
    expect((await post('issues/ENG-1/approve', { head: '9999999999' })).status).toBe(409)
    const approved = await post('issues/ENG-1/approve', { head: 'abcdef1' })
    expect(approved).toMatchObject({ status: 200, body: { issue: 'ENG-1', head: 'abcdef1234567890', by: 'Pat Operator' } })
    expect(readDeliveryState(loaded.stateDir, 'ENG-1').humanApproval).toMatchObject({ head: 'abcdef1234567890', by: 'Pat Operator' })
    expect((await post('issues/ENG-2/approve', { head: 'abcdef1' })).status).toBe(409) // not held
    expect((await post(`issues/${encodeURIComponent('a/../b')}/approve`, { head: 'abcdef1' })).status).toBe(400)
  })

  it('runs the plan gates through approvePlan/approveDesign and writes plan state back', async () => {
    const { loaded, post } = await harness()
    const now = new Date('2026-09-01T00:00:00Z')
    const plan = { ...startPlan('export invoices', now), phase: 'review' as const, prd: { objective: 'export', users: ['ops'], inScope: ['csv'], outOfScope: [], nonGoals: [], constraints: [], successCriteria: ['file downloads'], risks: [] } }
    writePlanState(loaded.stateDir, plan)
    expect((await post('plans/missing-plan/approve')).status).toBe(404)
    expect((await post(`plans/${plan.id}/approve-design`)).status).toBe(409) // not in architect phase
    const approved = await post(`plans/${plan.id}/approve`)
    expect(approved).toMatchObject({ status: 200, body: { id: plan.id, phase: 'architect', by: 'Pat Operator' } })
    expect(readPlanState(loaded.stateDir, plan.id)?.approvals.plan).toMatch(/^Pat Operator@/)
    expect((await post(`plans/${plan.id}/approve`)).status).toBe(409) // already past review
    expect((await post(`plans/${plan.id}/approve-design`)).status).toBe(409) // no consensus yet
  })

  it('approves the release batch on the integration branch; there is no release run endpoint', async () => {
    const { loaded, post, calls } = await harness()
    const approved = await post('release/approve')
    expect(approved).toMatchObject({ status: 200, body: { status: 'approved', head: 'abcdef1234567890', actor: 'Pat Operator', commits: 2 } })
    expect(readReleaseState(loaded.stateDir).approval?.actor).toBe('Pat Operator')
    expect((await post('release/run')).status).toBe(404)
    expect(calls.every((argv) => argv[0] === 'git')).toBe(true)
  })

  it('promotes and rejects learnings as a human, refusing empty or unknown ids', async () => {
    const { loaded, post } = await harness()
    const record = (id: string) => ({ id, source: 'retro', category: 'problem' as const, text: `lesson ${id}`, status: 'proposed' as const, recordedAt: '2026-09-01T00:00:00Z' })
    writeLearningsLedger(loaded.stateDir, { records: [record('L-a'), record('L-b')] })
    expect((await post('learnings/promote', { ids: [] })).status).toBe(400)
    expect((await post('learnings/promote', { ids: ['L-zzz'] })).status).toBe(400)
    expect((await post('learnings/promote', { ids: ['L-a'] })).status).toBe(200)
    expect((await post('learnings/reject', { ids: ['L-b'] })).status).toBe(200)
    expect(readLearningsLedger(loaded.stateDir).records.map((item) => [item.id, item.status])).toEqual([['L-a', 'promoted'], ['L-b', 'rejected']])
  })

  it('pauses and resumes a stage, refuses unknown stages, and refuses a manual run while paused', async () => {
    let ticks = 0
    const { loaded, post, jobs } = await harness({ tick: (async () => { ticks += 1; return { status: 'idle', results: [] } }) as never })
    expect((await post('stages/retro/pause', { reason: 'x' })).status).toBe(400)
    expect((await post('stages/bogus/run')).status).toBe(400)
    expect((await post('stages/tick/pause', {})).status).toBe(400)
    const paused = await post('stages/tick/pause', { reason: 'provider outage' })
    expect(paused).toMatchObject({ status: 200, body: { stage: 'tick', paused: true } })
    expect(isStagePaused(loaded.stateDir, 'tick')).toBe(true)
    expect(readLoopEvents(loaded.stateDir).some((event) => event.type === 'stage.paused' && event['stage'] === 'tick' && event['by'] === 'Pat Operator')).toBe(true)
    expect((await post('stages/tick/run')).status).toBe(409)
    expect(ticks).toBe(0)
    expect((await post('stages/tick/resume')).status).toBe(200)
    const run = await post('stages/tick/run')
    expect(run.status).toBe(202)
    const job = await settled(jobs, (run.body['job'] as UiJobRecord).id)
    expect(job).toMatchObject({ kind: 'stage:tick', status: 'succeeded', actor: 'Pat Operator' })
    expect(ticks).toBe(1)
  })

  it('counts a failed manual deliver run toward the stage failure counter', async () => {
    const { loaded, post, jobs } = await harness({ deliver: async () => { throw new Error('adapter crashed') } })
    const run = await post('stages/deliver/run')
    expect((await settled(jobs, (run.body['job'] as UiJobRecord).id)).status).toBe('failed')
    expect(stageEntry(loaded.stateDir, 'deliver')).toMatchObject({ consecutiveFailures: 1, lastReason: 'adapter crashed' })
  })

  it('batch: validates every entry before starting a job, queues only valid contracts, leaves ambiguous ones for HITL', async () => {
    const contract = async (_context: unknown, issue: string): Promise<ContractResult> => ({ status: issue === 'ENG-2' ? 'needs-input' : 'valid', contract: { digest: `digest-${issue}` } as ContractResult['contract'] })
    const { loaded, post, jobs } = await harness({ contract: contract as ActionRouteDeps['contract'] })
    const builder = loaded.config.models.builder.flat()[0]!
    const ceiling = loaded.config.delivery.maxFixRounds
    expect((await post('batch', { defaults: { builder }, issues: [] })).status).toBe(400)
    expect((await post('batch', { defaults: { builder, maxFixRounds: ceiling + 1 }, issues: [{ issue: 'ENG-1' }] })).status).toBe(400)
    expect((await post('batch', { defaults: { builder }, issues: [{ issue: 'ENG-1', flow: 'no-such-flow' }] })).status).toBe(400)
    expect((await post('batch', { defaults: { builder }, issues: [{ issue: 'ENG-1', builder: 'nobody/none' }] })).status).toBe(400)
    expect((await post('batch', { defaults: { builder }, issues: [{ issue: 'ENG-1' }, { issue: 'ENG-1' }] })).status).toBe(400)
    expect(jobs.list()).toHaveLength(0)

    const response = await post('batch', { defaults: { builder, maxFixRounds: 0 }, issues: [{ issue: 'ENG-1', maxFixRounds: ceiling }, { issue: 'ENG-2' }] })
    expect(response.status).toBe(202)
    const [first, second] = response.body['jobs'] as UiJobRecord[]
    expect((await settled(jobs, first!.id))).toMatchObject({ status: 'succeeded', result: { status: 'queued', issue: 'ENG-1', contractDigest: 'digest-ENG-1' } })
    expect((await settled(jobs, second!.id))).toMatchObject({ status: 'needs-input', result: { status: 'needs-input', issue: 'ENG-2' } })
    const runs = createIssueQueue({ stateDir: loaded.stateDir }).list()
    expect(runs.map((run) => run.issue)).toEqual(['ENG-1'])
    expect(runs[0]?.config).toMatchObject({ maxFixRounds: ceiling, builder: { provider: builder.slice(0, builder.indexOf('/')) } })
  })

  it('batch: accepts a GitHub-tracker id (owner/repo#N) and still refuses path traversal', async () => {
    const contract = async (_context: unknown, issue: string): Promise<ContractResult> => ({ status: 'valid', contract: { digest: `digest-${issue}` } as ContractResult['contract'] })
    const { loaded, post, jobs } = await harness({ contract: contract as ActionRouteDeps['contract'] })
    const builder = loaded.config.models.builder.flat()[0]!
    expect((await post('batch', { defaults: { builder }, issues: [{ issue: 'acme/app/../../x#1' }] })).status).toBe(400)
    const response = await post('batch', { defaults: { builder }, issues: [{ issue: 'acme/app#77' }] })
    expect(response.status).toBe(202)
    const [job] = response.body['jobs'] as UiJobRecord[]
    expect(await settled(jobs, job!.id)).toMatchObject({ status: 'succeeded', result: { status: 'queued', issue: 'acme/app#77' } })
  })
})

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CommandResult, CommandRunner } from '../src/adapters/command.js'
import { automationName } from '../src/loop/automations.js'
import { cooldownPath } from '../src/loop/cooldown.js'
import { loadLoopConfig, type LoadedLoopConfig } from '../src/loop/config.js'
import type { LoopDoctorReport } from '../src/loop/doctor.js'
import type { InstallReport } from '../src/loop/install.js'
import { writeLearningsLedger } from '../src/loop/memory.js'
import { pauseStage } from '../src/loop/resilience-state.js'
import { appendLoopEvent } from '../src/loop/tick.js'
import type { IssueBoardCache } from '../src/ui/api/board.js'
import type { SystemReport } from '../src/ui/api/contract.js'
import { createUiJobManager, type UiJobManager, type UiJobRecord } from '../src/ui/api/jobs.js'
import type { RouteContext } from '../src/ui/api/routes.js'
import { alertsStatePath, createSystemRoutes, doctorReportPath, type SystemRouteDeps } from '../src/ui/api/routes-system.js'

const exampleYaml = readFileSync(join(process.cwd(), 'loop.config.example.yaml'), 'utf8').replace('person: my-linear-display-name', 'person: Pat Operator')
const NOW = new Date('2026-09-20T12:00:00Z')
const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

const ok = (result: unknown): CommandResult => ({ code: 0, stdout: JSON.stringify({ ok: true, result }), stderr: '', timedOut: false, durationMs: 1 })

const harness = async (deps: Partial<SystemRouteDeps> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-ui-system-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'loop.config.yaml'), exampleYaml)
  const loaded: LoadedLoopConfig = loadLoopConfig(join(dir, 'loop.config.yaml'))
  const tick = automationName(loaded.config, 'tick')
  const calls: string[][] = []
  const runner: CommandRunner = {
    run: async (argv) => {
      calls.push([...argv])
      const key = argv.join(' ')
      if (key.startsWith('orca automations list')) { const automations = [{ id: 'auto-1', name: tick, enabled: true, trigger: '*/7 * * * *', provider: 'claude' }]; return ok({ automations, items: automations }) }
      if (key.startsWith('orca automations runs')) return ok({ runs: [{ startedAt: Date.parse('2026-09-20T11:55:00Z'), status: 'succeeded' }] })
      return { code: 127, stdout: '', stderr: `no fixture for ${key}`, timedOut: false, durationMs: 1 }
    },
  }
  const jobs: UiJobManager = createUiJobManager({ stateDir: loaded.stateDir })
  cleanups.push(() => jobs.close())
  const route = createSystemRoutes({
    doctor: deps.doctor ?? (async () => { throw new Error('doctor must not run in this test') }),
    install: deps.install ?? (async () => { throw new Error('install must not run in this test') }),
    now: deps.now ?? (() => NOW),
  })
  const context: RouteContext = { loaded, runner, board: {} as IssueBoardCache, jobs, snapshot: () => { throw new Error('unused') } }
  const server: Server = createServer((request, response) => {
    void route(context, request, response, new URL(request.url ?? '/', 'http://localhost')).then((handled) => { if (!handled) { response.writeHead(404); response.end('{}') } })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => server.close())
  const address = server.address()
  const base = `http://127.0.0.1:${address && typeof address !== 'string' ? address.port : 0}/api/v1/`
  const call = async (method: string, path: string) => { const response = await fetch(`${base}${path}`, { method }); return { status: response.status, body: await response.json() as Record<string, unknown> } }
  return { loaded, jobs, calls, call }
}

describe('GET /system', () => {
  it('assembles the read model from local state, never runs doctor, and caches the Orca read', async () => {
    const { loaded, calls, call } = await harness()
    const { stateDir } = loaded
    writeFileSync(cooldownPath(stateDir), JSON.stringify({
      claude: { attempts: 1, until: '2026-09-20T13:00:00Z', reason: 'usage exhausted', markedAt: '2026-09-20T11:00:00Z' },
      codex: { attempts: 0, until: '2026-09-20T10:00:00Z', reason: 'old', markedAt: '2026-09-20T09:00:00Z' },
    }))
    appendLoopEvent(stateDir, { at: '2026-09-20T11:00:00Z', type: 'worker.handed-off', issue: 'ENG-1' })
    appendLoopEvent(stateDir, { at: '2026-09-18T11:00:00Z', type: 'worker.handed-off', issue: 'ENG-2' })
    const record = (id: string, status: 'proposed' | 'promoted' | 'rejected') => ({ id, source: 'retro', category: 'problem' as const, text: id, status, recordedAt: '2026-09-19T00:00:00Z' })
    writeLearningsLedger(stateDir, { records: [record('L-rejected', 'rejected'), record('L-promoted', 'promoted'), record('L-proposed', 'proposed')] })
    pauseStage(stateDir, 'deliver', 'maintenance', NOW)
    mkdirSync(join(stateDir, 'ui'), { recursive: true })
    writeFileSync(alertsStatePath(stateDir), JSON.stringify({ lastDelivery: { at: '2026-09-20T11:30:00Z', status: 204 } }))

    const { status, body } = await call('GET', 'system')
    const report = body as unknown as SystemReport
    expect(status).toBe(200)
    expect(report.doctor).toBeNull()
    expect(existsSync(doctorReportPath(stateDir))).toBe(false)
    expect(report.machine.slots).toBe(loaded.config.machine.ceiling ?? loaded.config.machine.floor)
    expect(report.routing.map((row) => row.role)).toContain('builder')
    expect(report.cooldowns).toEqual([{ provider: 'claude', until: '2026-09-20T13:00:00Z', reason: 'usage exhausted' }])
    expect(report.handoffs).toBe(1)
    expect(report.learnings.map((item) => item.id)).toEqual(['L-proposed', 'L-promoted', 'L-rejected'])
    expect(report.alerts).toEqual({ configured: false, lastDelivery: { at: '2026-09-20T11:30:00Z', status: 204 } })
    const tick = report.stages.find((stage) => stage.stage === 'tick')
    const deliver = report.stages.find((stage) => stage.stage === 'deliver')
    expect(report.stages.map((stage) => stage.stage)).toEqual(['tick', 'deliver', 'retro', 'observe'])
    expect(tick).toMatchObject({ installed: true, schedule: '*/7 * * * *', lastRunAt: '2026-09-20T11:55:00.000Z', lastStatus: 'succeeded', paused: false })
    expect(tick?.drift).toContain('trigger')
    expect(deliver).toMatchObject({ installed: false, paused: true, pausedReason: 'maintenance' })
    expect(Array.isArray(report.retroSuggestions)).toBe(true)

    const orcaCalls = calls.length
    expect(orcaCalls).toBeGreaterThan(0)
    expect(calls.every((argv) => argv[0] === 'orca' && argv[1] === 'automations')).toBe(true)
    await call('GET', 'system')
    expect(calls.length).toBe(orcaCalls)
  })
})

describe('system actions', () => {
  it('POST /system/doctor runs doctor as a job and saves its summary for GET /system', async () => {
    const report = { status: 'failed', generatedAt: '2026-09-20T12:00:00.000Z', checks: [{ id: 'orca.version', status: 'passed', detail: 'ok' }, { id: 'tracker.queue', status: 'failed', detail: 'no access' }, { id: 'machine.slots', status: 'warning', detail: '0 free' }] } as unknown as LoopDoctorReport
    const { loaded, jobs, call } = await harness({ doctor: async () => report })
    const started = await call('POST', 'system/doctor')
    expect(started.status).toBe(202)
    const id = (started.body['job'] as UiJobRecord).id
    for (let attempt = 0; attempt < 100 && jobs.get(id)?.status === 'running'; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(jobs.get(id)).toMatchObject({ kind: 'doctor', status: 'succeeded', actor: 'Pat Operator' })
    expect(JSON.parse(readFileSync(doctorReportPath(loaded.stateDir), 'utf8'))).toMatchObject({ ranAt: report.generatedAt, status: 'failed' })
    const system = (await call('GET', 'system')).body as unknown as SystemReport
    expect(system.doctor).toEqual({ ranAt: report.generatedAt, checks: [{ name: 'orca.version', status: 'pass', detail: 'ok' }, { name: 'tracker.queue', status: 'fail', detail: 'no access' }, { name: 'machine.slots', status: 'warn', detail: '0 free' }] })
  })

  it('POST /automations/reinstall returns the install report and drops the cached stage status', async () => {
    let installs = 0
    const installReport: InstallReport = { status: 'ok', provider: 'claude', workspace: 'path:x', actions: [], notes: [] }
    const { calls, call } = await harness({ install: async () => { installs += 1; return installReport } })
    await call('GET', 'system')
    const before = calls.length
    expect(await call('POST', 'automations/reinstall')).toEqual({ status: 200, body: installReport })
    expect(installs).toBe(1)
    await call('GET', 'system')
    expect(calls.length).toBeGreaterThan(before)
  })
})

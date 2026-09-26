import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandResult, CommandRunner } from '../src/adapters/command.js'
import { loadLoopConfig, type LoadedLoopConfig } from '../src/loop/config.js'
import { editYaml } from '../src/loop/local-config.js'
import { createIssueQueue } from '../src/loop/queue.js'
import { readTuningState, setTuningFrozen, tuningStatePath } from '../src/loop/tuning.js'
import type { IssueBoardCache } from '../src/ui/api/board.js'
import { fieldMeta, isWeaker } from '../src/ui/api/config-fields.js'
import { ConfigRefused, effectiveConfig, proposeTeamChange, unifiedDiff, weakenedGates, writePersonalConfig } from '../src/ui/api/config-view.js'
import type { ConfigProposal, EffectiveConfig } from '../src/ui/api/contract.js'
import { startUiServer, type UiServerHandle } from '../src/ui/api/server.js'

const example = readFileSync(join(process.cwd(), 'loop.config.example.yaml'), 'utf8').replace('person: my-linear-display-name', 'person: person')
const cleanups: string[] = []
const servers: UiServerHandle[] = []
beforeEach(() => { vi.stubEnv('AK_HARNESS_NO_GLOBAL', '1') })
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const server of servers.splice(0)) await server.close()
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const setup = (local?: string, team?: string): LoadedLoopConfig => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-ui-config-')); cleanups.push(dir)
  const project = team ? editYaml(example, [{ path: ['project', 'team'], value: 'blue' }]) : example
  writeFileSync(join(dir, 'loop.config.yaml'), project)
  if (team) writeFileSync(join(dir, 'loop.config.team.blue.yaml'), team)
  if (local) writeFileSync(join(dir, 'loop.config.local.yaml'), local)
  const loaded = loadLoopConfig(join(dir, 'loop.config.yaml'))
  mkdirSync(loaded.stateDir, { recursive: true })
  return loaded
}
const field = (view: EffectiveConfig, path: string) => view.fields.find((item) => item.path === path)
const localText = (loaded: LoadedLoopConfig): string => readFileSync(join(loaded.root, 'loop.config.local.yaml'), 'utf8')
const refusal = (run: () => unknown): ConfigRefused => { try { run() } catch (error) { if (error instanceof ConfigRefused) return error; throw error } throw new Error('expected a refusal') }

describe('config field metadata', () => {
  it('classifies listed paths and falls back to sensitive/propose for unlisted ones', () => {
    expect(fieldMeta('machine.minFreeRamGb')).toMatchObject({ section: 'machine', classification: 'safe', editable: 'personal' })
    expect(fieldMeta('models.routing.pin.builder')).toMatchObject({ classification: 'safe', editable: 'personal' })
    expect(fieldMeta('delivery.review.votes')).toMatchObject({ classification: 'gate', weaker: 'lower' })
    expect(fieldMeta('project.stateDir').editable).toBe('readonly')
    expect(fieldMeta('orca.bin')).toEqual({ section: 'orca', description: '', classification: 'sensitive', editable: 'propose' })
  })

  it('knows which direction weakens each gate', () => {
    expect(isWeaker('lower', 2, 1)).toBe(true)
    expect(isWeaker('lower', 1, 2)).toBe(false)
    expect(isWeaker('off', true, false)).toBe(true)
    expect(isWeaker('off', false, true)).toBe(false)
    expect(isWeaker('higher-or-zero', 1000, 0)).toBe(true)
    expect(isWeaker('higher-or-zero', 0, 1000)).toBe(false)
    expect(isWeaker('removed', [{ id: 'a' }, { id: 'b' }], [{ id: 'a' }])).toBe(true)
    expect(isWeaker('removed', ['a'], ['a', 'b'])).toBe(false)
    expect(isWeaker('added', [], ['ci'])).toBe(true)
    expect(isWeaker(['nit', 'med', 'high', 'blocker'], 'med', 'high')).toBe(true)
    expect(isWeaker(['nit', 'med', 'high', 'blocker'], 'med', 'nit')).toBe(false)
  })
})

describe('effective config', () => {
  it('attributes each value to the layer it comes from, with file names only', () => {
    const loaded = setup('machine:\n  minFreeRamGb: 8\n', 'machine:\n  warningPercent: 70\n')
    const view = effectiveConfig(loaded)
    expect(field(view, 'machine.minFreeRamGb')).toMatchObject({ value: 8, layer: 'personal' })
    expect(field(view, 'machine.warningPercent')).toMatchObject({ value: 70, layer: 'team-overlay' })
    expect(field(view, 'delivery.maxFixRounds')).toMatchObject({ value: 2, layer: 'team', classification: 'gate' })
    expect(field(view, 'budget.perIssueTokens')).toMatchObject({ layer: 'default' })
    expect(view.layers).toEqual([
      { layer: 'default', file: null }, { layer: 'global', file: null }, { layer: 'team', file: 'loop.config.yaml' },
      { layer: 'team-overlay', file: 'loop.config.team.blue.yaml' }, { layer: 'personal', file: 'loop.config.local.yaml' },
    ])
    expect(JSON.stringify(view)).not.toContain(loaded.root)
    expect(view.weakenedGates).toEqual([])
  })

  it('reports the global layer when present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-ui-config-global-')); cleanups.push(dir)
    writeFileSync(join(dir, 'harness.yaml'), 'machine:\n  ceiling: 3\n')
    vi.stubEnv('AK_HARNESS_NO_GLOBAL', ''); vi.stubEnv('AK_HARNESS_CONFIG', join(dir, 'harness.yaml'))
    const view = effectiveConfig(setup())
    expect(field(view, 'machine.ceiling')).toMatchObject({ value: 3, layer: 'global' })
    expect(view.layers[1]).toEqual({ layer: 'global', file: 'harness.yaml' })
  })

  it('lists personal values weaker than the team value, and surfaces tuning history', () => {
    const loaded = setup('delivery:\n  review:\n    votes: 1\n  maxFixRounds: 0\nbudget:\n  perIssueTokens: 5000\n')
    writeFileSync(tuningStatePath(loaded.stateDir), JSON.stringify({ history: [{ path: 'delivery.workerIdleTimeoutMin', metric: 'stuck-count', from: 40, to: 45, at: '2026-09-20T00:00:00.000Z', reason: 'r', metricBefore: 2, evidence: {}, status: 'applied' }], frozen: ['delivery.workerIdleTimeoutMin'] }))
    const view = effectiveConfig(loaded)
    expect(view.weakenedGates).toEqual(['delivery.maxFixRounds'])
    expect(weakenedGates(loaded)).toEqual(['delivery.maxFixRounds'])
    expect(field(view, 'delivery.workerIdleTimeoutMin')?.tuning).toEqual({ from: 40, to: 45, at: '2026-09-20T00:00:00.000Z', metric: 'stuck-count', frozen: true })
  })
})

describe('personal writes', () => {
  it('writes a safe value into the overlay, keeping comments and other keys', () => {
    const loaded = setup('# mine\nlinear:\n  person: someone # me\n')
    const next = writePersonalConfig(loaded, { changes: [{ path: 'machine.minFreeRamGb', value: 6 }], confirmWeakening: false })
    expect(next.config.machine.minFreeRamGb).toBe(6)
    expect(localText(loaded)).toContain('# mine')
    expect(localText(loaded)).toContain('person: someone # me')
    expect(readFileSync(loaded.path, 'utf8')).toBe(example)
  })

  it('creates the overlay when it does not exist yet, and reset removes a key', () => {
    const loaded = setup()
    writePersonalConfig(loaded, { changes: [{ path: 'machine.minFreeRamGb', value: 6 }], confirmWeakening: false })
    expect(localText(loaded)).toContain('Per-machine overlay')
    const reset = writePersonalConfig(loaded, { changes: [{ path: 'machine.minFreeRamGb', value: null, reset: true }], confirmWeakening: false })
    expect(reset.config.machine.minFreeRamGb).toBe(4)
    expect(localText(loaded)).not.toMatch(/^machine:/m)
  })

  it('refuses team-only and read-only paths', () => {
    const loaded = setup()
    expect(refusal(() => writePersonalConfig(loaded, { changes: [{ path: 'orca.bin', value: 'x' }], confirmWeakening: false }))).toMatchObject({ status: 400, paths: ['orca.bin'] })
    expect(refusal(() => writePersonalConfig(loaded, { changes: [{ path: 'project.stateDir', value: 'x' }], confirmWeakening: false })).status).toBe(400)
    expect(existsSync(join(loaded.root, 'loop.config.local.yaml'))).toBe(false)
  })

  it('refuses an invalid value without touching disk', () => {
    const loaded = setup()
    expect(refusal(() => writePersonalConfig(loaded, { changes: [{ path: 'machine.minFreeRamGb', value: -1 }], confirmWeakening: false })).status).toBe(400)
    expect(existsSync(join(loaded.root, 'loop.config.local.yaml'))).toBe(false)
  })

  it('refuses a gate weakening with 409 unless confirmed, then records it', () => {
    const loaded = setup()
    const change = { changes: [{ path: 'delivery.maxFixRounds', value: 0 }, { path: 'delivery.merge.requireHumanApproval', value: false }] }
    expect(refusal(() => writePersonalConfig(loaded, { ...change, confirmWeakening: false }))).toMatchObject({ status: 409, paths: ['delivery.maxFixRounds'] })
    // Tightening a gate is never a weakening.
    writePersonalConfig(loaded, { changes: [{ path: 'delivery.review.votes', value: 3 }], confirmWeakening: false })
    const next = writePersonalConfig(loaded, { ...change, confirmWeakening: true })
    expect(effectiveConfig(next).weakenedGates).toEqual(['delivery.maxFixRounds'])
    // An unrelated later change does not need a new confirmation.
    expect(() => writePersonalConfig(next, { changes: [{ path: 'machine.floor', value: 1 }], confirmWeakening: false })).not.toThrow()
  })

  it('expresses a gate list removal as a !entry overlay', () => {
    const loaded = setup()
    const next = writePersonalConfig(loaded, { changes: [{ path: 'delivery.selfEditPaths', value: ['loop.config.yaml', 'docs/**'] }], confirmWeakening: true })
    expect(next.config.delivery.selfEditPaths).toEqual(['loop.config.yaml', 'docs/**'])
    expect(localText(loaded)).toContain('"!.github/**"')
    expect(effectiveConfig(next).weakenedGates).toEqual(['delivery.selfEditPaths'])
  })
})

describe('team proposals', () => {
  it('returns a unified diff of loop.config.yaml and never writes it', () => {
    const loaded = setup()
    const proposal = proposeTeamChange(loaded, { changes: [{ path: 'delivery.maxFixRounds', value: 3 }] })
    expect(proposal.file).toBe('loop.config.yaml')
    expect(proposal.diff).toMatch(/^--- a\/loop.config.yaml\n\+\+\+ b\/loop.config.yaml\n@@ -\d+,\d+ \+\d+,\d+ @@/)
    expect(proposal.diff).toContain('-  maxFixRounds: 2')
    expect(proposal.diff).toContain('+  maxFixRounds: 3')
    expect(readFileSync(loaded.path, 'utf8')).toBe(example)
    expect(refusal(() => proposeTeamChange(loaded, { changes: [{ path: 'machine.minFreeRamGb', value: -1 }] })).status).toBe(400)
  })

  it('builds hunks with context', () => {
    expect(unifiedDiff('f', 'a\nb\nc\n', 'a\nB\nc\n')).toBe('--- a/f\n+++ b/f\n@@ -1,4 +1,4 @@\n a\n-b\n+B\n c\n \n')
    expect(unifiedDiff('f', 'x\n', 'x\n')).toBe('')
  })
})

describe('tuning controls', () => {

  it('freezes and unfreezes a knob atomically', () => {
    const loaded = setup()
    expect(setTuningFrozen(loaded.stateDir, 'delivery.workerIdleTimeoutMin', true).frozen).toEqual(['delivery.workerIdleTimeoutMin'])
    setTuningFrozen(loaded.stateDir, 'delivery.workerIdleTimeoutMin', true)
    expect(readTuningState(loaded.stateDir).frozen).toEqual(['delivery.workerIdleTimeoutMin'])
    expect(setTuningFrozen(loaded.stateDir, 'delivery.workerIdleTimeoutMin', false).frozen).toEqual([])
  })

})

const tuned = (): LoadedLoopConfig => {
  const loaded = setup()
  writeFileSync(loaded.path, editYaml(readFileSync(loaded.path, 'utf8'), [{ path: ['delivery', 'workerIdleTimeoutMin'], value: 50 }]))
  writeFileSync(tuningStatePath(loaded.stateDir), JSON.stringify({ history: [{ path: 'delivery.workerIdleTimeoutMin', metric: 'stuck-count', from: 45, to: 50, at: '2026-09-20T00:00:00.000Z', reason: 'r', metricBefore: 2, evidence: {}, status: 'applied' }], frozen: [] }))
  return loaded
}

describe('config HTTP routes', () => {
  const board: IssueBoardCache = { read: async () => ({ provider: 'github', repo: 'acme/app', status: 'fresh', fetchedAt: new Date().toISOString(), issues: [], truncated: false, error: null }) }
  const runner: CommandRunner = { run: async (): Promise<CommandResult> => ({ code: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 }) }
  const start = async (loaded: LoadedLoopConfig) => {
    const server = await startUiServer({ loaded, runner, port: 0, board }); servers.push(server)
    return (path: string, init: RequestInit = {}) => fetch(`${server.url}${path}`, { ...init, headers: { 'x-harness-session': server.token, 'content-type': 'application/json' } })
  }

  it('serves, writes, refreshes the loaded config and records weakened gates on new runs', async () => {
    const loaded = setup()
    const api = await start(loaded)
    expect(((await (await api('api/v1/config')).json()) as EffectiveConfig).fields.length).toBeGreaterThan(50)
    const refused = await api('api/v1/config/local', { method: 'PUT', body: JSON.stringify({ changes: [{ path: 'delivery.maxFixRounds', value: 0 }], confirmWeakening: false }) })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ paths: ['delivery.maxFixRounds'] })
    const saved = await api('api/v1/config/local', { method: 'PUT', body: JSON.stringify({ changes: [{ path: 'delivery.maxFixRounds', value: 0 }], confirmWeakening: true }) })
    expect(saved.status).toBe(200)
    expect(((await saved.json()) as EffectiveConfig).weakenedGates).toEqual(['delivery.maxFixRounds'])
    // The server's own config object now reflects the write: the next run is queued under it.
    expect(loaded.config.delivery.maxFixRounds).toBe(0)
    expect(loaded.localPath).toBeDefined()
    const builder = loaded.config.models.builder[0]![0]!
    const run = await api('api/v1/runs', { method: 'POST', body: JSON.stringify({ issue: 'ENG-1', configHash: loaded.configHash, builder, contractDigest: 'digest-1', preflight: true }) })
    expect(run.status).toBe(202)
    expect(createIssueQueue({ stateDir: loaded.stateDir }).list()[0]?.config.weakenedGates).toEqual(['delivery.maxFixRounds'])
  })

  it('returns a proposal and drives tuning freeze', async () => {
    const loaded = setup()
    const api = await start(loaded)
    const proposal = await (await api('api/v1/config/proposal', { method: 'POST', body: JSON.stringify({ changes: [{ path: 'delivery.maxFixRounds', value: 3 }] }) })).json() as ConfigProposal
    expect(proposal.diff).toContain('+  maxFixRounds: 3')
    expect((await api('api/v1/tuning/freeze', { method: 'POST', body: JSON.stringify({ path: 'delivery.workerIdleTimeoutMin' }) })).status).toBe(200)
    expect(readTuningState(loaded.stateDir).frozen).toEqual(['delivery.workerIdleTimeoutMin'])
    expect((await api('api/v1/tuning/revert', { method: 'POST', body: JSON.stringify({ path: 'delivery.workerIdleTimeoutMin' }) })).status).toBe(400)
  })

  it('reverts a tuned knob as a frozen knob plus a team proposal, leaving the team file untouched', async () => {
    const loaded = tuned()
    const before = readFileSync(loaded.path, 'utf8')
    const api = await start(loaded)
    const response = await api('api/v1/tuning/revert', { method: 'POST', body: JSON.stringify({ path: 'delivery.workerIdleTimeoutMin' }) })
    expect(response.status).toBe(200)
    const result = await response.json() as { proposal: ConfigProposal }
    expect(result.proposal.diff).toContain('+  workerIdleTimeoutMin: 45')
    expect(readFileSync(loaded.path, 'utf8')).toBe(before)
    expect(readTuningState(loaded.stateDir).frozen).toContain('delivery.workerIdleTimeoutMin')
  })
})

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { automationDrift, automationFields, automationSpecs, declaredStages, loadLoopConfig, precheckCommand, reconcileAutomations } from '../src/index.js'
import type { LoadedLoopConfig, OrcaAutomation } from '../src/index.js'

const exampleYaml = readFileSync(join(process.cwd(), 'loop.config.example.yaml'), 'utf8').replace('person: my-linear-display-name', 'person: person')
const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const load = (extra = ''): LoadedLoopConfig => {
  const dir = mkdtempSync(join(tmpdir(), 'agentskit-loop-automations-')); cleanups.push(dir)
  writeFileSync(join(dir, 'loop.config.yaml'), `${exampleYaml}${extra}`)
  return loadLoopConfig(join(dir, 'loop.config.yaml'))
}

const live = (name: string, raw: Record<string, unknown>, overrides: Partial<OrcaAutomation> = {}): OrcaAutomation => ({
  id: `id-${name}`,
  name,
  enabled: raw['enabled'] !== false,
  trigger: typeof raw['rrule'] === 'string' ? raw['rrule'] : '',
  provider: typeof raw['agentId'] === 'string' ? raw['agentId'] : null,
  raw,
  ...overrides,
})

describe('declared automations', () => {
  it('declares tick and deliver always, retro only with its issue, and observe when a cron is set', () => {
    expect(declaredStages(load().config).stages).toEqual(['tick', 'deliver'])
    const halfRetro = load('\n  retro: "0 9 * * 1"\n')
    expect(declaredStages(halfRetro.config).stages).toEqual(['tick', 'deliver'])
    expect(declaredStages(halfRetro.config).notes[0]).toContain('retroIssue is missing')
    const full = load('\n  retro: "0 9 * * 1"\n  retroIssue: ENG-1\n  observe: "*/15 * * * *"\n')
    expect(declaredStages(full.config).stages).toEqual(['tick', 'deliver', 'retro', 'observe'])
    expect(automationSpecs(full, 'claude').map((spec) => spec.name)).toEqual(['loop-my-project-tick', 'loop-my-project-deliver', 'loop-my-project-retro', 'loop-my-project-observe'])
  })

  it('gives observe the shim command and the precheck budget, never the stage budget', () => {
    const loaded = load('\n  observe: "*/15 * * * *"\n')
    const observe = automationSpecs(loaded, 'claude').find((spec) => spec.stage === 'observe')
    expect(observe?.precheck).toBe(`ak-harness loop stage observe -f "${loaded.path}"`)
    expect(observe?.precheckTimeoutSec).toBe(120)
    expect(observe?.trigger).toBe('*/15 * * * *')
    expect(observe?.prompt).toContain('health observer')
    // Even in `agent` runner mode, observe keeps the stage shim: its exit code is the whole point.
    const agentMode = { ...loaded, config: { ...loaded.config, schedule: { ...loaded.config.schedule, runner: 'agent' as const } } }
    expect(precheckCommand(agentMode.config, loaded.path, 'observe')).toContain('loop stage observe')
  })

  it('gives every stage the precheck budget, never the (possibly much longer) stage budget — tick fires a detached worker instead of running inline', () => {
    const loaded = load('\n  retro: "0 9 * * 1"\n  retroIssue: ENG-1\n  observe: "*/15 * * * *"\n')
    const longStage = { ...loaded, config: { ...loaded.config, schedule: { ...loaded.config.schedule, stageTimeoutSec: 2700 } } }
    for (const spec of automationSpecs(longStage, 'claude')) expect(spec.precheckTimeoutSec).toBe(120)
  })
})

describe('automation drift', () => {
  const rawFor = (loaded: LoadedLoopConfig, name: string, stage: 'tick' | 'deliver'): Record<string, unknown> => {
    const spec = automationSpecs(loaded, 'claude').find((item) => item.stage === stage)!
    return { rrule: spec.trigger, prompt: spec.prompt, precheck: { command: spec.precheck, timeoutSeconds: spec.precheckTimeoutSec }, agentId: 'claude', workspaceId: `repo-1::${loaded.root}`, enabled: true, name }
  }

  it('reports no drift when the live automation matches, including Orca\'s repo-prefixed workspace id', () => {
    const loaded = load()
    const spec = automationSpecs(loaded, 'claude')[0]!
    expect(automationDrift(spec, live('loop-my-project-tick', rawFor(loaded, 'loop-my-project-tick', 'tick')))).toEqual([])
  })

  it('reports no workspace drift against Orca\'s forward-slash-normalized path, even from a backslash root', () => {
    const loaded = load()
    const spec = automationSpecs(loaded, 'claude')[0]!
    const raw = { ...rawFor(loaded, 'loop-my-project-tick', 'tick'), workspaceId: `repo-1::${loaded.root.replace(/\\/g, '/')}` }
    expect(automationDrift(spec, live('loop-my-project-tick', raw))).toEqual([])
  })

  it('names every field that drifted, and stays silent about fields Orca did not report', () => {
    const loaded = load()
    const spec = automationSpecs(loaded, 'claude')[0]!
    const raw = { ...rawFor(loaded, 'loop-my-project-tick', 'tick'), rrule: '0 3 * * *', prompt: 'hand-edited', precheck: { command: 'ak-harness loop stage tick -f "/old/loop.config.yaml"', timeoutSeconds: 60 }, agentId: 'codex', workspaceId: 'repo-1::/somewhere/else', enabled: false }
    expect(automationDrift(spec, live('loop-my-project-tick', raw))).toEqual(['trigger', 'prompt', 'precheck', 'precheckTimeout', 'provider', 'workspace', 'enabled'])
    const sparse = live('loop-my-project-tick', { rrule: spec.trigger, enabled: true })
    expect(automationDrift(spec, sparse)).toEqual([])
    expect(automationFields(sparse)).toMatchObject({ prompt: null, precheck: null, precheckTimeoutSec: null, workspace: null })
  })

  it('leaves the provider alone when the caller did not resolve one', () => {
    const loaded = load()
    const spec = { ...automationSpecs(loaded, 'claude')[0]!, provider: '' }
    expect(automationDrift(spec, live('loop-my-project-tick', { ...rawFor(loaded, 'loop-my-project-tick', 'tick'), agentId: 'codex' }))).toEqual([])
  })

  it('classifies every managed automation: in sync, missing, drifted, or no longer declared', () => {
    const loaded = load()
    const specs = automationSpecs(loaded, 'claude')
    const existing = [
      live('loop-my-project-tick', rawFor(loaded, 'loop-my-project-tick', 'tick')),
      live('loop-my-project-deliver', { ...rawFor(loaded, 'loop-my-project-deliver', 'deliver'), rrule: '0 * * * *' }),
      live('loop-my-project-retro', { rrule: '0 9 * * 1', enabled: true }),
      live('loop-my-project-observe', { rrule: '*/15 * * * *', enabled: false }),
      live('someone-else', { rrule: 'daily', enabled: true }),
    ]
    expect(reconcileAutomations(specs, existing, loaded.config)).toEqual([
      { name: 'loop-my-project-tick', stage: 'tick', state: 'in-sync', fields: [] },
      { name: 'loop-my-project-deliver', stage: 'deliver', state: 'drifted', fields: ['trigger'] },
      // loop-my-project-retro is not declared by this config but is still running: that is reported, not ignored.
      { name: 'loop-my-project-retro', stage: 'retro', state: 'undeclared', fields: [] },
    ])
    expect(reconcileAutomations(specs, [], loaded.config).map((row) => row.state)).toEqual(['missing', 'missing'])
  })
})

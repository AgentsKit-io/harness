import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyRoleSettings, parseLoopConfigText, resolveFlow, resolveFlowSettings, resolveRoleSettings, unknownFlowReferences, workerPhaseEnabled } from '../src/index.js'
import type { LoopConfig } from '../src/index.js'

const exampleYaml = readFileSync(join(process.cwd(), 'loop.config.example.yaml'), 'utf8').replace('person: my-linear-display-name', 'person: person')

const FLOWS = `
flows:
  default: enterprise
  profiles:
    enterprise:
      review: { votes: 2, minSeverity: nit }
      merge: { requireChecks: true, requireHumanApproval: true }
      reason: critical path
    poc:
      review: { votes: 1, minSeverity: high, profile: fast }
      merge: { requireChecks: false }
      maxFixRounds: 1
    incident:
      review: { votes: 1, minSeverity: blocker }
      merge: { requireChecks: false, requireHumanApproval: false }
      roles:
        orchestrator: { provider: codex, model: gpt-5.6-sol, effort: xhigh, timeoutMs: 60000 }
        review: { effort: low }
      stages: { review: false, verify: true }
  select:
    - flow: incident
      anyLabels: [sev1]
      priorities: [Urgent]
    - flow: poc
      projects: [Spikes]
      priorities: [Low]
`

const config = (extra = FLOWS): LoopConfig => parseLoopConfigText(`${exampleYaml}${extra}`)

describe('flow selection', () => {
  it('prefers an explicit flow: label over every rule and signal', () => {
    expect(resolveFlow(config(), { labels: ['flow:poc', 'sev1'], priorityLabel: 'Urgent', project: 'Spikes' })).toMatchObject({ name: 'poc', source: 'flow-label', matched: 'flow:poc' })
    // A flow: label naming a profile that does not exist is not an intention the loop can honour; the rules decide.
    expect(resolveFlow(config(), { labels: ['flow:ghost', 'sev1'] })).toMatchObject({ name: 'incident', source: 'label', matched: 'sev1' })
  })

  it('ranks label over project over priority, never by position in the list', () => {
    expect(resolveFlow(config(), { labels: ['sev1'], project: 'Spikes', priorityLabel: 'Low' })).toMatchObject({ name: 'incident', source: 'label' })
    expect(resolveFlow(config(), { project: 'Spikes', priorityLabel: 'Urgent' })).toMatchObject({ name: 'poc', source: 'project', matched: 'Spikes' })
    expect(resolveFlow(config(), { priorityLabel: 'Urgent' })).toMatchObject({ name: 'incident', source: 'priority', matched: 'Urgent' })
  })

  it('falls back to the declared default, and to nothing at all when none is declared', () => {
    expect(resolveFlow(config(), {})).toMatchObject({ name: 'enterprise', source: 'default' })
    expect(resolveFlow(config(''), { labels: ['sev1'] })).toEqual({ name: null, source: 'none', matched: null, profile: null })
  })

  it('names the flows a rule or the default references but never defines', () => {
    expect(unknownFlowReferences(config())).toEqual([])
    expect(unknownFlowReferences(config('\nflows:\n  default: ghost\n  select:\n    - flow: phantom\n      anyLabels: [x]\n'))).toEqual(['ghost', 'phantom'])
  })
})

describe('effective settings under a flow', () => {
  it('replaces only the fields the profile names, on top of the label overrides', () => {
    const settings = resolveFlowSettings(config(), { labels: ['sev1'] })
    expect(settings.flow.name).toBe('incident')
    expect(settings.review).toMatchObject({ votes: 1, minSeverity: 'blocker' })
    // Untouched by the profile: they still come from delivery.review.
    expect(settings.review.cli).toBe('agentskit-review')
    expect(settings.review.concurrency).toBe(4)
    expect(settings.merge.requireChecks).toBe(false)
    expect(settings.merge.method).toBe('squash')
  })

  it('keeps the project settings when no flow matches and nothing is declared', () => {
    const settings = resolveFlowSettings(config(''), {})
    expect(settings.flow.name).toBeNull()
    expect(settings.merge).toEqual(parseLoopConfigText(exampleYaml).delivery.merge)
    expect(settings.maxFixRounds).toBe(2)
  })

  it('lets a flow tighten the fix-round ceiling', () => {
    expect(resolveFlowSettings(config(), { project: 'Spikes' }).maxFixRounds).toBe(1)
    expect(resolveFlowSettings(config(), {}).maxFixRounds).toBe(2)
  })
})

describe('role settings inside a profile', () => {
  const incident = (): ReturnType<typeof resolveFlow> => resolveFlow(config(), { labels: ['sev1'] })

  it('lets the profile name who runs a role, and falls back to the project otherwise', () => {
    const pinned = resolveRoleSettings(config(), incident(), 'orchestrator')
    expect(pinned).toMatchObject({ provider: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh', timeoutMs: 60_000, source: 'flow', list: 'orchestrator' })
    // A role the profile says nothing about keeps the project's effort and no leash of its own.
    const untouched = resolveRoleSettings(config(), incident(), 'builder')
    expect(untouched).toMatchObject({ provider: null, model: null, timeoutMs: null, source: 'config', list: 'builder' })
    expect(untouched.effort).toBe(parseLoopConfigText(exampleYaml).models.effort.builder)
    // The finer phases borrow the model list their work resembles.
    expect(resolveRoleSettings(config(), incident(), 'planner').list).toBe('orchestrator')
    expect(resolveRoleSettings(config(), incident(), 'vote').list).toBe('reviewer')
    expect(resolveRoleSettings(config(), null, 'review').source).toBe('config')
  })

  it('narrows the candidate list to the pin, and falls through when nobody can serve it', () => {
    const settings = resolveRoleSettings(config(), incident(), 'orchestrator')
    const candidates = [
      { provider: 'claude', model: 'opus', effort: 'medium' as const },
      { provider: 'codex', model: 'gpt-5.6-sol', effort: 'medium' as const },
    ]
    expect(applyRoleSettings(candidates, settings)[0]).toMatchObject({ provider: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh' })
    // The pin is a preference, never an outage: with nobody to serve it the ordinary candidates stand, still
    // carrying the flow's effort.
    expect(applyRoleSettings([candidates[0]!], settings)).toEqual([{ provider: 'claude', model: 'opus', effort: 'xhigh' }])
  })
})

describe('which phases run for one issue', () => {
  it('reads the flow toggle first, then worker.roles, then the phase own block', () => {
    const flow = resolveFlow(config(), { labels: ['sev1'] })
    expect(workerPhaseEnabled(config(), flow, 'review', true)).toBe(false) // stages: { review: false }
    expect(workerPhaseEnabled(config(), flow, 'verify', false)).toBe(true) // stages: { verify: true }
    expect(workerPhaseEnabled(config(), flow, 'dod', true)).toBe(true) // not named: the fallback answers
    expect(workerPhaseEnabled(config(), flow, 'builder', false)).toBe(true) // the work itself always runs

    // An explicit worker.roles list is the answer for every phase it does not name.
    const declared = config('\nworker:\n  roles: [builder, review]\n')
    expect(workerPhaseEnabled(declared, null, 'review', false)).toBe(true)
    expect(workerPhaseEnabled(declared, null, 'dod', true)).toBe(false)
    // Undeclared, every phase keeps answering from its own block — nothing changes for a project that never opted in.
    expect(workerPhaseEnabled(config(), null, 'dod', true)).toBe(true)
    expect(workerPhaseEnabled(config(), null, 'planner', false)).toBe(false)
  })
})

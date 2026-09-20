import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseLoopConfigText, resolveFlow, resolveFlowSettings, unknownFlowReferences } from '../src/index.js'
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

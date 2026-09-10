import { fail } from './errors.js'
import { hashJson } from './hash.js'

export const COMPATIBILITY_SCHEMA_VERSION = 1 as const
export const COMPATIBILITY_COMPONENTS = ['core', 'memory', 'eval', 'doc-bridge', 'code-review', 'adapter-boundary', 'runtime'] as const
export type CompatibilityComponentId = typeof COMPATIBILITY_COMPONENTS[number]
export type CompatibilityStatus = 'passed' | 'failed' | 'unknown'

export interface CompatibilityComponent {
  readonly id: CompatibilityComponentId
  readonly package: string
  readonly version: string
  readonly revision: string
  readonly repository: string
  readonly adapterBoundary: 'real-adapter'
  readonly testCommand: string
  readonly evalCommand: string
  readonly previousVersion: string
  readonly noHarnessBaseline: string
  readonly migrationEvidence: string
  readonly rollbackEvidence: string
}

export interface CompatibilityManifest {
  readonly type: 'agentskit-harness-compatibility-manifest'
  readonly schemaVersion: typeof COMPATIBILITY_SCHEMA_VERSION
  readonly harnessVersion: string
  readonly sourceRevision: string
  readonly components: readonly CompatibilityComponent[]
  readonly evidenceOutputs: readonly string[]
  readonly digest: string
}

export interface CompatibilityObservation {
  readonly componentId: CompatibilityComponentId
  readonly status: CompatibilityStatus
  readonly evidence?: string
  readonly previousVersion?: string
  readonly noHarnessBaseline?: string
}

export interface CompatibilityReport {
  readonly status: 'passed' | 'blocked'
  readonly componentCount: number
  readonly observations: readonly CompatibilityObservation[]
  readonly blockers: readonly string[]
}

const text = (value: unknown, label: string): string => {
  const result = typeof value === 'string' ? value.trim() : ''
  if (!result) fail(`${label} is required.`, 'INVALID_INPUT')
  return result
}

const sha = (value: unknown, label: string): string => {
  const result = text(value, label)
  if (!/^[a-f0-9]{40,64}$/.test(result)) fail(`${label} must be a pinned git revision.`, 'INVALID_INPUT')
  return result
}

const component = (value: unknown, index: number): CompatibilityComponent => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`components[${index}] must be an object.`, 'INVALID_INPUT')
  const candidate = value as Record<string, unknown>
  const id = text(candidate['id'], `components[${index}].id`)
  if (!(COMPATIBILITY_COMPONENTS as readonly string[]).includes(id)) fail(`components[${index}].id is invalid.`, 'INVALID_INPUT')
  if (candidate['adapterBoundary'] !== 'real-adapter') fail(`components[${index}] must use the real-adapter boundary.`, 'INVALID_INPUT')
  return {
    id: id as CompatibilityComponentId,
    package: text(candidate['package'], `components[${index}].package`), version: text(candidate['version'], `components[${index}].version`),
    revision: sha(candidate['revision'], `components[${index}].revision`), repository: text(candidate['repository'], `components[${index}].repository`), adapterBoundary: 'real-adapter',
    testCommand: text(candidate['testCommand'], `components[${index}].testCommand`), evalCommand: text(candidate['evalCommand'], `components[${index}].evalCommand`),
    previousVersion: text(candidate['previousVersion'], `components[${index}].previousVersion`), noHarnessBaseline: text(candidate['noHarnessBaseline'], `components[${index}].noHarnessBaseline`),
    migrationEvidence: text(candidate['migrationEvidence'], `components[${index}].migrationEvidence`), rollbackEvidence: text(candidate['rollbackEvidence'], `components[${index}].rollbackEvidence`),
  }
}

const body = (value: Record<string, unknown>): Omit<CompatibilityManifest, 'digest'> => {
  const componentsValue = value['components']
  if (!Array.isArray(componentsValue) || !componentsValue.length) fail('components must be a non-empty array.', 'INVALID_INPUT')
  const components = (componentsValue as readonly unknown[]).map(component)
  if (new Set(components.map((item) => item.id)).size !== components.length) fail('component ids must be unique.', 'INVALID_INPUT')
  const missing = COMPATIBILITY_COMPONENTS.filter((id) => !components.some((item) => item.id === id))
  if (missing.length) fail(`components must cover: ${missing.join(', ')}.`, 'INVALID_INPUT')
  const outputs = value['evidenceOutputs']
  if (!Array.isArray(outputs) || !outputs.length) fail('evidenceOutputs must be a non-empty array.', 'INVALID_INPUT')
  return {
    type: 'agentskit-harness-compatibility-manifest', schemaVersion: COMPATIBILITY_SCHEMA_VERSION,
    harnessVersion: text(value['harnessVersion'], 'harnessVersion'), sourceRevision: sha(value['sourceRevision'], 'sourceRevision'), components,
    evidenceOutputs: (outputs as readonly unknown[]).map((item, index) => text(item, `evidenceOutputs[${index}]`)),
  }
}

export const createCompatibilityManifest = (input: Omit<CompatibilityManifest, 'type' | 'schemaVersion' | 'digest'>): CompatibilityManifest => {
  const value = body(input as unknown as Record<string, unknown>)
  return { ...value, digest: hashJson(value) }
}

export const validateCompatibilityManifest = (value: unknown): CompatibilityManifest => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('Compatibility manifest must be an object.', 'INVALID_INPUT')
  const candidate = value as Record<string, unknown>
  const valueBody = body(candidate)
  if (candidate['type'] !== valueBody.type || candidate['schemaVersion'] !== valueBody.schemaVersion) fail('Compatibility manifest type or schemaVersion is invalid.', 'INVALID_INPUT')
  const digest = text(candidate['digest'], 'digest')
  if (digest !== hashJson(valueBody)) fail('Compatibility manifest digest is invalid.', 'INVALID_INPUT')
  return { ...valueBody, digest }
}

export const assessCompatibility = ({ manifest, observations }: { readonly manifest: CompatibilityManifest; readonly observations: readonly CompatibilityObservation[] }): CompatibilityReport => {
  const validated = validateCompatibilityManifest(manifest)
  const expected = new Set(validated.components.map((item) => item.id))
  const seen = new Set<CompatibilityComponentId>()
  const blockers: string[] = []
  observations.forEach((observation) => {
    if (!expected.has(observation.componentId) || seen.has(observation.componentId)) blockers.push(`${observation.componentId}: unexpected or duplicate observation`)
    seen.add(observation.componentId)
    if (observation.status !== 'passed') blockers.push(`${observation.componentId}: ${observation.status} compatibility evidence`)
    if (!observation.evidence) blockers.push(`${observation.componentId}: missing evidence`)
  })
  validated.components.forEach((item) => {
    if (!seen.has(item.id)) blockers.push(`${item.id}: missing observation`)
    const observation = observations.find((candidate) => candidate.componentId === item.id)
    if (observation && observation.previousVersion !== item.previousVersion) blockers.push(`${item.id}: previous version binding mismatch`)
    if (observation && observation.noHarnessBaseline !== item.noHarnessBaseline) blockers.push(`${item.id}: no-Harness baseline binding mismatch`)
  })
  return { status: blockers.length ? 'blocked' : 'passed', componentCount: validated.components.length, observations, blockers }
}

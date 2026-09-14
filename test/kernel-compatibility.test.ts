import { describe, expect, it } from 'vitest'
import { COMPATIBILITY_COMPONENTS, assessCompatibility, createCompatibilityManifest, validateCompatibilityManifest } from '../src/index.js'
import type { CompatibilityComponent, CompatibilityManifest } from '../src/index.js'

const revision = 'a'.repeat(40)
const componentFor = (id: (typeof COMPATIBILITY_COMPONENTS)[number], overrides: Partial<CompatibilityComponent> = {}): CompatibilityComponent => ({ id, package: `@agentskit/${id}`, version: '1.0.0', revision, repository: 'https://github.com/AgentsKit-io/agentskit', adapterBoundary: 'real-adapter' as const, testCommand: `test:${id}`, evalCommand: `eval:${id}`, previousVersion: `@agentskit/${id}@0.9.0`, noHarnessBaseline: 'baseline.json', migrationEvidence: 'migration.md', rollbackEvidence: 'rollback.md', ...overrides })
const allComponents = COMPATIBILITY_COMPONENTS.map((id) => componentFor(id))
const manifestInput = (overrides: Partial<Omit<CompatibilityManifest, 'type' | 'schemaVersion' | 'digest'>> = {}) => ({
  harnessVersion: '0.3.0', sourceRevision: revision, components: allComponents, evidenceOutputs: ['report.json', 'report.md', 'migration.md', 'rollback.md'], ...overrides,
})

describe('createCompatibilityManifest', () => {
  it('rejects a non-array or empty components list', () => {
    expect(() => createCompatibilityManifest(manifestInput({ components: [] }))).toThrow(/components must be a non-empty array/)
    expect(() => createCompatibilityManifest(manifestInput({ components: 'nope' as never }))).toThrow(/components must be a non-empty array/)
  })

  it('rejects a malformed component entry', () => {
    expect(() => createCompatibilityManifest(manifestInput({ components: [null as never] }))).toThrow(/components\[0\] must be an object/)
    expect(() => createCompatibilityManifest(manifestInput({ components: [componentFor('core', { id: 'not-a-component' as never })] }))).toThrow(/components\[0\].id is invalid/)
    expect(() => createCompatibilityManifest(manifestInput({ components: [componentFor('core', { adapterBoundary: 'mock' as never })] }))).toThrow(/must use the real-adapter boundary/)
  })

  it('rejects a blank field on a component', () => {
    expect(() => createCompatibilityManifest(manifestInput({ components: [componentFor('core', { package: '' })] }))).toThrow(/components\[0\].package is required/)
  })

  it('rejects a malformed revision on a component or the manifest', () => {
    expect(() => createCompatibilityManifest(manifestInput({ components: [componentFor('core', { revision: 'not-a-sha' })] }))).toThrow(/components\[0\].revision must be a pinned git revision/)
    expect(() => createCompatibilityManifest(manifestInput({ sourceRevision: 'not-a-sha' }))).toThrow(/sourceRevision must be a pinned git revision/)
  })

  it('rejects duplicate component ids and a components list missing required coverage', () => {
    expect(() => createCompatibilityManifest(manifestInput({ components: [allComponents[0]!, allComponents[0]!] }))).toThrow(/component ids must be unique/)
    expect(() => createCompatibilityManifest(manifestInput({ components: [allComponents[0]!] }))).toThrow(/components must cover:/)
  })

  it('rejects an empty/non-array/blank-entry evidenceOutputs list', () => {
    expect(() => createCompatibilityManifest(manifestInput({ evidenceOutputs: [] }))).toThrow(/evidenceOutputs must be a non-empty array/)
    expect(() => createCompatibilityManifest(manifestInput({ evidenceOutputs: 'nope' as never }))).toThrow(/evidenceOutputs must be a non-empty array/)
    expect(() => createCompatibilityManifest(manifestInput({ evidenceOutputs: [''] }))).toThrow(/evidenceOutputs\[0\] is required/)
  })

  it('rejects a blank harnessVersion', () => {
    expect(() => createCompatibilityManifest(manifestInput({ harnessVersion: '' }))).toThrow(/harnessVersion is required/)
  })
})

describe('validateCompatibilityManifest', () => {
  const manifest = createCompatibilityManifest(manifestInput())

  it('rejects a non-object value', () => {
    expect(() => validateCompatibilityManifest(null)).toThrow(/must be an object/)
    expect(() => validateCompatibilityManifest([])).toThrow(/must be an object/)
  })

  it('rejects a wrong type/schemaVersion', () => {
    expect(() => validateCompatibilityManifest({ ...manifest, type: 'wrong' })).toThrow(/type or schemaVersion is invalid/)
    expect(() => validateCompatibilityManifest({ ...manifest, schemaVersion: 2 })).toThrow(/type or schemaVersion is invalid/)
  })

  it('rejects a tampered digest', () => {
    expect(() => validateCompatibilityManifest({ ...manifest, digest: 'a'.repeat(64) })).toThrow(/digest is invalid/)
  })
})

describe('assessCompatibility', () => {
  const manifest = createCompatibilityManifest(manifestInput())
  const observation = (id: (typeof COMPATIBILITY_COMPONENTS)[number], overrides: Record<string, unknown> = {}) => ({ componentId: id, status: 'passed' as const, evidence: `run:${id}`, previousVersion: `@agentskit/${id}@0.9.0`, noHarnessBaseline: 'baseline.json', ...overrides })
  const allObservations = COMPATIBILITY_COMPONENTS.map((id) => observation(id))

  it('blocks an observation with no evidence', () => {
    const observations = [observation('core', { evidence: undefined }), ...allObservations.slice(1)]
    const report = assessCompatibility({ manifest, observations })
    expect(report.blockers).toContain('core: missing evidence')
  })

  it('blocks an unexpected component id and a duplicate observation for the same component', () => {
    const withUnexpected = assessCompatibility({ manifest, observations: [...allObservations, { componentId: 'not-a-real-id' as never, status: 'passed', evidence: 'x' }] })
    expect(withUnexpected.blockers.some((b) => b.includes('unexpected or duplicate'))).toBe(true)
    const withDuplicate = assessCompatibility({ manifest, observations: [...allObservations, observation('core')] })
    expect(withDuplicate.blockers.some((b) => b.startsWith('core: unexpected or duplicate'))).toBe(true)
  })

  it('blocks a previousVersion or noHarnessBaseline binding mismatch', () => {
    const wrongPrevious = assessCompatibility({ manifest, observations: [observation('core', { previousVersion: 'wrong' }), ...allObservations.slice(1)] })
    expect(wrongPrevious.blockers).toContain('core: previous version binding mismatch')
    const wrongBaseline = assessCompatibility({ manifest, observations: [observation('core', { noHarnessBaseline: 'wrong' }), ...allObservations.slice(1)] })
    expect(wrongBaseline.blockers).toContain('core: no-Harness baseline binding mismatch')
  })

  it('blocks a component with no observation at all', () => {
    const report = assessCompatibility({ manifest, observations: allObservations.slice(1) })
    expect(report.blockers).toContain(`${COMPATIBILITY_COMPONENTS[0]}: missing observation`)
  })
})

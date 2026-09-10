import { expect, it } from 'vitest'
import { COMPATIBILITY_COMPONENTS, assessCompatibility, createCompatibilityManifest, validateCompatibilityManifest } from '../src/index.js'

const revision = 'a'.repeat(40)
const manifest = createCompatibilityManifest({
  harnessVersion: '0.3.0', sourceRevision: revision,
  components: COMPATIBILITY_COMPONENTS.map((id) => ({ id, package: `@agentskit/${id}`, version: '1.0.0', revision, repository: 'https://github.com/AgentsKit-io/agentskit', adapterBoundary: 'real-adapter' as const, testCommand: `test:${id}`, evalCommand: `eval:${id}`, previousVersion: `@agentskit/${id}@0.9.0`, noHarnessBaseline: 'baseline.json', migrationEvidence: 'migration.md', rollbackEvidence: 'rollback.md' })),
  evidenceOutputs: ['report.json', 'report.md', 'migration.md', 'rollback.md'],
})

it('validates the pinned compatibility manifest and all component boundaries', () => {
  expect(validateCompatibilityManifest(manifest)).toEqual(manifest)
})

it('passes only complete, evidence-bound observations', () => {
  const observations = COMPATIBILITY_COMPONENTS.map((componentId) => ({ componentId, status: 'passed' as const, evidence: `run:${componentId}`, previousVersion: `@agentskit/${componentId}@0.9.0`, noHarnessBaseline: 'baseline.json' }))
  expect(assessCompatibility({ manifest, observations }).status).toBe('passed')
  expect(assessCompatibility({ manifest, observations: observations.slice(1) }).status).toBe('blocked')
})

it('blocks unknown and failed upstream evidence instead of treating it as success', () => {
  const observations = COMPATIBILITY_COMPONENTS.map((componentId) => ({ componentId, status: componentId === 'memory' ? 'unknown' as const : 'passed' as const, evidence: `run:${componentId}`, previousVersion: `@agentskit/${componentId}@0.9.0`, noHarnessBaseline: 'baseline.json' }))
  const report = assessCompatibility({ manifest, observations })
  expect(report.status).toBe('blocked')
  expect(report.blockers).toContain('memory: unknown compatibility evidence')
})

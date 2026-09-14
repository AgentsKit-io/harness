import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FileArtifactStore, FileEventStore, artifactDigest, artifactIsFresh, createArtifactEnvelope, createPhaseArtifact, executePhaseProfile, readArtifactFile, renderArtifactMarkdown, resumeStateFromArtifacts, validateArtifactEnvelope } from '../src/index.js'
import { sha256 } from '../src/kernel/hash.js'

const digest = (value: string): string => sha256(value)
const base = { artifactVersion: 1, runId: 'run-1', issueRef: 'github:AgentsKit-io/harness#12', sourceRevision: 'revision-1', contractHash: digest('contract'), configHash: digest('config'), contextHash: digest('context'), phase: 'discover' }

it('creates a versioned provenance envelope and deterministic identity', () => {
  const first = createArtifactEnvelope({ ...base, artifactType: 'plan', payload: { steps: ['discover', 'implement'] }, createdAt: '2026-09-10T00:00:00.000Z' })
  const second = createArtifactEnvelope({ ...base, artifactType: 'plan', payload: { steps: ['discover', 'implement'] }, createdAt: '2026-09-10T00:01:00.000Z' })
  expect(first.artifactId).toBe(second.artifactId)
  expect(first.artifactHash).toBe(second.artifactHash)
  expect(validateArtifactEnvelope(first)).toEqual(first)
  expect(() => validateArtifactEnvelope({ ...first, payload: { steps: ['tampered'] } })).toThrow(/payloadHash/)
  expect(artifactIsFresh(first, base)).toBe(true)
  expect(artifactIsFresh(first, { ...base, sourceRevision: 'revision-2' })).toBe(false)
})

it('persists JSON and Markdown once and records one idempotent event', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'agentskit-harness-artifact-test-'))
  const artifact = createArtifactEnvelope({ ...base, artifactType: 'decision', payload: { decision: 'use-safe-mode', rationale: 'external side effects' } })
  const store = new FileArtifactStore(stateDir)
  expect(store.write(artifact)).toEqual(artifact)
  expect(store.write(artifact)).toEqual(artifact)
  expect(existsSync(join(stateDir, 'runs', artifact.runId, 'artifacts', `${artifact.artifactId}.json`))).toBe(true)
  expect(existsSync(join(stateDir, 'runs', artifact.runId, 'artifacts', `${artifact.artifactId}.md`))).toBe(true)
  expect(store.list(artifact.runId)).toHaveLength(1)
  expect(new FileArtifactStore(stateDir).read(artifact.runId, artifact.artifactId).artifactHash).toBe(artifact.artifactHash)
  expect(new FileEventStore(stateDir).read(artifact.runId).map((event) => event.type)).toEqual(['artifact.recorded'])
})

it('rejects rewriting the same artifactId with different content, and lists an empty run as []', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'agentskit-harness-artifact-conflict-'))
  const store = new FileArtifactStore(stateDir)
  const artifact = createArtifactEnvelope({ ...base, artifactType: 'decision', payload: { decision: 'a' } })
  store.write(artifact)
  const conflicting = createArtifactEnvelope({ ...base, artifactType: 'decision', payload: { decision: 'b' }, artifactId: artifact.artifactId })
  expect(() => store.write(conflicting)).toThrow(/already exists with different content/)
  expect(store.list('no-such-run')).toEqual([])
})

it('renders readable Markdown and computes a stable digest', () => {
  const artifact = createArtifactEnvelope({ ...base, artifactType: 'finding', payload: { detail: 'x' } })
  const markdown = renderArtifactMarkdown(artifact)
  expect(markdown).toContain(`# finding artifact ${artifact.artifactId}`)
  expect(markdown).toContain(artifact.runId)
  expect(artifactDigest(artifact)).toBe(sha256(JSON.stringify(artifact)))
})

it('reads and validates an artifact envelope from a file path', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'agentskit-harness-artifact-readfile-'))
  const artifact = createArtifactEnvelope({ ...base, artifactType: 'finding', payload: { detail: 'x' } })
  const path = join(stateDir, 'a.json')
  writeFileSync(path, JSON.stringify(artifact))
  expect(readArtifactFile(path)).toEqual(artifact)
})

it('validateArtifactEnvelope rejects every malformed field', () => {
  const valid = createArtifactEnvelope({ ...base, artifactType: 'finding', payload: { detail: 'x' } })
  expect(() => validateArtifactEnvelope(null)).toThrow(/must be an object/)
  expect(() => validateArtifactEnvelope({ ...valid, type: 'wrong' })).toThrow(/type or schemaVersion is invalid/)
  expect(() => validateArtifactEnvelope({ ...valid, schemaVersion: 2 })).toThrow(/type or schemaVersion is invalid/)
  expect(() => validateArtifactEnvelope({ ...valid, artifactType: 'not-a-type' })).toThrow(/artifactType is invalid/)
  expect(() => validateArtifactEnvelope({ ...valid, artifactVersion: 0 })).toThrow(/artifactVersion must be a positive integer/)
  expect(() => validateArtifactEnvelope({ ...valid, createdAt: 'not-a-date' })).toThrow(/createdAt must be a valid timestamp/)
  expect(() => validateArtifactEnvelope({ ...valid, payloadHash: 'not-hex' })).toThrow(/lowercase SHA-256 digest/)
  expect(() => validateArtifactEnvelope({ ...valid, artifactId: '!!!' })).toThrow(/artifactId is invalid/)
  expect(() => validateArtifactEnvelope({ ...valid, contractHash: 'not-hex' })).toThrow(/lowercase SHA-256 digest/)
  expect(() => validateArtifactEnvelope({ ...valid, runId: '' })).toThrow(/runId is required/)
  expect(() => validateArtifactEnvelope({ ...valid, artifactHash: 'a'.repeat(64) })).toThrow(/artifactHash does not match envelope/)
})

it('createArtifactEnvelope rejects an invalid artifactType and a mismatched explicit payloadHash', () => {
  expect(() => createArtifactEnvelope({ ...base, artifactType: 'not-a-type' as never, payload: {} })).toThrow(/artifactType is invalid/)
  expect(() => createArtifactEnvelope({ ...base, artifactType: 'plan', payload: { a: 1 }, payloadHash: 'a'.repeat(64) })).toThrow(/payloadHash does not match payload/)
})

it('builds resume state from phase artifacts without replaying completed handlers', async () => {
  const discover = createPhaseArtifact({ ...base, artifactVersion: 1 }, { id: 'discover', effect: 'read', decision: 'pass', attempts: 1, skipped: false, outputs: { plan: 'restored' } })
  const resume = resumeStateFromArtifacts([discover])
  let discoverCalls = 0
  let implementCalls = 0
  const report = await executePhaseProfile({ id: 'resume', mode: 'yolo', phases: [{ id: 'discover', outputs: ['plan'], effect: 'read' }, { id: 'implement', inputs: ['plan'], outputs: ['change'], dependsOn: ['discover'], effect: 'write' }] }, {
    resume,
    handlers: {
      discover: async () => { discoverCalls += 1; return { decision: 'pass', outputs: { plan: 'replayed' } } },
      implement: async ({ inputs }) => { implementCalls += 1; return { decision: 'pass', outputs: { change: inputs.plan === 'restored' ? 'done' : 'wrong' } } },
    },
    preflight: async () => ({ decision: 'pass' }),
  })
  expect(report.status).toBe('passed')
  expect(report.resumed).toBe(true)
  expect(discoverCalls).toBe(0)
  expect(implementCalls).toBe(1)
  expect(report.outputs).toEqual({ plan: 'restored', change: 'done' })
})

it('resumeStateFromArtifacts ignores non-phase artifacts and non-pass phase decisions, and keeps the latest version', () => {
  const decision = createArtifactEnvelope({ ...base, artifactType: 'decision', payload: { x: 1 } })
  const failedPhase = createPhaseArtifact({ ...base, artifactVersion: 1 }, { id: 'discover', effect: 'read', decision: 'block', attempts: 1, skipped: false })
  const v1 = createPhaseArtifact({ ...base, artifactVersion: 1 }, { id: 'implement', effect: 'write', decision: 'pass', attempts: 1, skipped: false, outputs: { change: 'v1' } })
  const v2 = createPhaseArtifact({ ...base, artifactVersion: 2 }, { id: 'implement', effect: 'write', decision: 'pass', attempts: 2, skipped: false, outputs: { change: 'v2' } })
  const resume = resumeStateFromArtifacts([decision, failedPhase, v1, v2])
  expect(resume.completed['discover']).toBeUndefined()
  expect(resume.completed['implement']).toMatchObject({ outputs: { change: 'v2' } })
  expect(resume.outputs).toEqual({ change: 'v2' })
})

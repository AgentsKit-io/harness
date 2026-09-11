import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FileArtifactStore, FileEventStore, artifactIsFresh, createArtifactEnvelope, createPhaseArtifact, executePhaseProfile, resumeStateFromArtifacts, validateArtifactEnvelope } from '../src/index.js'
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

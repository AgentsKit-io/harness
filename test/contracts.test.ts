import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import {
  HARNESS_ERROR_CODES,
  HARNESS_EVENT_ENVELOPE_SCHEMA_VERSION,
  HARNESS_EVENT_SCHEMA_VERSION,
  HarnessError,
  FileEventStore,
  classifyHarnessError,
  createCapabilityManifest,
  createHarnessEventEnvelope,
  createPluginRegistry,
  createPluginSlot,
  validateCapabilityManifest,
  validateHarnessErrorClassification,
  validateHarnessEventEnvelope,
} from '../src/index.js'
import type { CapabilityDescriptor, HarnessPlugin } from '../src/index.js'

const digest = (value: string): string => createHash('sha256').update(value).digest('hex')

it('round-trips and validates a versioned capability manifest', () => {
  const capabilities: readonly CapabilityDescriptor[] = [{ id: 'kernel', version: '1.0.0', kind: 'kernel', entryPoint: 'src/index.ts', exports: ['assessDiscovery'] }]
  const manifest = createCapabilityManifest({ package: '@agentskit/harness', packageVersion: '0.4.0', entryPoint: 'src/index.ts', sourceDigest: digest('public surface'), capabilities })
  expect(validateCapabilityManifest(manifest)).toEqual(manifest)
  expect(() => validateCapabilityManifest({ ...manifest, digest: '0'.repeat(64) })).toThrow(/digest is invalid/)
  expect(() => createCapabilityManifest({ package: '@agentskit/harness', packageVersion: '0.4.0', entryPoint: 'src/index.ts', sourceDigest: digest('public surface'), capabilities: [] })).toThrow(/capabilities must be non-empty/)
})

it('validates the checked-in manifest generated from the public entry point', () => {
  const manifest = JSON.parse(readFileSync('capabilities/public-surface.json', 'utf8')) as unknown
  const validated = validateCapabilityManifest(manifest)
  expect(validated.entryPoint).toBe('src/index.ts')
  expect(validated.capabilities.length).toBeGreaterThan(1)
})

it('round-trips event envelope v2 and rejects invalid or incompatible inputs', () => {
  const input = {
    eventId: 'evt-1',
    eventType: 'run.created',
    occurredAt: '2026-09-10T00:00:00.000Z',
    runId: 'run-1',
    issueRef: 'linear:ABC-9',
    sourceRevision: 'revision-1',
    correlationId: 'corr-1',
    payload: { accepted: true },
    provenance: { source: 'harness', component: 'test', version: '0.4.0' },
  } as const
  const envelope = createHarnessEventEnvelope(input)
  expect(envelope.schemaVersion).toBe(HARNESS_EVENT_ENVELOPE_SCHEMA_VERSION)
  expect(envelope.idempotencyKey).toMatch(/^[a-f0-9]{64}$/)
  expect(validateHarnessEventEnvelope(envelope)).toEqual(envelope)
  expect(() => validateHarnessEventEnvelope({ ...envelope, schemaVersion: HARNESS_EVENT_SCHEMA_VERSION })).toThrow(/schemaVersion is invalid/)
  expect(() => createHarnessEventEnvelope({ ...input, payload: [] as unknown as Readonly<Record<string, unknown>> })).toThrow(/payload must be an object/)
  expect(() => createHarnessEventEnvelope({ ...input, idempotencyKey: 'not-a-digest' })).toThrow(/idempotencyKey must be/)
})

it('keeps the legacy event store compatible while exposing the v2 envelope', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'agentskit-harness-contracts-'))
  const store = new FileEventStore(stateDir)
  const event = store.append({ runId: 'run-legacy', sourceRevision: 'revision-1', configHash: 'config-1', type: 'run.created', payload: { project: 'fixture', baselineRevision: 'revision-1', baselineStatusHash: 'status-1' } })
  expect(event.schemaVersion).toBe(HARNESS_EVENT_SCHEMA_VERSION)
  expect(store.verify('run-legacy')).toMatchObject({ status: 'verified', eventCount: 1 })
})

it('classifies every stable error path and escalates unknown errors', () => {
  expect(HARNESS_ERROR_CODES).toContain('ACTIVE_RUN')
  expect(classifyHarnessError(new HarnessError('busy', 'ACTIVE_RUN'))).toMatchObject({ code: 'ACTIVE_RUN', disposition: 'retry', retryable: true })
  expect(classifyHarnessError(new HarnessError('invalid', 'INVALID_INPUT'))).toMatchObject({ code: 'INVALID_INPUT', disposition: 'block', retryable: false })
  const unknown = classifyHarnessError(new Error('provider failed'))
  expect(unknown).toMatchObject({ code: 'HARNESS_ERROR', disposition: 'escalate', retryable: false })
  expect(validateHarnessErrorClassification(unknown)).toEqual(unknown)
  expect(() => validateHarnessErrorClassification({ ...unknown, retryable: true })).toThrow(/inconsistent/)
})

it('rejects malformed plugin contracts before dependency resolution', () => {
  expect(() => createPluginSlot(undefined as unknown as string)).toThrow(/Plugin slot id is required/)
  const registry = createPluginRegistry()
  expect(() => (registry.register as unknown as (value: unknown) => void)(null)).toThrow(/Plugin must be an object/)
  expect(() => registry.register({ id: 'invalid', version: '1.0.0', apiVersion: 1, apply: undefined } as unknown as HarnessPlugin)).toThrow(/apply must be a function/)
  expect(() => registry.register({ id: 'invalid', version: '1.0.0', apiVersion: 1, requires: ['invalid', 'invalid'], apply: () => {} })).toThrow(/dependencies must be unique/)
})

it('preserves fail-closed dependency-cycle detection after validation', () => {
  const registry = createPluginRegistry()
  registry.register({ id: 'a', version: '1.0.0', apiVersion: 1, requires: ['b'], apply: () => {} })
  registry.register({ id: 'b', version: '1.0.0', apiVersion: 1, requires: ['a'], apply: () => {} })
  expect(() => registry.mount()).toThrow(/dependency cycle/)
})

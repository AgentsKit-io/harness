import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FileEventStore,
  createHarnessEventEnvelope,
  inspectEventLogLock,
  recoverEventLogLock,
  validateHarnessEventEnvelope,
} from '../src/index.js'

const hash = 'a'.repeat(64)
const envelopeInput = {
  eventId: 'evt-1',
  eventType: 'run.created',
  occurredAt: '2026-09-14T00:00:00.000Z',
  runId: 'run-1',
  sourceRevision: 'rev-1',
  correlationId: 'corr-1',
  payload: { project: 'harness' },
  provenance: { source: 'harness', component: 'kernel', version: '1.0.0' },
}

describe('event envelope', () => {
  it('creates a deterministic envelope with a derived idempotencyKey', () => {
    const first = createHarnessEventEnvelope(envelopeInput)
    const second = createHarnessEventEnvelope(envelopeInput)
    expect(first.idempotencyKey).toBe(second.idempotencyKey)
    expect(first.schemaVersion).toBe(2)
    expect(validateHarnessEventEnvelope(first)).toEqual(first)
  })

  it('honours an explicit idempotencyKey and optional issueRef/actor', () => {
    const envelope = createHarnessEventEnvelope({ ...envelopeInput, issueRef: 'linear:ABC-1', idempotencyKey: hash, provenance: { ...envelopeInput.provenance, actor: 'human' } })
    expect(envelope.idempotencyKey).toBe(hash)
    expect(envelope.issueRef).toBe('linear:ABC-1')
    expect(envelope.provenance.actor).toBe('human')
  })

  it('rejects a non-object input and a non-object envelope', () => {
    expect(() => createHarnessEventEnvelope(null as never)).toThrow(/must be an object/)
    expect(() => validateHarnessEventEnvelope(null)).toThrow(/must be an object/)
    expect(() => validateHarnessEventEnvelope([])).toThrow(/must be an object/)
  })

  it('rejects an invalid schemaVersion', () => {
    expect(() => validateHarnessEventEnvelope({ ...createHarnessEventEnvelope(envelopeInput), schemaVersion: 1 })).toThrow(/schemaVersion/)
  })

  it('rejects a non-object payload', () => {
    expect(() => validateHarnessEventEnvelope({ ...createHarnessEventEnvelope(envelopeInput), payload: 'nope' })).toThrow(/payload must be an object/)
    expect(() => validateHarnessEventEnvelope({ ...createHarnessEventEnvelope(envelopeInput), payload: [] })).toThrow(/payload must be an object/)
  })

  it('rejects a blank issueRef', () => {
    expect(() => validateHarnessEventEnvelope({ ...createHarnessEventEnvelope(envelopeInput), issueRef: '  ' })).toThrow(/issueRef/)
  })

  it('rejects a missing or unparsable occurredAt', () => {
    expect(() => validateHarnessEventEnvelope({ ...createHarnessEventEnvelope(envelopeInput), occurredAt: '' })).toThrow(/occurredAt/)
    expect(() => validateHarnessEventEnvelope({ ...createHarnessEventEnvelope(envelopeInput), occurredAt: 'not-a-date' })).toThrow(/valid timestamp/)
  })

  it('rejects invalid eventId/eventType/runId/sourceRevision/correlationId', () => {
    expect(() => validateHarnessEventEnvelope({ ...createHarnessEventEnvelope(envelopeInput), eventId: '' })).toThrow(/eventId/)
    expect(() => validateHarnessEventEnvelope({ ...createHarnessEventEnvelope(envelopeInput), eventType: 'bad type' })).toThrow(/eventType/)
    expect(() => validateHarnessEventEnvelope({ ...createHarnessEventEnvelope(envelopeInput), runId: '' })).toThrow(/runId/)
    expect(() => validateHarnessEventEnvelope({ ...createHarnessEventEnvelope(envelopeInput), sourceRevision: '  ' })).toThrow(/sourceRevision/)
    expect(() => validateHarnessEventEnvelope({ ...createHarnessEventEnvelope(envelopeInput), correlationId: '' })).toThrow(/correlationId/)
  })

  it('rejects an invalid idempotencyKey digest', () => {
    expect(() => validateHarnessEventEnvelope({ ...createHarnessEventEnvelope(envelopeInput), idempotencyKey: 'not-a-digest' })).toThrow(/idempotencyKey/)
  })

  it('rejects invalid provenance shapes', () => {
    expect(() => validateHarnessEventEnvelope({ ...createHarnessEventEnvelope(envelopeInput), provenance: null })).toThrow(/provenance must be an object/)
    expect(() => validateHarnessEventEnvelope({ ...createHarnessEventEnvelope(envelopeInput), provenance: { source: '', component: 'kernel', version: '1' } })).toThrow(/source/)
    expect(() => validateHarnessEventEnvelope({ ...createHarnessEventEnvelope(envelopeInput), provenance: { source: 'harness', component: '', version: '1' } })).toThrow(/component/)
    expect(() => validateHarnessEventEnvelope({ ...createHarnessEventEnvelope(envelopeInput), provenance: { source: 'harness', component: 'kernel', version: '' } })).toThrow(/version/)
    expect(() => validateHarnessEventEnvelope({ ...createHarnessEventEnvelope(envelopeInput), provenance: { source: 'harness', component: 'kernel', version: '1', actor: '  ' } })).toThrow(/actor/)
  })
})

const dir = () => mkdtempSync(join(tmpdir(), 'agentskit-harness-events-test-'))
const base = { runId: 'run-1', sourceRevision: 'rev-1', configHash: hash }

describe('FileEventStore', () => {
  it('appends a genesis event and a hash-chained follow-up, verifying the chain', () => {
    const store = new FileEventStore(dir())
    const first = store.append({ ...base, type: 'run.created', payload: { project: 'harness', baselineRevision: 'rev-1', baselineStatusHash: hash } })
    expect(first.sequence).toBe(1)
    expect(first.previousHash).toBe('GENESIS')
    expect(first.eventHash).toMatch(/^[a-f0-9]{64}$/)
    const second = store.append({ ...base, type: 'state.transitioned', payload: { from: null, to: 'discovering', actor: 'human', transitionIndex: 1 } })
    expect(second.previousHash).toBe(first.eventHash)
    expect(store.read('run-1')).toHaveLength(2)
    expect(store.verify('run-1')).toMatchObject({ status: 'verified', eventCount: 2, headHash: second.eventHash })
  })

  it('requires sessionId for session-scoped event types and rejects a blank one', () => {
    const store = new FileEventStore(dir())
    expect(() => store.append({ ...base, type: 'session.started', payload: { adapterId: 'claude', adapterVersion: '1', capabilities: [] } })).toThrow(/sessionId/)
    expect(() => store.append({ ...base, type: 'run.created', sessionId: '  ', payload: { project: 'harness', baselineRevision: 'rev-1', baselineStatusHash: hash } })).toThrow(/sessionId cannot be empty/)
    const event = store.append({ ...base, type: 'session.started', sessionId: 'sess-1', payload: { adapterId: 'claude', adapterVersion: '1', capabilities: [] } })
    expect(event.sessionId).toBe('sess-1')
  })

  it('rejects blank runId, sourceRevision, configHash, and an invalid event type', () => {
    const store = new FileEventStore(dir())
    expect(() => store.append({ ...base, runId: '  ', type: 'run.created', payload: {} })).toThrow(/runId/)
    expect(() => store.append({ ...base, sourceRevision: '  ', type: 'run.created', payload: {} })).toThrow(/sourceRevision and configHash/)
    expect(() => store.append({ ...base, configHash: '  ', type: 'run.created', payload: {} })).toThrow(/sourceRevision and configHash/)
    expect(() => store.append({ ...base, type: 'not.a.type' as never, payload: {} })).toThrow(/type is invalid/)
  })

  it('rejects a correlation with a blank operationId', () => {
    const store = new FileEventStore(dir())
    expect(() => store.append({ ...base, type: 'run.created', payload: {}, correlation: { operationId: '  ' } })).toThrow(/operationId/)
    const event = store.append({ ...base, type: 'run.created', payload: { project: 'p' }, correlation: { operationId: 'op-1' } })
    expect(event.correlation).toEqual({ operationId: 'op-1' })
  })

  it('reads an empty log for a run with no events', () => {
    expect(new FileEventStore(dir()).read('missing-run')).toEqual([])
  })

  it('reports legacy status when no event carries an eventHash', () => {
    const stateDir = dir()
    mkdirSync(join(stateDir, 'runs', 'run-1'), { recursive: true })
    const legacy = { schemaVersion: 1, runId: 'run-1', sequence: 1, at: '2026-09-14T00:00:00.000Z', sourceRevision: 'rev-1', configHash: hash, type: 'run.created', payload: { project: 'p' } }
    writeFileSync(join(stateDir, 'runs', 'run-1', 'events.ndjson'), `${JSON.stringify(legacy)}\n`, 'utf8')
    expect(new FileEventStore(stateDir).verify('run-1')).toEqual({ status: 'legacy', eventCount: 1 })
  })

  it('rejects a log that mixes legacy and hashed records', () => {
    const stateDir = dir()
    mkdirSync(join(stateDir, 'runs', 'run-1'), { recursive: true })
    const legacy = { schemaVersion: 1, runId: 'run-1', sequence: 1, at: '2026-09-14T00:00:00.000Z', sourceRevision: 'rev-1', configHash: hash, type: 'run.created', payload: { project: 'p' } }
    const path = join(stateDir, 'runs', 'run-1', 'events.ndjson')
    writeFileSync(path, `${JSON.stringify(legacy)}\n`, 'utf8')
    const store = new FileEventStore(stateDir)
    const hashed = { schemaVersion: 1, runId: 'run-1', sequence: 2, at: '2026-09-14T00:00:01.000Z', sourceRevision: 'rev-1', configHash: hash, type: 'state.transitioned', payload: { from: null, to: 'discovering', actor: 'human', transitionIndex: 1 }, previousHash: 'GENESIS', eventHash: hash }
    appendFileSync(path, `${JSON.stringify(hashed)}\n`, 'utf8')
    expect(() => store.read('run-1')).toThrow(/mixes legacy and hashed/)
  })

  it('rejects a tampered hash chain', () => {
    const stateDir = dir()
    const store = new FileEventStore(stateDir)
    store.append({ ...base, type: 'run.created', payload: { project: 'p' } })
    const path = join(stateDir, 'runs', 'run-1', 'events.ndjson')
    const tampered = { schemaVersion: 1, runId: 'run-1', sequence: 1, at: '2026-09-14T00:00:00.000Z', sourceRevision: 'rev-1', configHash: hash, type: 'run.created', payload: { project: 'tampered' }, previousHash: 'GENESIS', eventHash: hash }
    writeFileSync(path, `${JSON.stringify(tampered)}\n`, 'utf8')
    expect(() => store.verify('run-1')).toThrow(/hash chain/)
  })

  it('rejects malformed JSON, non-object records, out-of-order sequences, and invalid correlation entries', () => {
    const stateDir = dir()
    mkdirSync(join(stateDir, 'runs', 'run-1'), { recursive: true })
    const path = join(stateDir, 'runs', 'run-1', 'events.ndjson')
    writeFileSync(path, 'not-json\n', 'utf8')
    expect(() => new FileEventStore(stateDir).read('run-1')).toThrow(/invalid JSON/)

    writeFileSync(path, '[]\n', 'utf8')
    expect(() => new FileEventStore(stateDir).read('run-1')).toThrow(/non-object record/)

    const valid = { schemaVersion: 1, runId: 'run-1', sequence: 1, at: '2026-09-14T00:00:00.000Z', sourceRevision: 'rev-1', configHash: hash, type: 'run.created', payload: { project: 'p' } }
    writeFileSync(path, `${JSON.stringify({ ...valid, sequence: 2 })}\n`, 'utf8')
    expect(() => new FileEventStore(stateDir).read('run-1')).toThrow(/invalid or out of order/)

    writeFileSync(path, `${JSON.stringify({ ...valid, correlation: { operationId: 'op-1', extra: 'nope' } })}\n`, 'utf8')
    expect(() => new FileEventStore(stateDir).read('run-1')).toThrow(/invalid or out of order/)

    writeFileSync(path, `${JSON.stringify({ ...valid, sessionId: '' })}\n`, 'utf8')
    expect(() => new FileEventStore(stateDir).read('run-1')).toThrow(/invalid or out of order/)

    writeFileSync(path, `${JSON.stringify({ ...valid, type: 'session.started' })}\n`, 'utf8')
    expect(() => new FileEventStore(stateDir).read('run-1')).toThrow(/invalid or out of order/)
  })

  it('rejects a record with only one of previousHash/eventHash, or invalid digest values', () => {
    const stateDir = dir()
    mkdirSync(join(stateDir, 'runs', 'run-1'), { recursive: true })
    const path = join(stateDir, 'runs', 'run-1', 'events.ndjson')
    const valid = { schemaVersion: 1, runId: 'run-1', sequence: 1, at: '2026-09-14T00:00:00.000Z', sourceRevision: 'rev-1', configHash: hash, type: 'run.created', payload: { project: 'p' } }
    writeFileSync(path, `${JSON.stringify({ ...valid, previousHash: 'GENESIS' })}\n`, 'utf8')
    expect(() => new FileEventStore(stateDir).read('run-1')).toThrow(/integrity metadata/)
    writeFileSync(path, `${JSON.stringify({ ...valid, previousHash: 'not-genesis-or-digest', eventHash: hash })}\n`, 'utf8')
    expect(() => new FileEventStore(stateDir).read('run-1')).toThrow(/integrity metadata/)
    writeFileSync(path, `${JSON.stringify({ ...valid, previousHash: 'GENESIS', eventHash: 'bad' })}\n`, 'utf8')
    expect(() => new FileEventStore(stateDir).read('run-1')).toThrow(/integrity metadata/)
  })

  it('refuses to read or append while a lock file is present', () => {
    const stateDir = dir()
    mkdirSync(join(stateDir, 'runs', 'run-1'), { recursive: true })
    writeFileSync(join(stateDir, 'runs', 'run-1', 'events.ndjson.lock'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), 'utf8')
    const store = new FileEventStore(stateDir)
    expect(() => store.read('run-1')).toThrow(/busy/)
    expect(() => store.append({ ...base, type: 'run.created', payload: {} })).toThrow(/busy/)
  })
})

describe('event log lock inspection and recovery', () => {
  it('reports unlocked when no lock file exists', () => {
    const stateDir = dir()
    expect(inspectEventLogLock(stateDir, 'run-1')).toEqual({ status: 'unlocked', path: join(stateDir, 'runs', 'run-1', 'events.ndjson.lock') })
  })

  it('reports the lock contents when a lock file exists', () => {
    const stateDir = dir()
    mkdirSync(join(stateDir, 'runs', 'run-1'), { recursive: true })
    const lockPath = join(stateDir, 'runs', 'run-1', 'events.ndjson.lock')
    const lock = { pid: process.pid, at: '2026-09-14T00:00:00.000Z' }
    writeFileSync(lockPath, JSON.stringify(lock), 'utf8')
    expect(inspectEventLogLock(stateDir, 'run-1')).toEqual({ status: 'locked', path: lockPath, lock })
  })

  it('rejects a lock file with invalid metadata', () => {
    const stateDir = dir()
    mkdirSync(join(stateDir, 'runs', 'run-1'), { recursive: true })
    writeFileSync(join(stateDir, 'runs', 'run-1', 'events.ndjson.lock'), 'not-json', 'utf8')
    expect(() => inspectEventLogLock(stateDir, 'run-1')).toThrow(/invalid/)

    writeFileSync(join(stateDir, 'runs', 'run-1', 'events.ndjson.lock'), JSON.stringify({ pid: -1, at: '2026-09-14T00:00:00.000Z' }), 'utf8')
    expect(() => inspectEventLogLock(stateDir, 'run-1')).toThrow(/invalid/)

    writeFileSync(join(stateDir, 'runs', 'run-1', 'events.ndjson.lock'), JSON.stringify({ pid: process.pid, at: 'not-a-date' }), 'utf8')
    expect(() => inspectEventLogLock(stateDir, 'run-1')).toThrow(/invalid/)
  })

  it('requires a human actor and a valid maxAgeMs', () => {
    const stateDir = dir()
    expect(() => recoverEventLogLock({ stateDir, runId: 'run-1', actor: 'agent' })).toThrow(/human actor/)
    expect(() => recoverEventLogLock({ stateDir, runId: 'run-1', actor: 'human', maxAgeMs: -1 })).toThrow(/maxAgeMs/)
    expect(() => recoverEventLogLock({ stateDir, runId: 'run-1', actor: 'human', maxAgeMs: 1.5 })).toThrow(/maxAgeMs/)
  })

  it('reports unlocked when there is nothing to recover', () => {
    const stateDir = dir()
    expect(recoverEventLogLock({ stateDir, runId: 'run-1', actor: 'human' })).toEqual({ status: 'unlocked', path: join(stateDir, 'runs', 'run-1', 'events.ndjson.lock') })
  })

  it('refuses to recover a lock that is not old enough', () => {
    const stateDir = dir()
    mkdirSync(join(stateDir, 'runs', 'run-1'), { recursive: true })
    writeFileSync(join(stateDir, 'runs', 'run-1', 'events.ndjson.lock'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), 'utf8')
    expect(() => recoverEventLogLock({ stateDir, runId: 'run-1', actor: 'human', maxAgeMs: 300_000 })).toThrow(/not old enough/)
  })

  it('refuses to recover a lock whose owner is still alive', () => {
    const stateDir = dir()
    mkdirSync(join(stateDir, 'runs', 'run-1'), { recursive: true })
    writeFileSync(join(stateDir, 'runs', 'run-1', 'events.ndjson.lock'), JSON.stringify({ pid: process.pid, at: new Date(Date.now() - 60_000).toISOString() }), 'utf8')
    expect(() => recoverEventLogLock({ stateDir, runId: 'run-1', actor: 'human', maxAgeMs: 0 })).toThrow(/still alive/)
  })

  it('recovers a lock whose owner process is gone, unlinking the lock file', () => {
    const stateDir = dir()
    mkdirSync(join(stateDir, 'runs', 'run-1'), { recursive: true })
    const lockPath = join(stateDir, 'runs', 'run-1', 'events.ndjson.lock')
    const deadPid = 2 ** 30
    const lock = { pid: deadPid, at: new Date(Date.now() - 60_000).toISOString() }
    writeFileSync(lockPath, JSON.stringify(lock), 'utf8')
    const recovered = recoverEventLogLock({ stateDir, runId: 'run-1', actor: 'human', maxAgeMs: 0 })
    expect(recovered).toEqual({ status: 'recovered', path: lockPath, lock })
    expect(inspectEventLogLock(stateDir, 'run-1')).toEqual({ status: 'unlocked', path: lockPath })
  })
})

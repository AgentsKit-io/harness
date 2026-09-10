import { mkdtempSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDispatchLedger } from '../src/index.js'

const identity = { tracker: 'linear', repository: 'org/repo', issue: 'ENG-1', worktree: 'eng-1', branch: 'codex/eng-1', owner: 'agent' }

describe('dispatch coordination', () => {
  it('claims once and records idempotent dispatches', () => {
    const ledger = createDispatchLedger(mkdtempSync(join(tmpdir(), 'harness-coordination-')))
    const first = ledger.claim(identity)
    expect(first.decision).toBe('claimed')
    expect(ledger.claim(identity).decision).toBe('already-claimed')
    expect(ledger.recordDispatch({ lease: first.lease, idempotencyKey: 'op-1', commandDigest: 'cmd-1' }).decision).toBe('recorded')
    expect(ledger.recordDispatch({ lease: first.lease, idempotencyKey: 'op-1', commandDigest: 'cmd-1' }).decision).toBe('duplicate')
    expect(ledger.active()).toHaveLength(1)
    ledger.release(first.lease)
    expect(ledger.active()).toHaveLength(0)
  })

  it('requires a human for stale claim recovery', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-coordination-'))
    const ledger = createDispatchLedger(root)
    const lease = ledger.claim(identity).lease
    expect(() => ledger.recover(lease.key, { actor: 'agent', maxAgeMs: 0, reason: 'cleanup' })).toThrow(/human actor/)
    const path = join(root, 'coordination', 'claims', `${lease.key}.json`)
    const old = new Date(Date.now() - 60_000)
    utimesSync(path, old, old)
    const recovered = ledger.recover(lease.key, { actor: 'human', maxAgeMs: 0, reason: 'confirmed abandoned' })
    expect(recovered.action).toBe('recover')
  })
})

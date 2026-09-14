import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDispatchLedger } from '../src/index.js'

const openSyncState = vi.hoisted(() => ({ impl: undefined as ((...args: unknown[]) => number) | undefined }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  openSyncState.impl = actual.openSync as (...args: unknown[]) => number
  return { ...actual, openSync: (...args: unknown[]) => openSyncState.impl!(...args) }
})

const identity = { tracker: 'linear', repository: 'org/repo', issue: 'ENG-1', worktree: 'eng-1', branch: 'codex/eng-1', owner: 'agent' }
const tempDir = (): string => mkdtempSync(join(tmpdir(), 'harness-coordination-'))

describe('createDispatchLedger: constructor and claim validation', () => {
  it('rejects a blank stateDir', () => {
    expect(() => createDispatchLedger('')).toThrow(/stateDir is required/)
  })

  it('rejects a claim with a blank identity field or owner', () => {
    const ledger = createDispatchLedger(tempDir())
    expect(() => ledger.claim({ ...identity, tracker: '' })).toThrow(/tracker is required/)
    expect(() => ledger.claim({ ...identity, owner: '' })).toThrow(/owner is required/)
  })
})

describe('createDispatchLedger: release', () => {
  it('rejects releasing a lease that is not active', () => {
    const ledger = createDispatchLedger(tempDir())
    const { lease } = ledger.claim(identity)
    ledger.release(lease)
    expect(() => ledger.release(lease)).toThrow(/is not active/)
  })

  it('rejects releasing with a mismatched leaseId (a stale local reference to a since-recovered lease)', () => {
    const root = tempDir()
    const ledger = createDispatchLedger(root)
    const { lease } = ledger.claim(identity)
    expect(() => ledger.release({ ...lease, leaseId: 'someone-elses-lease-id' })).toThrow(/owner does not match/)
  })

  it('rejects a blank release reason', () => {
    const ledger = createDispatchLedger(tempDir())
    const { lease } = ledger.claim(identity)
    expect(() => ledger.release(lease, '')).toThrow(/reason is required/)
  })
})

describe('createDispatchLedger: recover', () => {
  it('rejects recovering a lease that is not active', () => {
    const ledger = createDispatchLedger(tempDir())
    expect(() => ledger.recover('nonexistent-key', { actor: 'human', reason: 'cleanup' })).toThrow(/is not active/)
  })

  it('rejects a non-integer or negative maxAgeMs', () => {
    const ledger = createDispatchLedger(tempDir())
    const { lease } = ledger.claim(identity)
    expect(() => ledger.recover(lease.key, { actor: 'human', maxAgeMs: -1, reason: 'x' })).toThrow(/maxAgeMs must be a non-negative integer/)
    expect(() => ledger.recover(lease.key, { actor: 'human', maxAgeMs: 1.5, reason: 'x' })).toThrow(/maxAgeMs must be a non-negative integer/)
  })

  it('refuses to recover a lease that has not aged past maxAgeMs yet', () => {
    const ledger = createDispatchLedger(tempDir())
    const { lease } = ledger.claim(identity)
    expect(() => ledger.recover(lease.key, { actor: 'human', maxAgeMs: 3_600_000, reason: 'too soon' })).toThrow(/not old enough to recover/)
  })

  it('rejects a blank recovery reason or key', () => {
    const ledger = createDispatchLedger(tempDir())
    const { lease } = ledger.claim(identity)
    expect(() => ledger.recover(lease.key, { actor: 'human', maxAgeMs: 0, reason: '' })).toThrow(/reason is required/)
    expect(() => ledger.recover('', { actor: 'human', maxAgeMs: 0, reason: 'x' })).toThrow(/key is required/)
  })
})

describe('createDispatchLedger: corrupt on-disk state', () => {
  it('fails closed on an unparseable claim file', () => {
    const root = tempDir()
    const ledger = createDispatchLedger(root)
    const { lease } = ledger.claim(identity)
    mkdirSync(join(root, 'coordination', 'claims'), { recursive: true })
    writeFileSync(join(root, 'coordination', 'claims', `${lease.key}.json`), 'not json')
    expect(() => ledger.claim(identity)).toThrow(/contains invalid JSON/)
  })

  it('rejects a claim file missing a required identity field', () => {
    const root = tempDir()
    const ledger = createDispatchLedger(root)
    const { lease } = ledger.claim(identity)
    mkdirSync(join(root, 'coordination', 'claims'), { recursive: true })
    writeFileSync(join(root, 'coordination', 'claims', `${lease.key}.json`), JSON.stringify({ ...lease, tracker: '' }))
    expect(() => ledger.claim(identity)).toThrow(/tracker is required/)
  })

  it('fails closed on an unparseable ledger line', () => {
    const root = tempDir()
    const ledger = createDispatchLedger(root)
    ledger.claim(identity)
    mkdirSync(join(root, 'coordination'), { recursive: true })
    writeFileSync(join(root, 'coordination', 'dispatch-ledger.ndjson'), 'not json\n')
    expect(() => ledger.active()).toThrow(/is invalid JSON/)
    expect(() => ledger.records()).toThrow(/is invalid JSON/)
  })

  it('returns an empty active/records list when the ledger file does not exist yet', () => {
    const ledger = createDispatchLedger(tempDir())
    expect(ledger.active()).toEqual([])
    expect(ledger.records()).toEqual([])
  })
})

describe('createDispatchLedger: rejects idempotencyKey/commandDigest validation', () => {
  it('rejects a blank idempotencyKey or commandDigest', () => {
    const ledger = createDispatchLedger(tempDir())
    const { lease } = ledger.claim(identity)
    expect(() => ledger.recordDispatch({ lease, idempotencyKey: '', commandDigest: 'd' })).toThrow(/idempotencyKey is required/)
    expect(() => ledger.recordDispatch({ lease, idempotencyKey: 'k', commandDigest: '' })).toThrow(/commandDigest is required/)
  })
})

describe('createDispatchLedger: concurrent-claim race', () => {
  const defaultImpl = openSyncState.impl
  afterEach(() => { openSyncState.impl = defaultImpl })

  it('treats an EEXIST from the exclusive-create write as already-claimed even when the pre-check missed it', async () => {
    const root = tempDir()
    const { hashJson } = await import('../src/kernel/hash.js')
    const ledger = createDispatchLedger(root)
    const passthrough = openSyncState.impl!
    mkdirSync(join(root, 'coordination', 'claims'), { recursive: true })
    const key = hashJson({ tracker: identity.tracker, repository: identity.repository, issue: identity.issue, worktree: identity.worktree, branch: identity.branch })
    const claimPath = join(root, 'coordination', 'claims', `${key}.json`)
    const winningLease = { tracker: identity.tracker, repository: identity.repository, issue: identity.issue, worktree: identity.worktree, branch: identity.branch, key, leaseId: 'other-lease', owner: 'other-owner', claimedAt: new Date().toISOString() }
    openSyncState.impl = ((...args: unknown[]) => {
      const [path, flags] = args as [string, string]
      if (path === claimPath && flags === 'wx') {
        // simulate another process winning the race between our existsSync pre-check and this exclusive create
        writeFileSync(claimPath, JSON.stringify(winningLease))
        const error = new Error('EEXIST') as NodeJS.ErrnoException
        error.code = 'EEXIST'
        throw error
      }
      return passthrough(...args)
    }) as typeof openSyncState.impl
    const result = ledger.claim(identity)
    expect(result).toEqual({ decision: 'already-claimed', lease: winningLease })
  })

  it('rethrows a non-EEXIST error from the exclusive-create write', () => {
    const root = tempDir()
    const ledger = createDispatchLedger(root)
    openSyncState.impl = (() => { throw new Error('disk full') }) as typeof openSyncState.impl
    expect(() => ledger.claim(identity)).toThrow('disk full')
  })
})

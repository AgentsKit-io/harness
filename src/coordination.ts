import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fail } from './errors.js'
import { hashJson } from './hash.js'

export interface CoordinationIdentity {
  readonly tracker: string
  readonly repository: string
  readonly issue: string
  readonly worktree: string
  readonly branch: string
}

export interface DispatchLease extends CoordinationIdentity {
  readonly key: string
  readonly leaseId: string
  readonly owner: string
  readonly claimedAt: string
}

export interface ClaimResult {
  readonly decision: 'claimed' | 'already-claimed'
  readonly lease: DispatchLease
}

export interface DispatchRecord extends DispatchLease {
  readonly action: 'dispatch' | 'release' | 'recover'
  readonly at: string
  readonly idempotencyKey?: string
  readonly commandDigest?: string
  readonly reason?: string
}

export interface DispatchLedger {
  claim(identity: CoordinationIdentity & { readonly owner: string }): ClaimResult
  recordDispatch(input: { readonly lease: DispatchLease; readonly idempotencyKey: string; readonly commandDigest: string }): { readonly decision: 'recorded' | 'duplicate'; readonly record: DispatchRecord }
  release(lease: DispatchLease, reason?: string): DispatchRecord
  recover(key: string, input: { readonly actor: string; readonly maxAgeMs?: number; readonly reason: string }): DispatchRecord
  active(): readonly DispatchLease[]
  records(): readonly DispatchRecord[]
}

const required = (value: string, label: string): string => {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} is required.`, 'INVALID_INPUT')
  return value.trim()
}

const safeKey = (identity: CoordinationIdentity): string => hashJson(identity)
const now = (): string => new Date().toISOString()

const parse = (value: string, label: string): DispatchLease => {
  try {
    const raw = JSON.parse(value) as Record<string, unknown>
    const identity = {
      tracker: required(raw['tracker'] as string, `${label}.tracker`),
      repository: required(raw['repository'] as string, `${label}.repository`),
      issue: required(raw['issue'] as string, `${label}.issue`),
      worktree: required(raw['worktree'] as string, `${label}.worktree`),
      branch: required(raw['branch'] as string, `${label}.branch`),
    }
    return { ...identity, key: required(raw['key'] as string, `${label}.key`), leaseId: required(raw['leaseId'] as string, `${label}.leaseId`), owner: required(raw['owner'] as string, `${label}.owner`), claimedAt: required(raw['claimedAt'] as string, `${label}.claimedAt`) }
  } catch (error) {
    if (error instanceof SyntaxError) fail(`${label} contains invalid JSON.`, 'HARNESS_ERROR')
    throw error
  }
}

export const createDispatchLedger = (stateDir: string): DispatchLedger => {
  const root = required(stateDir, 'stateDir')
  const claimsDir = join(root, 'coordination', 'claims')
  const ledgerPath = join(root, 'coordination', 'dispatch-ledger.ndjson')
  mkdirSync(claimsDir, { recursive: true })
  const claimPath = (key: string): string => join(claimsDir, `${key}.json`)
  const append = (record: DispatchRecord): void => appendFileSync(ledgerPath, `${JSON.stringify(record)}\n`, 'utf8')

  const records = (): readonly DispatchRecord[] => {
    if (!existsSync(ledgerPath)) return []
    return readFileSync(ledgerPath, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line, index) => {
      try { return JSON.parse(line) as DispatchRecord } catch { return fail(`Dispatch ledger record ${index + 1} is invalid JSON.`, 'HARNESS_ERROR') }
    })
  }

  const active = (): readonly DispatchLease[] => {
    const byKey = new Map<string, DispatchLease>()
    for (const record of records()) {
      if (record.action === 'release' || record.action === 'recover') byKey.delete(record.key)
      else if (record.action === 'dispatch') byKey.set(record.key, record)
    }
    return [...byKey.values()]
  }

  return {
    claim: (input) => {
      const identity: CoordinationIdentity = {
        tracker: required(input.tracker, 'tracker'),
        repository: required(input.repository, 'repository'),
        issue: required(input.issue, 'issue'),
        worktree: required(input.worktree, 'worktree'),
        branch: required(input.branch, 'branch'),
      }
      const owner = required(input.owner, 'owner')
      const key = safeKey(identity)
      const path = claimPath(key)
      if (existsSync(path)) return { decision: 'already-claimed' as const, lease: parse(readFileSync(path, 'utf8'), 'claim') }
      const lease: DispatchLease = { ...identity, key, leaseId: randomUUID(), owner, claimedAt: now() }
      let fd: number
      try { fd = openSync(path, 'wx') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { decision: 'already-claimed' as const, lease: parse(readFileSync(path, 'utf8'), 'claim') }; throw error }
      try { writeFileSync(fd, JSON.stringify(lease), 'utf8') } finally { closeSync(fd) }
      append({ ...lease, action: 'dispatch', at: lease.claimedAt })
      return { decision: 'claimed' as const, lease }
    },
    recordDispatch: ({ lease, idempotencyKey, commandDigest }) => {
      const id = required(idempotencyKey, 'idempotencyKey')
      const digest = required(commandDigest, 'commandDigest')
      const existing = records().find((record) => record.action === 'dispatch' && record.idempotencyKey === id)
      if (existing) return { decision: 'duplicate' as const, record: existing }
      const record: DispatchRecord = { ...lease, action: 'dispatch', at: now(), idempotencyKey: id, commandDigest: digest }
      append(record)
      return { decision: 'recorded' as const, record }
    },
    release: (lease, reason = 'lease released') => {
      const path = claimPath(required(lease.key, 'lease.key'))
      if (!existsSync(path)) fail('Dispatch lease is not active.', 'INVALID_STATE')
      const current = parse(readFileSync(path, 'utf8'), 'claim')
      if (current.leaseId !== lease.leaseId) fail('Dispatch lease owner does not match.', 'INVALID_STATE')
      unlinkSync(path)
      const record: DispatchRecord = { ...current, action: 'release', at: now(), reason: required(reason, 'reason') }
      append(record)
      return record
    },
    recover: (key, input) => {
      if (input.actor !== 'human') fail('Dispatch lease recovery requires a human actor.', 'HUMAN_APPROVAL_REQUIRED')
      const normalizedKey = required(key, 'key')
      const maxAgeMs = input.maxAgeMs ?? 300_000
      if (!Number.isInteger(maxAgeMs) || maxAgeMs < 0) fail('maxAgeMs must be a non-negative integer.', 'INVALID_INPUT')
      const path = claimPath(normalizedKey)
      if (!existsSync(path)) fail('Dispatch lease is not active.', 'INVALID_STATE')
      const current = parse(readFileSync(path, 'utf8'), 'claim')
      if (Date.now() - Date.parse(current.claimedAt) < maxAgeMs) fail('Dispatch lease is not old enough to recover.', 'HARNESS_ERROR')
      unlinkSync(path)
      const record: DispatchRecord = { ...current, action: 'recover', at: now(), reason: required(input.reason, 'reason') }
      append(record)
      return record
    },
    active,
    records,
  }
}

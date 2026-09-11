import { fail } from '../kernel/errors.js'
import { hashJson } from '../kernel/hash.js'
import { validateSafeCommand } from '../kernel/preflight.js'
import type { AdapterTelemetry, AssuranceLevel } from '../kernel/adapter-contract.js'

export interface OrcaDispatchInput {
  readonly repository: string
  readonly worktree: string
  readonly branch: string
  readonly baseBranch: string
  readonly goalFile: string
  readonly agent?: string
}

export interface OrcaDispatchPlan {
  readonly argv: readonly string[]
  readonly commandDigest: string
  readonly idempotencyKey: string
}

export type OrcaLeaseState = 'acquired' | 'resumed' | 'conflict' | 'released'

export interface OrcaLifecycleInput {
  readonly issueRef: string
  readonly repository: string
  readonly worktree: string
  readonly branch: string
  readonly leaseState: OrcaLeaseState
  readonly issueLock: 'held' | 'missing'
  readonly expectedRemoteSha?: string
  readonly observedRemoteSha?: string
  readonly cleanupRequested?: boolean
}

export interface OrcaLifecycleProjection {
  readonly status: 'ready' | 'resume' | 'blocked' | 'escalated'
  readonly leaseState: OrcaLeaseState
  readonly worktreeKey: string
  readonly issueLock: 'held' | 'missing'
  readonly remoteShaConfirmed: boolean
  readonly cleanupAllowed: boolean
  readonly assurance: AssuranceLevel
  readonly telemetry: AdapterTelemetry
}

const required = (value: string, label: string): string => {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} is required.`, 'INVALID_INPUT')
  return value.trim()
}

export const createOrcaDispatchPlan = (input: OrcaDispatchInput): OrcaDispatchPlan => {
  const repository = required(input.repository, 'repository')
  const worktree = required(input.worktree, 'worktree')
  const branch = required(input.branch, 'branch')
  const baseBranch = required(input.baseBranch, 'baseBranch')
  const goalFile = required(input.goalFile, 'goalFile')
  const agent = required(input.agent ?? 'default', 'agent')
  const argv = ['orca', 'worktree', 'create', '--repo', repository, '--name', worktree, '--base-branch', baseBranch, '--agent', agent, '--prompt-file', goalFile]
  validateSafeCommand(argv.join(' '))
  const identity = { repository, worktree, branch, baseBranch, goalFile, agent }
  return { argv, commandDigest: hashJson(argv), idempotencyKey: hashJson(identity) }
}

export const createOrcaLifecycleProjection = (input: OrcaLifecycleInput): OrcaLifecycleProjection => {
  const issueRef = required(input.issueRef, 'issueRef')
  const repository = required(input.repository, 'repository')
  const worktree = required(input.worktree, 'worktree')
  const branch = required(input.branch, 'branch')
  if (!['acquired', 'resumed', 'conflict', 'released'].includes(input.leaseState)) fail('leaseState is invalid.', 'INVALID_INPUT')
  if (input.issueLock !== 'held' && input.issueLock !== 'missing') fail('issueLock is invalid.', 'INVALID_INPUT')
  const expected = input.expectedRemoteSha?.trim()
  const observed = input.observedRemoteSha?.trim()
  const remoteShaConfirmed = Boolean(expected && observed && expected === observed)
  const cleanupAllowed = input.cleanupRequested === true && remoteShaConfirmed && input.leaseState === 'released'
  const status = input.leaseState === 'conflict' || input.issueLock === 'missing' ? 'blocked' : input.cleanupRequested === true && !remoteShaConfirmed ? 'escalated' : input.leaseState === 'resumed' ? 'resume' : 'ready'
  return { status, leaseState: input.leaseState, worktreeKey: hashJson({ issueRef, repository, worktree, branch }), issueLock: input.issueLock, remoteShaConfirmed, cleanupAllowed, assurance: 'contract-tested', telemetry: { status: 'measured', durationMs: 0 } }
}

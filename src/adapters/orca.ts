import { fail } from '../kernel/errors.js'
import { hashJson } from '../kernel/hash.js'
import { validateSafeCommand } from '../kernel/preflight.js'
import type { AdapterTelemetry, AssuranceLevel } from '../kernel/adapter-contract.js'

export interface OrcaDispatchInput {
  readonly repository: string
  readonly worktree: string
  readonly branch: string
  readonly baseBranch: string
  /** Prompt file path (`--prompt-file`) — mutually exclusive with `prompt`. */
  readonly goalFile?: string
  /** Inline prompt text (`--prompt`) — mutually exclusive with `goalFile`. */
  readonly prompt?: string
  readonly agent?: string
  /** Linear identifier or URL recorded on the worktree (`--linear-issue`). */
  readonly linearIssue?: string
  /** Free-text Orca comment shown on the worktree card (`--comment`). */
  readonly comment?: string
  /** Detach the new worktree from the caller's lineage (`--no-parent`). */
  readonly noParent?: boolean
  readonly orcaBin?: string
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
  const agent = required(input.agent ?? 'default', 'agent')
  if ((input.goalFile === undefined) === (input.prompt === undefined)) fail('Exactly one of goalFile or prompt is required.', 'INVALID_INPUT')
  const goalFile = input.goalFile === undefined ? undefined : required(input.goalFile, 'goalFile')
  const prompt = input.prompt === undefined ? undefined : required(input.prompt, 'prompt')
  const linearIssue = input.linearIssue === undefined ? undefined : required(input.linearIssue, 'linearIssue')
  const comment = input.comment === undefined ? undefined : required(input.comment, 'comment')
  const argv = [input.orcaBin ?? 'orca', 'worktree', 'create', '--repo', repository, '--name', worktree, '--base-branch', baseBranch, '--agent', agent,
    ...(goalFile === undefined ? [] : ['--prompt-file', goalFile]),
    ...(prompt === undefined ? [] : ['--prompt', prompt]),
    ...(linearIssue === undefined ? [] : ['--linear-issue', linearIssue]),
    ...(comment === undefined ? [] : ['--comment', comment]),
    ...(input.noParent ? ['--no-parent'] : []),
    '--json']
  // Structural arguments stay shell-safe; free text (prompt, comment) travels as a discrete argv element and is never joined into a shell string.
  validateSafeCommand([argv[0], 'worktree', 'create', '--repo', repository, '--name', worktree, '--base-branch', baseBranch, '--agent', agent, ...(goalFile === undefined ? [] : ['--prompt-file', goalFile]), ...(linearIssue === undefined ? [] : ['--linear-issue', linearIssue])].join(' '))
  const identity = { repository, worktree, branch, baseBranch, agent, ...(goalFile === undefined ? {} : { goalFile }), ...(prompt === undefined ? {} : { promptDigest: hashJson(prompt) }), ...(linearIssue === undefined ? {} : { linearIssue }) }
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

import { fail } from '../errors.js'
import { hashJson } from '../hash.js'
import { validateSafeCommand } from '../preflight.js'

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

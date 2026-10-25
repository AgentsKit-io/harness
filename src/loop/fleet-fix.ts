import type { CommandRunner } from '../adapters/command.js'
import type { LoopConfig } from './config.js'
import type { StoredContract } from './contract.js'

/**
 * A fleet task has no terminal, so a fix round for a fleet PR is a new task cut from the PR head. These helpers gather
 * what that task needs to know (the conflicting files, the failing checks' log tail) and write its brief.
 */

const tail = (value: string, max: number): string => { const trimmed = value.trim(); return trimmed.length > max ? `…${trimmed.slice(-max)}` : trimmed }

/** Files `git merge-tree` reports as conflicting when `head` is merged into `origin/<base>`; null when it could not be asked. */
export const conflictingFiles = async (input: { readonly runner: CommandRunner; readonly root: string; readonly base: string; readonly head: string }): Promise<readonly string[] | null> => {
  const { runner, root, base, head } = input
  const git = (args: readonly string[]) => runner.run(['git', '-C', root, ...args], { timeoutMs: 120_000 })
  await git(['fetch', '--quiet', 'origin', base])
  // Exit 1 is "conflicts"; the output is the merged tree's id, then the conflicted paths up to the first blank line.
  const merged = await git(['merge-tree', '--write-tree', '--name-only', '--no-messages', head, `origin/${base}`])
  if (merged.code !== 0 && merged.code !== 1) return null
  const [, ...rest] = merged.stdout.split(/\r?\n/)
  const files: string[] = []
  for (const line of rest) { if (!line.trim()) break; files.push(line.trim()) }
  return [...new Set(files)]
}

/** The last lines of each failing check's log (`gh run view --log-failed`), for the checks that name a run. */
export const failedCheckLogs = async (input: { readonly runner: CommandRunner; readonly root: string; readonly repo: string; readonly checks: readonly { readonly name: string; readonly url?: string }[] }): Promise<string> => {
  const sections: string[] = []
  for (const check of input.checks) {
    const run = /\/actions\/runs\/(\d+)/.exec(check.url ?? '')?.[1]
    if (!run) { sections.push(`### ${check.name}\n(no run log reachable${check.url ? `; see ${check.url}` : ''})`); continue }
    const log = await input.runner.run(['gh', 'run', 'view', run, '--repo', input.repo, '--log-failed'], { timeoutMs: 120_000, cwd: input.root }).catch(() => null)
    sections.push(`### ${check.name}\n${log && log.code === 0 && log.stdout.trim() ? `\`\`\`\n${tail(log.stdout, 3_000)}\n\`\`\`` : `(log unavailable${check.url ? `; see ${check.url}` : ''})`}`)
  }
  return sections.join('\n\n')
}

export interface FleetFixBriefInput {
  readonly config: LoopConfig
  readonly issue: string
  readonly contract: StoredContract | null
  readonly prNumber: number
  readonly prUrl: string
  readonly headRef: string
  readonly baseRef: string
  readonly kind: 'ci' | 'review' | 'conflict'
  /** The exact reason: conflicting files, failing checks with their log tail, or review findings with file:line. */
  readonly reason: string
}

/** Starts with `# Loop worker — <owner/repo>`: that is how the fleet PM recognises a loop brief and releases it. */
export const renderFleetFixBrief = (input: FleetFixBriefInput): string => {
  const { config, contract } = input
  const frozen = contract
    ? `Intent: ${contract.contract.intent}
In scope:
${contract.contract.scope.inScope.map((item) => `- ${item}`).join('\n')}
Out of scope:
${contract.contract.scope.outOfScope.length ? contract.contract.scope.outOfScope.map((item) => `- ${item}`).join('\n') : '- nothing declared'}
Outcomes (every one stays satisfied):
${contract.contract.outcomes.map((outcome) => `- ${outcome.id}: ${outcome.description}${outcome.check.command ? ` — check \`${outcome.check.command}\`` : ''}`).join('\n')}`
    : '(the frozen contract is not on file; the pull request description and the issue are the contract)'
  const task = input.kind === 'conflict'
    ? `Merge the base into this branch (\`git fetch origin ${input.baseRef} && git merge origin/${input.baseRef}\`), resolve the conflicts keeping the contract's behaviour, and commit the merge: one merge commit on top of the PR head. No amend, no squash.`
    : input.kind === 'ci'
      ? 'Fix the root cause of each failing check (never skip or disable a check), then re-run the project verification.'
      : 'Address each finding (or explain in your last commit message why it does not apply), then re-run the project verification.'
  return `# Loop worker — ${config.project.repo}

You are a fix-round worker in an unattended delivery loop for ${config.project.repo}. Your worktree is cut from the head of pull request #${input.prNumber} (${input.prUrl}), branch \`${input.headRef}\`, which targets \`${input.baseRef}\`. Nobody is watching: finish and stop.

1. Read the repository's agent guide (AGENTS.md / CLAUDE.md) first and follow it.
2. Keep every acceptance criterion of the contract below satisfied; change nothing outside it.
3. Run \`${config.delivery.verifyCommand}\` and make it pass before you commit.
4. Commit your work (history is never rewritten: the fleet does not collect it). Do NOT push and do NOT open a pull request — the harness collects the commits and pushes them to the PR branch itself.
5. Commit nothing under \`.ak-loop/\`.

## What is wrong (${input.kind})
${input.reason}

## What to do
${task}

## Contract for ${input.issue} (frozen by the orchestrator${contract ? `, digest ${contract.digest.slice(0, 12)}` : ''})
${frozen}
`
}

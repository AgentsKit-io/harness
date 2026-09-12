import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CommandRunner } from '../adapters/command.js'
import { githubOpenPullRequests, type GitHubCliOptions } from '../adapters/github-cli.js'

/** A GitHub PR the loop never dispatched, picked up only because it carries `github.intakeLabel`. */
export interface IntakeRecord {
  readonly pr: number
  readonly headRef: string
  readonly source: 'github-label'
  readonly addedAt: string
}

/** The synthetic "issue" identifier intake state is filed under (`<stateDir>/issues/pr-<n>/…`) — there is no Linear issue for these. */
export const intakeIssueId = (pr: number): string => `pr-${pr}`

export const intakePath = (stateDir: string, pr: number): string => join(stateDir, 'issues', intakeIssueId(pr), 'intake.json')

export const readIntake = (stateDir: string, pr: number): IntakeRecord | null => {
  const path = intakePath(stateDir, pr)
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, 'utf8')) as IntakeRecord } catch { return null }
}

const writeIntake = (stateDir: string, record: IntakeRecord): void => {
  const path = intakePath(stateDir, record.pr)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
}

/** Every PR currently tracked as intake (label may since have been removed on GitHub — `runDeliver` notices that separately). */
export const listIntake = (stateDir: string): readonly IntakeRecord[] => {
  const dir = join(stateDir, 'issues')
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('pr-'))
    .map((entry) => readIntake(stateDir, Number(entry.name.slice('pr-'.length))))
    .filter((record): record is IntakeRecord => record !== null)
}

/**
 * List every open PR carrying `github.intakeLabel` and start tracking the ones not seen before. Idempotent: a PR
 * already tracked (or already a normal loop dispatch — same repo, so `pr-<n>` cannot collide with a Linear
 * identifier) is left alone; `runDeliver` handles it from state on every later call, not from this discovery.
 */
export const discoverIntake = async (
  runner: CommandRunner,
  input: { readonly repo: string; readonly label: string; readonly stateDir: string; readonly now: () => Date },
  options: GitHubCliOptions = {},
): Promise<readonly IntakeRecord[]> => {
  const prs = await githubOpenPullRequests(runner, { repo: input.repo, label: input.label, limit: 100 }, options)
  const added: IntakeRecord[] = []
  for (const pr of prs) {
    if (readIntake(input.stateDir, pr.number)) continue
    const record: IntakeRecord = { pr: pr.number, headRef: pr.headRef, source: 'github-label', addedAt: input.now().toISOString() }
    writeIntake(input.stateDir, record)
    added.push(record)
  }
  return added
}

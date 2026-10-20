import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { CommandRunner } from '../adapters/command.js'
import { readJsonFile } from '../kernel/json-file.js'
import { writeJsonAtomic } from './fs-atomic.js'

/**
 * ADR-0046: how far an item was actually verified, weakest first. A bare pass/fail hid the difference between
 * "it compiles" and "I ran it against the real thing", and a merge gate cannot ask for what the record cannot say.
 */
export const VERDICT_LEVELS = ['failed', 'blocked', 'type-check-only', 'unit-verified', 'live-verified'] as const
export type Verdict = typeof VERDICT_LEVELS[number]

export const verdictRank = (verdict: Verdict): number => VERDICT_LEVELS.indexOf(verdict)
export const meetsVerdict = (verdict: Verdict, minimum: Verdict): boolean => verdictRank(verdict) >= verdictRank(minimum)
/** A verdict that says the item was demonstrated at some level (anything above `blocked`). */
export const isProven = (verdict: Verdict): boolean => verdictRank(verdict) > verdictRank('blocked')

/**
 * Stored state predates the levels: `passed` becomes `unit-verified` (the strongest claim a bare pass ever backed
 * without saying it ran live) and `failed` stays `failed`. Anything else is not a verdict.
 */
export const migrateVerdict = (value: unknown): Verdict | null => {
  if (value === 'passed') return 'unit-verified'
  return typeof value === 'string' && (VERDICT_LEVELS as readonly string[]).includes(value) ? value as Verdict : null
}

/**
 * A review is reading, not running: a clean one stands at `unit-verified` (it is not a claim the change ran live), a
 * review with findings is `failed`, and one that could not complete is `blocked`. It is judged by its status, not by
 * `minVerdict`, which is about what the definition of done proved.
 */
export const reviewLevel = (status: 'clean' | 'findings' | 'incomplete'): Verdict => status === 'clean' ? 'unit-verified' : status === 'findings' ? 'failed' : 'blocked'

const verdictSchema = z.preprocess((value) => migrateVerdict(value) ?? value, z.enum(VERDICT_LEVELS))

/** What the run was made of. Recorded with every verdict; the contract and guard digests also decide reuse. */
export const FingerprintSchema = z.object({
  contract: z.string().nullable(),
  guardPolicy: z.string(),
  model: z.string().nullable(),
  baseSha: z.string().nullable(),
})
export type RunFingerprint = z.infer<typeof FingerprintSchema>

export const VerdictRecordSchema = z.object({
  schemaVersion: z.literal(1),
  head: z.string(),
  /** `git patch-id --stable` of the PR diff the verdicts were made on; null when it could not be computed. */
  patchId: z.string().nullable(),
  fingerprint: FingerprintSchema,
  at: z.string(),
  items: z.array(z.object({
    id: z.string(),
    list: z.enum(['project', 'issue']),
    description: z.string().default(''),
    verdict: verdictSchema,
    evidence: z.string().default(''),
  })),
})
export type VerdictRecord = z.infer<typeof VerdictRecordSchema>

export const verdictRecordPath = (stateDir: string, issue: string): string => join(stateDir, 'issues', issue, 'verdicts.json')

export const readVerdictRecord = (stateDir: string, issue: string): VerdictRecord | null => {
  const path = verdictRecordPath(stateDir, issue)
  if (!existsSync(path)) return null
  try { return readJsonFile(path, VerdictRecordSchema) } catch { return null }
}

export const writeVerdictRecord = (stateDir: string, issue: string, record: VerdictRecord): void => writeJsonAtomic(verdictRecordPath(stateDir, issue), record)

/**
 * Whether stored verdicts still describe this change. They hold when the diff is the same patch (a rebase or a
 * push that did not change it) made under the same contract and guard policy; the base SHA and model are
 * recorded but a rebase moves the first and a retry the second without changing what was verified. Unknown
 * patch-id (either side) never holds: no binding is no reuse.
 */
export const verdictsHold = (stored: VerdictRecord | null, current: { readonly patchId: string | null; readonly fingerprint: RunFingerprint }): stored is VerdictRecord =>
  stored !== null
  && stored.patchId !== null
  && stored.patchId === current.patchId
  && stored.fingerprint.contract === current.fingerprint.contract
  && stored.fingerprint.guardPolicy === current.fingerprint.guardPolicy

/** `git patch-id --stable` of a PR's diff, or null when either command is unavailable or answers nothing. */
export const patchIdOfPullRequest = async (runner: CommandRunner, input: { readonly repo: string; readonly number: number; readonly cwd?: string }): Promise<string | null> => {
  try {
    const cwd = input.cwd ? { cwd: input.cwd } : {}
    const diff = await runner.run(['gh', 'pr', 'diff', String(input.number), '--repo', input.repo], { timeoutMs: 60_000, ...cwd })
    if (diff.code !== 0 || !diff.stdout.trim()) return null
    const out = await runner.run(['git', 'patch-id', '--stable'], { timeoutMs: 30_000, stdin: diff.stdout, ...cwd })
    const id = out.code === 0 ? out.stdout.trim().split(/\s+/)[0] ?? '' : ''
    return /^[0-9a-f]{40,64}$/.test(id) ? id : null
  } catch { return null }
}

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atLeast, describeGaps, runCodeReview, type CodeReviewInput, type CodeReviewOutcome, type ReviewFileSlice, type ReviewFinding, type ReviewGap, type ReviewUsage } from '../adapters/code-review.js'
import type { CommandRunner } from '../adapters/command.js'
import { githubEnsureLabels, githubIssueCreate } from '../adapters/github-cli.js'

/** After this many review fix rounds on one PR, medium/low leftovers stop asking for another one. */
export const LEFTOVER_ROUNDS = 2
export const BACKLOG_LABEL = 'loop:backlog'
/** Labels whose PRs a person merges, whatever the review said. */
export const PERSON_MERGES_LABELS: readonly string[] = ['loop:risk', 'loop:review']

/**
 * The stop rule: a review that keeps finding new medium findings after the code ones were fixed never converges.
 * It converges once `LEFTOVER_ROUNDS` fix rounds were spent, checks are green, and nothing open is high, a blocker, or
 * about correctness/security. Pure; `deliver` supplies the facts.
 */
export const decideConvergence = (input: { readonly rounds: number; readonly checksGreen: boolean; readonly findings: readonly ReviewFinding[] }): { readonly converge: boolean; readonly reason: string } => {
  if (input.rounds < LEFTOVER_ROUNDS) return { converge: false, reason: `${input.rounds}/${LEFTOVER_ROUNDS} fix rounds` }
  if (!input.checksGreen) return { converge: false, reason: 'checks are not green' }
  const serious = input.findings.filter((finding) => atLeast(finding.severity, 'high') || /correct|secur/i.test(finding.category ?? ''))
  if (serious.length) return { converge: false, reason: `${serious.length} open finding(s) are high or about correctness/security` }
  return { converge: true, reason: `${input.rounds} fix rounds spent, checks green, only medium/low findings left` }
}

export const renderLeftoversBody = (input: { readonly repo: string; readonly pr: number; readonly head: string; readonly findings: readonly ReviewFinding[] }): string => [
  `Medium/low review findings left open on ${input.repo}#${input.pr} (head ${input.head.slice(0, 7)}) when the loop stopped asking for fix rounds.`,
  '',
  ...input.findings.map((finding) => `- [${finding.severity}] ${finding.file ?? 'general'}${finding.line ? `:${finding.line}` : ''} — ${finding.title}${finding.category ? ` (${finding.category})` : ''}`),
  '',
  `Linked PR: #${input.pr}`,
].join('\n')

/** One leftovers issue per PR (`loop:backlog`, linked to it); a second call for the same PR returns the first. */
export const fileLeftoversIssue = async (runner: CommandRunner, input: { readonly repo: string; readonly pr: number; readonly head: string; readonly findings: readonly ReviewFinding[] }): Promise<{ readonly number: number | null; readonly url: string | null }> => {
  await githubEnsureLabels(runner, { repo: input.repo, labels: [BACKLOG_LABEL] }).catch(() => [])
  const key = `leftovers-${input.pr}`
  const created = await githubIssueCreate(runner, { repo: input.repo, title: `Review leftovers for #${input.pr}`, body: `${renderLeftoversBody(input)}\n\n<!-- harness:${key} -->`, labels: [BACKLOG_LABEL], dedupeKey: key })
  return { number: created.identifier ? Number(created.identifier.split('#').pop()) || null : null, url: created.url }
}

export const leftoversComment = (leftovers: number | null): string => `**Loop review**: ready to merge with leftovers (#${leftovers ?? '?'}) — the remaining medium/low findings moved to a \`${BACKLOG_LABEL}\` issue.`

export const gapsComment = (gaps: readonly ReviewGap[]): string => `**Loop review**: review ran with gaps — not reviewed after retrying each file alone and with another model: ${describeGaps(gaps)}. Checks are green, so this does not hold the PR.`

/**
 * "Review ran with gaps": after the retries, an incomplete review on a green PR that parsed, named the files it could
 * not cover and found nothing blocking is not a hold — the gaps are listed instead. Without named files (no result,
 * provider down) nothing was demonstrably reviewed, so it stays incomplete.
 */
export const acceptGaps = (review: CodeReviewOutcome, checksGreen: boolean): CodeReviewOutcome =>
  review.status === 'incomplete' && checksGreen && review.resultParsed && review.gaps.length > 0 && review.blocking.length === 0
    ? { ...review, status: 'clean', summary: `review ran with gaps: ${describeGaps(review.gaps)}` }
    : review

export interface ResilientReviewOptions {
  /** Another provider/model to try a failed file with once the original one failed it alone. */
  readonly fallback?: { readonly provider: string; readonly model: string } | null
  /** A file longer than this many lines is reviewed in chunks of this size when it failed on size/limit. */
  readonly chunkLines?: number
  /** Line count of a file of the PR; null when unknown (then it is retried whole). Default reads it from `input.cwd`. */
  readonly lineCount?: (file: string) => number | null
  /** The review invocation; `runCodeReview` unless a test substitutes it. */
  readonly run?: (input: CodeReviewInput) => Promise<CodeReviewOutcome>
}

const sumUsage = (usages: readonly ReviewUsage[]): ReviewUsage => {
  const total = (pick: (usage: ReviewUsage) => number | null): number | null => usages.some((usage) => pick(usage) !== null) ? usages.reduce((sum, usage) => sum + (pick(usage) ?? 0), 0) : null
  return { providerCalls: total((usage) => usage.providerCalls), inputTokens: total((usage) => usage.inputTokens), outputTokens: total((usage) => usage.outputTokens), totalTokens: total((usage) => usage.totalTokens) }
}

const chunksOf = (file: string, lines: number | null, chunkLines: number): readonly ReviewFileSlice[] => {
  if (lines === null || lines <= chunkLines) return [{ path: file }]
  return Array.from({ length: Math.ceil(lines / chunkLines) }, (_, index) => ({ path: file, range: [index * chunkLines + 1, Math.min(lines, (index + 1) * chunkLines)] as const }))
}

/**
 * One review, and when it comes back incomplete naming files it could not cover, a retry of each such file alone and
 * then with another model — instead of failing the whole review for one file. A file that failed on size or limit is
 * reviewed in chunks. What still cannot be covered stays in `gaps` (the review stays `incomplete`); everything that was
 * covered, by the first run or a retry, counts.
 */
export const reviewWithRetries = async (runner: CommandRunner, input: CodeReviewInput, options: ResilientReviewOptions = {}): Promise<CodeReviewOutcome> => {
  const run = options.run ?? ((next: CodeReviewInput) => runCodeReview(runner, next))
  const first = await run(input)
  if (first.status !== 'incomplete' || !first.resultParsed || !first.gaps.length) return first
  const chunkLines = options.chunkLines ?? 800
  const lineCount = options.lineCount ?? ((file: string): number | null => {
    const path = join(input.cwd ?? '.', file)
    return existsSync(path) ? readFileSync(path, 'utf8').split('\n').length : null
  })
  let attempt = 0
  const covered = async (gap: ReviewGap, via: { readonly provider: string; readonly model: string | undefined }): Promise<readonly CodeReviewOutcome[] | null> => {
    const slices = gap.reason === 'size' || gap.reason === 'limit' ? chunksOf(gap.file, lineCount(gap.file), chunkLines) : [{ path: gap.file }]
    const outcomes: CodeReviewOutcome[] = []
    for (const slice of slices) {
      attempt += 1
      const outcome = await run({ ...input, provider: via.provider, ...(via.model ? { model: via.model } : {}), files: [slice], resultFile: input.resultFile.replace(/\.json$/, `-retry-${attempt}.json`), post: false })
      outcomes.push(outcome)
      if (outcome.status === 'incomplete') return null
    }
    return outcomes
  }
  const extra: CodeReviewOutcome[] = []
  const remaining: ReviewGap[] = []
  for (const gap of first.gaps) {
    const alone = await covered(gap, { provider: input.provider, model: input.model })
    const done = alone ?? (options.fallback ? await covered(gap, options.fallback) : null)
    if (done) extra.push(...done)
    else remaining.push(gap)
  }
  const findings = [...first.findings, ...extra.flatMap((outcome) => outcome.findings)]
  const blocking = findings.filter((finding) => atLeast(finding.severity, input.minSeverity))
  const status: CodeReviewOutcome['status'] = remaining.length ? 'incomplete' : blocking.length ? 'findings' : 'clean'
  const recovered = first.gaps.length - remaining.length
  const summary = remaining.length
    ? `review incomplete after retries — not reviewed: ${describeGaps(remaining)}${recovered ? ` (${recovered} file(s) recovered by retry)` : ''}`
    : status === 'findings' ? `${blocking.length} finding(s) at/above ${input.minSeverity} (${recovered} file(s) recovered by retry)` : `clean at/above ${input.minSeverity} (${findings.length} lower-severity note(s); ${recovered} file(s) recovered by retry)`
  return { ...first, status, findings, blocking, summary, gaps: remaining, usage: sumUsage([first.usage, ...extra.map((outcome) => outcome.usage)]) }
}

import { isRecord } from '../record.js'
import { splitLines } from '@agentskit/cross-platform'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CommandRunner } from './command.js'

/** agentskit-review severities, weakest first. */
export const REVIEW_SEVERITIES = ['nit', 'med', 'high', 'blocker'] as const
export type ReviewSeverity = typeof REVIEW_SEVERITIES[number]

export interface ReviewFinding {
  readonly severity: ReviewSeverity
  readonly file: string | null
  readonly line: number | null
  readonly title: string
  readonly detail: string
  readonly category: string | null
}

export interface StructuredReviewHitl {
  readonly question: string
  readonly context: string
  readonly options: readonly { readonly id: string; readonly title: string; readonly description: string }[]
  readonly recommendedOptionId: string
}

/** What one review invocation cost — agentskit-review already tracks this (`ReviewResult.evidence`); the harness
 * only needs to read it and pass it on, instead of discarding it the way `parseReviewResult` used to. */
export interface ReviewUsage {
  readonly providerCalls: number | null
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  /** `evidence.tokensUsed` when the provider only reports one combined figure, otherwise input+output. */
  readonly totalTokens: number | null
}

export interface CodeReviewOutcome {
  /** `clean` = no finding at/above the floor; `findings` = blocking findings; `incomplete` = coverage/provider/tool failure. */
  readonly status: 'clean' | 'findings' | 'incomplete'
  readonly exitCode: number | null
  readonly findings: readonly ReviewFinding[]
  readonly blocking: readonly ReviewFinding[]
  readonly summary: string
  readonly provider: string
  readonly model: string | null
  readonly resultParsed: boolean
  /** Last 800 chars of combined stderr+stdout, for callers that need to classify *why* a review was incomplete (auth/quota/timeout) beyond the truncated `summary`. */
  readonly rawTail: string
  readonly usage: ReviewUsage
  readonly hitl?: readonly StructuredReviewHitl[]
  /** Files the review could not cover, and why. Present when the reviewer named them (result JSON or its own summary line). */
  readonly gaps?: readonly ReviewGap[]
}

/** A file the review did not cover. `reason`: `empty output` (no JSON came back), `limit` (tokens, calls, time),
 * `size` (too large for one call), or the reviewer's own words. */
export interface ReviewGap {
  readonly file: string
  readonly lens: string | null
  readonly reason: string
}

export interface CodeReviewInput {
  readonly cli: string
  readonly repo: string
  /** `project.baseBranch` — only reaches the CLI via the `--config` temp file (see `buildAnalysisTokenConfig`'s `target.baseBranch`) when one is written; `--pr` below is what actually selects the PR. */
  readonly baseBranch: string
  readonly number: number
  readonly provider: string
  readonly model?: string
  /** `trusted-local` keeps the caller's env so CLI logins work; omitted = agentskit-review's isolated default. */
  readonly mode?: 'trusted-local' | 'isolated'
  /** agentskit-review transport override (`headless` needed for current grok-cli; ACP is broken on submit_batched_findings). */
  readonly transport?: 'acp' | 'headless' | 'auto'
  readonly profile: string
  readonly votes: number
  readonly concurrency?: number
  readonly minSeverity: ReviewSeverity
  readonly deadlineMs: number
  /** Forwarded as `AGENTSKIT_REVIEW_SUBPROCESS_TIMEOUT_MS` — see that config field's own doc comment for why this exists separately from `deadlineMs`. */
  readonly subprocessTimeoutMs?: number
  /**
   * `agentskit-review`'s per-run analysis token budget (`review.maxTokens`/`globalMaxTokens` — 87_200 usable
   * by default under `--profile fast`) has no CLI flag; it is readable only from a `--config <file>` JSON
   * document, which nothing here ever generated. Observed live: an ordinary ~10-file issue PR — not an
   * unusually large one — exceeded the default and aborted mid-review (`analysis tokens budget exceeded
   * (87200)`), landing as the same `status: incomplete` the missing subprocess timeout used to cause. When
   * either is set, `runCodeReview` writes a small temp config with just these two fields (plus the minimal
   * `target` block the CLI's schema requires present, even though `--pr` below is what actually selects the
   * PR) and passes `--config` pointing at it.
   */
  readonly analysisMaxTokens?: number
  readonly analysisGlobalMaxTokens?: number
  readonly maxCalls: number
  readonly post: boolean
  readonly resultFile: string
  readonly sarifFile?: string
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  /** Scope the run to these files (`<path>` or `<path>:<start>-<end>`), each passed after `fileFlag`. */
  readonly files?: readonly string[]
  readonly fileFlag?: string
}

const str = (value: unknown, fallback = ''): string => typeof value === 'string' ? value : fallback

export const severityRank = (severity: string): number => Math.max(0, (REVIEW_SEVERITIES as readonly string[]).indexOf(severity))
export const atLeast = (severity: string, floor: ReviewSeverity): boolean => (REVIEW_SEVERITIES as readonly string[]).includes(severity) && severityRank(severity) >= severityRank(floor)

const normalizeSeverity = (value: unknown): ReviewSeverity => {
  const raw = str(value).toLowerCase()
  if ((REVIEW_SEVERITIES as readonly string[]).includes(raw)) return raw as ReviewSeverity
  if (raw === 'critical' || raw === 'error') return 'blocker'
  if (raw === 'major' || raw === 'warning') return 'high'
  if (raw === 'minor' || raw === 'medium' || raw === 'note') return 'med'
  return 'nit'
}

/** Read findings out of the `--result` JSON (the agent's review object) tolerating shape drift across CLI versions. */
export const parseReviewResult = (value: unknown): { readonly findings: readonly ReviewFinding[]; readonly blocking: boolean | null; readonly incomplete: boolean | null } => {
  const record = isRecord(value) ? (isRecord(value['review']) ? value['review'] : value) : {}
  const list = Array.isArray(record['findings']) ? record['findings'] : Array.isArray(record['verifiedFindings']) ? record['verifiedFindings'] : []
  const findings = list.filter(isRecord).map((item) => {
    const location = isRecord(item['location']) ? item['location'] : item
    const line = typeof location['line'] === 'number' ? location['line'] : typeof location['startLine'] === 'number' ? location['startLine'] : null
    return { severity: normalizeSeverity(item['severity']), file: str(location['file'], str(location['path'], str(item['file']))) || null, line, title: str(item['title'], str(item['summary'], str(item['message']))).trim() || 'finding', detail: [str(item['rationale']), str(item['suggestion']) ? `Suggestion: ${str(item['suggestion'])}` : '', str(item['detail'], str(item['description'], str(item['body'], str(item['message']))))].filter(Boolean).join('\n').trim(), category: str(item['category'], str(item['lens'])) || null }
  })
  return { findings, blocking: typeof record['blocking'] === 'boolean' ? record['blocking'] : null, incomplete: typeof record['incomplete'] === 'boolean' ? record['incomplete'] : null }
}

/** Structured reviewer decisions are optional; malformed cards are ignored and the review remains fail-closed. */
export const parseReviewHitl = (value: unknown): readonly StructuredReviewHitl[] => {
  const record = isRecord(value) ? (isRecord(value['review']) ? value['review'] : value) : {}
  if (!Array.isArray(record['hitl'])) return []
  return record['hitl'].filter(isRecord).flatMap((item) => {
    const question = str(item['question']).trim(); const context = str(item['context']).trim(); const recommendedOptionId = str(item['recommendedOptionId']).trim()
    const options = Array.isArray(item['options']) ? item['options'].filter(isRecord).map((option) => ({ id: str(option['id']).trim(), title: str(option['title']).trim(), description: str(option['description']).trim() })).filter((option) => option.id && option.title && option.description) : []
    const ids = new Set(options.map((option) => option.id))
    return question && options.length >= 3 && options.length <= 4 && ids.size === options.length && ids.has(recommendedOptionId) ? [{ question, context, options, recommendedOptionId }] : []
  })
}

const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null

/** Read `ReviewResult.evidence`/`evidence.usage` out of the same `--result` JSON — agentskit-review already
 * accounts for provider calls and tokens per invocation; this only stops the harness from discarding it. Kept
 * separate from `parseReviewResult` (rather than added to its return value) so that function's exact-shape tests
 * stay meaningful. */
export const parseReviewEvidence = (value: unknown): ReviewUsage => {
  const record = isRecord(value) ? (isRecord(value['review']) ? value['review'] : value) : {}
  const evidence = isRecord(record['evidence']) ? record['evidence'] : {}
  const usage = isRecord(evidence['usage']) ? evidence['usage'] : {}
  const inputTokens = num(usage['inputTokens'])
  const outputTokens = num(usage['outputTokens'])
  const tokensUsed = num(evidence['tokensUsed'])
  return {
    providerCalls: num(evidence['providerCalls']),
    inputTokens,
    outputTokens,
    totalTokens: tokensUsed ?? (inputTokens !== null || outputTokens !== null ? (inputTokens ?? 0) + (outputTokens ?? 0) : null),
  }
}

export const buildReviewArgv = (input: CodeReviewInput): readonly string[] => [input.cli, '--pr', `${input.repo}#${input.number}`, '--provider', input.provider, ...(input.model ? ['--model', input.model] : []), ...(input.mode && input.mode !== 'isolated' ? ['--mode', input.mode] : []), ...(input.transport ? ['--transport', input.transport] : []), '--profile', input.profile, '--votes', String(input.votes), ...(input.concurrency ? ['--concurrency', String(input.concurrency)] : []), '--min-severity', 'nit', '--block', input.minSeverity, '--max-calls', String(input.maxCalls), '--deadline-ms', String(input.deadlineMs), '--result', input.resultFile, ...(input.sarifFile ? ['--sarif', input.sarifFile] : []), ...(input.post ? ['--post'] : []), ...(input.fileFlag ? (input.files ?? []).flatMap((file) => [input.fileFlag as string, file]) : [])]

/** Why a file was not covered, in the three words a person needs; null when the text says none of them. */
const gapCause = (text: string): string | null =>
  /no (?:parseable |valid )?json|empty (?:output|response|result)|no output|returned nothing/i.test(text) ? 'empty output'
    : /too (?:large|big)|file size|exceeds? [^\n]*(?:bytes|lines|chars)/i.test(text) ? 'size'
      : /budget|limit|max[- ]?(?:tokens|calls)|timed? ?out|deadline/i.test(text) ? 'limit' : null

const ZERO_LENSES = /zero successful lenses:\s*([^\n]+)/i

/**
 * The files a review did not cover, from the `--result` JSON (`gaps` / `failedFiles` / `lensFailures`) or the
 * reviewer's own summary line ("1 reviewable file had zero successful lenses: a.ts, b.ts"). The cause comes from
 * the entry itself, else from a tail line naming the file, else the tail as a whole.
 */
export const parseReviewGaps = (value: unknown, tail: string): readonly ReviewGap[] => {
  const record = isRecord(value) ? (isRecord(value['review']) ? value['review'] : value) : {}
  const lines = splitLines(tail).filter((line) => !ZERO_LENSES.test(line))
  const causeFor = (file: string, own = ''): string => gapCause(own) ?? gapCause(lines.filter((line) => line.includes(file)).join('\n')) ?? gapCause(lines.join('\n')) ?? (own.trim().slice(0, 120) || 'cause not reported by the reviewer')
  const gaps: ReviewGap[] = ['gaps', 'failedFiles', 'lensFailures'].flatMap((key) => Array.isArray(record[key]) ? record[key] as unknown[] : []).flatMap((item) => {
    if (typeof item === 'string') return item.trim() ? [{ file: item.trim(), lens: null, reason: causeFor(item.trim()) }] : []
    if (!isRecord(item)) return []
    const file = str(item['file'], str(item['path'])).trim()
    return file ? [{ file, lens: str(item['lens']) || null, reason: causeFor(file, str(item['reason'], str(item['error'], str(item['message'])))) }] : []
  })
  for (const raw of ZERO_LENSES.exec(tail)?.[1]?.split(/,\s*/) ?? []) {
    const file = raw.trim().replace(/[.;)]+$/, '')
    if (file && !gaps.some((gap) => gap.file === file)) gaps.push({ file, lens: null, reason: causeFor(file) })
  }
  return gaps.filter((gap, index) => gaps.findIndex((other) => other.file === gap.file && other.lens === gap.lens) === index)
}

export const renderReviewGap = (gap: ReviewGap): string => `${gap.file}${gap.lens ? ` (${gap.lens})` : ''}: ${gap.reason}`

/**
 * The `--config` document's own schema requires every top-level section present (`target` has no schema
 * default), even though `--pr` below is what actually selects the PR — this exists only to carry
 * `analysisMaxTokens`/`analysisGlobalMaxTokens` through, which have no CLI flag of their own.
 */
const buildAnalysisTokenConfig = (input: CodeReviewInput): Record<string, unknown> => ({
  target: { provider: 'github', repository: input.repo, baseBranch: input.baseBranch },
  review: { maxTokens: input.analysisMaxTokens, globalMaxTokens: input.analysisGlobalMaxTokens },
})

/** Run one review. Exit 0 = clean, 1 = findings at/above the floor, 2 = incomplete; the `--result` file is the evidence — without a parseable one the review is `incomplete`, whatever the exit code. */
export const runCodeReview = async (runner: CommandRunner, input: CodeReviewInput): Promise<CodeReviewOutcome> => {
  const needsTokenConfig = input.analysisMaxTokens !== undefined || input.analysisGlobalMaxTokens !== undefined
  // A random id, not just the PR number: two review invocations for the same PR (a retry started before a
  // killed prior attempt's process fully released the file, or a lock bypass, or simply two concurrent calls in
  // this same process) would otherwise share one path and step on each other's config/cleanup mid-run.
  const configFile = needsTokenConfig ? join(dirname(input.resultFile), `.review-config-${input.number}-${randomUUID()}.json`) : null
  if (configFile) writeFileSync(configFile, JSON.stringify(buildAnalysisTokenConfig(input)), 'utf8')
  // The result path is per head, so a rerun at the same head would otherwise read the last run's file as its own evidence.
  if (existsSync(input.resultFile)) unlinkSync(input.resultFile)
  try {
    const argv = [...buildReviewArgv(input), ...(configFile ? ['--config', configFile] : [])]
    const env = input.subprocessTimeoutMs ? { ...input.env, AGENTSKIT_REVIEW_SUBPROCESS_TIMEOUT_MS: String(input.subprocessTimeoutMs) } : input.env
    const outcome = await runner.run(argv, { timeoutMs: input.deadlineMs + 120_000, ...(input.cwd ? { cwd: input.cwd } : {}), ...(env ? { env } : {}) })
    return finishCodeReview(input, outcome)
  } finally {
    if (configFile && existsSync(configFile)) unlinkSync(configFile)
  }
}

const finishCodeReview = (input: CodeReviewInput, outcome: Awaited<ReturnType<CommandRunner['run']>>): CodeReviewOutcome => {
  let parsed: ReturnType<typeof parseReviewResult> | null = null
  let usage: ReviewUsage = { providerCalls: null, inputTokens: null, outputTokens: null, totalTokens: null }
  let hitl: readonly StructuredReviewHitl[] = []
  let resultJson: unknown = null
  if (existsSync(input.resultFile)) {
    try {
      resultJson = JSON.parse(readFileSync(input.resultFile, 'utf8'))
      parsed = parseReviewResult(resultJson)
      usage = parseReviewEvidence(resultJson)
      hitl = parseReviewHitl(resultJson)
    } catch { parsed = null }
  }
  const findings = parsed?.findings ?? []
  const blocking = findings.filter((finding) => atLeast(finding.severity, input.minSeverity))
  const tail = `${outcome.stderr.trim()}\n${outcome.stdout.trim()}`.trim().slice(-800)
  // The harness's own floor decides: exit 1 (or `blocking: true`) on findings that are all below `minSeverity` is
  // clean here, not "findings" with nothing to fix — that left deliver waiting forever for a push nobody needed.
  // A reviewer that claims blocking but lists no finding at all is contradicting itself: not evidence either way.
  const selfContradicting = parsed !== null && parsed.blocking === true && findings.length === 0
  const status: CodeReviewOutcome['status'] = outcome.timedOut || outcome.code === 2 || outcome.code === null || (outcome.code !== 0 && outcome.code !== 1) || parsed === null || parsed.incomplete === true || selfContradicting ? 'incomplete' : blocking.length ? 'findings' : 'clean'
  const gaps = status === 'incomplete' ? parseReviewGaps(resultJson, tail) : []
  const named = gaps.length ? ` not reviewed: ${gaps.map(renderReviewGap).join('; ').slice(0, 300)} —` : ''
  const summary = status === 'incomplete' ? `review incomplete (exit ${outcome.timedOut ? 'timeout' : outcome.code ?? 'null'}${parsed === null ? ', no parseable result file' : selfContradicting ? ', blocking reported with no findings' : ''}):${named} ${tail.split('\n').slice(-3).join(' ').slice(0, 300)}` : status === 'findings' ? `${blocking.length || 'unknown number of'} finding(s) at/above ${input.minSeverity}` : `clean at/above ${input.minSeverity} (${findings.length} lower-severity note(s))`
  return { status, exitCode: outcome.timedOut ? null : outcome.code, findings, blocking, summary, provider: input.provider, model: input.model ?? null, resultParsed: parsed !== null, rawTail: tail, usage, ...(hitl.length ? { hitl } : {}), ...(gaps.length ? { gaps } : {}) }
}

export interface GapRecoveryOptions {
  /**
   * agentskit-review's flag that scopes a run to one file, given `<path>` or `<path>:<start>-<end>` (an open end
   * runs to the end of the file). null turns file retries off: the gaps stand as reported.
   */
  readonly fileFlag: string | null
  /** A file with more changed lines than this, or one that failed on size or a limit, is reviewed in chunks. */
  readonly chunkLines: number
  /** Changed lines per file on the PR — a new file's whole length. */
  readonly fileLines: Readonly<Record<string, number>>
  /** The second reviewer to try a failing file with; null when no other one is available. */
  readonly fallback: { readonly provider: string; readonly model: string | null } | null
}

// ponytail: fixed caps; at most 5 files x 2 reviewers x 4 chunks extra calls, so one bad PR cannot run up the bill.
const MAX_GAP_FILES = 5
const MAX_CHUNKS = 4

/** Line ranges for a chunked review: at least two, at most MAX_CHUNKS, the last open-ended (an edited file is longer than its diff). */
export const chunkRanges = (lines: number, chunkLines: number): readonly string[] => {
  const count = Math.min(MAX_CHUNKS, Math.max(2, Math.ceil(lines / chunkLines)))
  const size = Math.max(chunkLines, Math.ceil(lines / count))
  return Array.from({ length: count }, (_, index) => index === count - 1 ? `${index * size + 1}-` : `${index * size + 1}-${(index + 1) * size}`)
}

const addUsage = (a: ReviewUsage, b: ReviewUsage): ReviewUsage => {
  const sum = (x: number | null, y: number | null): number | null => x === null && y === null ? null : (x ?? 0) + (y ?? 0)
  return { providerCalls: sum(a.providerCalls, b.providerCalls), inputTokens: sum(a.inputTokens, b.inputTokens), outputTokens: sum(a.outputTokens, b.outputTokens), totalTokens: sum(a.totalTokens, b.totalTokens) }
}

/**
 * A review that failed on some files is not thrown away: each failing file is reviewed alone (in chunks when it is
 * large), then with another reviewer. What comes back joins the first run's findings — written back to its
 * `--result` file, so the next pass reads them — and what still fails stays a named gap. Only for a review that
 * produced its result for everything else (`resultParsed`): without that there is nothing to complete.
 */
export const recoverReviewGaps = async (runner: CommandRunner, input: CodeReviewInput, outcome: CodeReviewOutcome, options: GapRecoveryOptions): Promise<CodeReviewOutcome> => {
  const gaps = outcome.gaps ?? []
  if (outcome.status !== 'incomplete' || !gaps.length || !outcome.resultParsed || !options.fileFlag) return outcome
  const findings: ReviewFinding[] = [...outcome.findings]
  const left: ReviewGap[] = []
  const reviewers = [{ provider: input.provider, model: input.model ?? null }, ...(options.fallback ? [options.fallback] : [])]
  let usage = outcome.usage
  let calls = 0
  for (const [index, gap] of gaps.filter((item, at) => gaps.findIndex((other) => other.file === item.file) === at).entries()) {
    if (index >= MAX_GAP_FILES) { left.push({ ...gap, reason: `${gap.reason}; not retried (more than ${MAX_GAP_FILES} files failed)` }); continue }
    const lines = options.fileLines[gap.file] ?? 0
    const chunked = lines > options.chunkLines || gap.reason === 'size' || gap.reason === 'limit'
    const scopes = chunked ? chunkRanges(lines, options.chunkLines).map((range) => `${gap.file}:${range}`) : [gap.file]
    let last = gap
    let covered = false
    for (const reviewer of reviewers) {
      const runs: CodeReviewOutcome[] = []
      for (const scope of scopes) {
        calls += 1
        runs.push(await runCodeReview(runner, { ...input, provider: reviewer.provider, model: reviewer.model ?? undefined, fileFlag: options.fileFlag, files: [scope], post: false, resultFile: input.resultFile.replace(/\.json$/, `-retry-${calls}.json`) }))
      }
      for (const run of runs) { usage = addUsage(usage, run.usage); if (run.resultParsed) findings.push(...run.findings) }
      const failed = runs.find((run) => run.status === 'incomplete')
      if (!failed) { covered = true; break }
      const how = `${chunked ? `retried in ${scopes.length} chunks` : 'retried alone'}${reviewers.length > 1 ? ', then with another model' : ''}`
      last = { file: gap.file, lens: failed.gaps?.[0]?.lens ?? gap.lens, reason: `${failed.gaps?.find((item) => item.file.startsWith(gap.file))?.reason ?? gapCause(failed.rawTail) ?? gap.reason} (${how})` }
    }
    if (!covered) left.push(last)
  }
  const unique = findings.filter((finding, at) => findings.findIndex((other) => other.file === finding.file && other.line === finding.line && other.title === finding.title) === at)
  const blocking = unique.filter((finding) => atLeast(finding.severity, input.minSeverity))
  const status: CodeReviewOutcome['status'] = left.length ? 'incomplete' : blocking.length ? 'findings' : 'clean'
  try { writeFileSync(input.resultFile, JSON.stringify({ findings: unique, blocking: blocking.length > 0, incomplete: left.length > 0, gaps: left })) } catch { /* the outcome below still carries everything */ }
  const recovered = gaps.length - left.length
  const summary = left.length ? `review incomplete: not reviewed: ${left.map(renderReviewGap).join('; ').slice(0, 400)}${recovered ? ` (${recovered} other failing file(s) recovered on retry)` : ''}` : `${status === 'findings' ? `${blocking.length} finding(s) at/above ${input.minSeverity}` : `clean at/above ${input.minSeverity}`} after retrying ${gaps.length} failing file(s)`
  return { ...outcome, status, findings: unique, blocking, summary, usage, gaps: left.length ? left : undefined }
}

/** Compact, worker-facing rendering of blocking findings for a fix round. */
export const renderFindingsForWorker = (findings: readonly ReviewFinding[], max = 15): string => findings.slice(0, max).map((finding, index) => `${index + 1}. [${finding.severity}] ${finding.file ?? 'general'}${finding.line ? `:${finding.line}` : ''} — ${finding.title}${finding.detail && finding.detail !== finding.title ? `\n   ${finding.detail.slice(0, 400)}` : ''}`).join('\n') + (findings.length > max ? `\n… ${findings.length - max} more in the PR review.` : '')

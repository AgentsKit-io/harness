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
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
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

export const buildReviewArgv = (input: CodeReviewInput): readonly string[] => [input.cli, '--pr', `${input.repo}#${input.number}`, '--provider', input.provider, ...(input.model ? ['--model', input.model] : []), ...(input.mode && input.mode !== 'isolated' ? ['--mode', input.mode] : []), ...(input.transport ? ['--transport', input.transport] : []), '--profile', input.profile, '--votes', String(input.votes), ...(input.concurrency ? ['--concurrency', String(input.concurrency)] : []), '--min-severity', 'nit', '--block', input.minSeverity, '--max-calls', String(input.maxCalls), '--deadline-ms', String(input.deadlineMs), '--result', input.resultFile, ...(input.sarifFile ? ['--sarif', input.sarifFile] : []), ...(input.post ? ['--post'] : [])]

/**
 * The `--config` document's own schema requires every top-level section present (`target` has no schema
 * default), even though `--pr` below is what actually selects the PR — this exists only to carry
 * `analysisMaxTokens`/`analysisGlobalMaxTokens` through, which have no CLI flag of their own.
 */
const buildAnalysisTokenConfig = (input: CodeReviewInput): Record<string, unknown> => ({
  target: { provider: 'github', repository: input.repo, baseBranch: input.baseBranch },
  review: { maxTokens: input.analysisMaxTokens, globalMaxTokens: input.analysisGlobalMaxTokens },
})

/** Run one review. Exit 0 = clean, 1 = findings at/above the floor, 2 = incomplete; the `--result` file refines the verdict. */
export const runCodeReview = async (runner: CommandRunner, input: CodeReviewInput): Promise<CodeReviewOutcome> => {
  const needsTokenConfig = input.analysisMaxTokens !== undefined || input.analysisGlobalMaxTokens !== undefined
  // A random id, not just the PR number: two review invocations for the same PR (a retry started before a
  // killed prior attempt's process fully released the file, or a lock bypass, or simply two concurrent calls in
  // this same process) would otherwise share one path and step on each other's config/cleanup mid-run.
  const configFile = needsTokenConfig ? join(dirname(input.resultFile), `.review-config-${input.number}-${randomUUID()}.json`) : null
  if (configFile) writeFileSync(configFile, JSON.stringify(buildAnalysisTokenConfig(input)), 'utf8')
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
  if (existsSync(input.resultFile)) {
    try {
      const resultJson = JSON.parse(readFileSync(input.resultFile, 'utf8'))
      parsed = parseReviewResult(resultJson)
      usage = parseReviewEvidence(resultJson)
      hitl = parseReviewHitl(resultJson)
    } catch { parsed = null }
  }
  const findings = parsed?.findings ?? []
  const blocking = findings.filter((finding) => atLeast(finding.severity, input.minSeverity))
  const tail = `${outcome.stderr.trim()}\n${outcome.stdout.trim()}`.trim().slice(-800)
  const status: CodeReviewOutcome['status'] = outcome.timedOut || outcome.code === 2 || outcome.code === null || (outcome.code !== 0 && outcome.code !== 1) || parsed?.incomplete === true ? 'incomplete' : blocking.length || outcome.code === 1 || parsed?.blocking === true ? 'findings' : 'clean'
  const summary = status === 'incomplete' ? `review incomplete (exit ${outcome.timedOut ? 'timeout' : outcome.code ?? 'null'}): ${tail.split('\n').slice(-3).join(' ').slice(0, 300)}` : status === 'findings' ? `${blocking.length || 'unknown number of'} finding(s) at/above ${input.minSeverity}` : `clean at/above ${input.minSeverity} (${findings.length} lower-severity note(s))`
  return { status, exitCode: outcome.timedOut ? null : outcome.code, findings, blocking, summary, provider: input.provider, model: input.model ?? null, resultParsed: parsed !== null, rawTail: tail, usage, ...(hitl.length ? { hitl } : {}) }
}

/** Compact, worker-facing rendering of blocking findings for a fix round. */
export const renderFindingsForWorker = (findings: readonly ReviewFinding[], max = 15): string => findings.slice(0, max).map((finding, index) => `${index + 1}. [${finding.severity}] ${finding.file ?? 'general'}${finding.line ? `:${finding.line}` : ''} — ${finding.title}${finding.detail && finding.detail !== finding.title ? `\n   ${finding.detail.slice(0, 400)}` : ''}`).join('\n') + (findings.length > max ? `\n… ${findings.length - max} more in the PR review.` : '')

import { existsSync, readFileSync } from 'node:fs'
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
}

export interface CodeReviewInput {
  readonly cli: string
  readonly repo: string
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

export const buildReviewArgv = (input: CodeReviewInput): readonly string[] => [input.cli, '--pr', `${input.repo}#${input.number}`, '--provider', input.provider, ...(input.model ? ['--model', input.model] : []), ...(input.mode && input.mode !== 'isolated' ? ['--mode', input.mode] : []), ...(input.transport ? ['--transport', input.transport] : []), '--profile', input.profile, '--votes', String(input.votes), ...(input.concurrency ? ['--concurrency', String(input.concurrency)] : []), '--min-severity', 'nit', '--block', input.minSeverity, '--max-calls', String(input.maxCalls), '--deadline-ms', String(input.deadlineMs), '--result', input.resultFile, ...(input.sarifFile ? ['--sarif', input.sarifFile] : []), ...(input.post ? ['--post'] : [])]

/** Run one review. Exit 0 = clean, 1 = findings at/above the floor, 2 = incomplete; the `--result` file refines the verdict. */
export const runCodeReview = async (runner: CommandRunner, input: CodeReviewInput): Promise<CodeReviewOutcome> => {
  const argv = buildReviewArgv(input)
  const outcome = await runner.run(argv, { timeoutMs: input.deadlineMs + 120_000, ...(input.cwd ? { cwd: input.cwd } : {}), ...(input.env ? { env: input.env } : {}) })
  let parsed: ReturnType<typeof parseReviewResult> | null = null
  if (existsSync(input.resultFile)) { try { parsed = parseReviewResult(JSON.parse(readFileSync(input.resultFile, 'utf8'))) } catch { parsed = null } }
  const findings = parsed?.findings ?? []
  const blocking = findings.filter((finding) => atLeast(finding.severity, input.minSeverity))
  const tail = `${outcome.stderr.trim()}\n${outcome.stdout.trim()}`.trim().slice(-800)
  const status: CodeReviewOutcome['status'] = outcome.timedOut || outcome.code === 2 || outcome.code === null || (outcome.code !== 0 && outcome.code !== 1) || parsed?.incomplete === true ? 'incomplete' : blocking.length || outcome.code === 1 || parsed?.blocking === true ? 'findings' : 'clean'
  const summary = status === 'incomplete' ? `review incomplete (exit ${outcome.timedOut ? 'timeout' : outcome.code ?? 'null'}): ${tail.split('\n').slice(-3).join(' ').slice(0, 300)}` : status === 'findings' ? `${blocking.length || 'unknown number of'} finding(s) at/above ${input.minSeverity}` : `clean at/above ${input.minSeverity} (${findings.length} lower-severity note(s))`
  return { status, exitCode: outcome.timedOut ? null : outcome.code, findings, blocking, summary, provider: input.provider, model: input.model ?? null, resultParsed: parsed !== null }
}

/** Compact, worker-facing rendering of blocking findings for a fix round. */
export const renderFindingsForWorker = (findings: readonly ReviewFinding[], max = 15): string => findings.slice(0, max).map((finding, index) => `${index + 1}. [${finding.severity}] ${finding.file ?? 'general'}${finding.line ? `:${finding.line}` : ''} — ${finding.title}${finding.detail && finding.detail !== finding.title ? `\n   ${finding.detail.slice(0, 400)}` : ''}`).join('\n') + (findings.length > max ? `\n… ${findings.length - max} more in the PR review.` : '')

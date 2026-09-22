import { parseSince, readLoopEvents, type LoopEvent } from './retro.js'

export interface TimelineStep {
  readonly at: string
  readonly type: string
  /** Milliseconds since the previous step in this timeline; `null` on the first step. */
  readonly sinceLastMs: number | null
  readonly provider: string | null
  readonly model: string | null
  readonly durationMs: number | null
  readonly tokens: number | null
  readonly detail: string
}

export interface IssueTimelineProblem {
  readonly at: string
  readonly type: string
  readonly detail: string
}

export interface IssueTimelineReport {
  readonly issue: string
  readonly steps: readonly TimelineStep[]
  /** First step to last, in milliseconds; `null` when there are fewer than two steps to span. */
  readonly totalMs: number | null
  readonly totalTokens: number
  readonly totalCalls: number
  readonly problems: readonly IssueTimelineProblem[]
}

/**
 * Every event type that means friction rather than plain progress — a fix round, a cooldown, a circuit breaker,
 * a stuck or blocked terminal outcome. Pulled out from the full timeline so a reader can see what went wrong
 * without reading every row.
 */
const PROBLEM_TYPES: ReadonlySet<string> = new Set([
  'contract.failed', 'contract.escalated', 'plan.failed', 'plan.escalated',
  'worker.ci-round', 'worker.review-round', 'worker.conflict-round',
  'worker.blocked', 'worker.stuck', 'worker.failed', 'worker.dispatch-failed',
  'provider.cooldown', 'cost-guard.tripped', 'max-duration.tripped',
  'security.pii-detected', 'queue.claim-failed',
])

const tokensOf = (event: LoopEvent): number | null => {
  const total = event['totalTokens']
  if (typeof total === 'number' && Number.isFinite(total)) return total
  const input = event['inputTokens']
  const output = event['outputTokens']
  const sum = (typeof input === 'number' ? input : 0) + (typeof output === 'number' ? output : 0)
  return sum > 0 ? sum : null
}

const detailOf = (event: LoopEvent): string => {
  if (typeof event['reason'] === 'string') return event['reason']
  if (Array.isArray(event['reasons'])) return event['reasons'].join('; ')
  if (typeof event['error'] === 'string') return event['error']
  if (typeof event['status'] === 'string') return event['status']
  return event.type
}

/**
 * Every event the loop logged for one issue, oldest first, with the time and tokens spent between consecutive
 * steps — what a study comparing how different LLMs behaved on the same kind of task, or a human tuning the
 * harness, both need: which phase took the time, which one spent the tokens, and where it went wrong.
 */
export const buildIssueTimeline = (stateDir: string, issue: string, options: { readonly since?: string; readonly now?: Date } = {}): IssueTimelineReport => {
  // windowed: this used to call readLoopEvents(stateDir) with no bound, parsing events.ndjson plus every rotated
  // events-archive-*.ndjson and filtering one issue out in memory — the only unbounded read left in the loop, and
  // one that got slower every week it ran. An issue's timeline lives inside its own dispatch, so a window that
  // covers the longest an issue plausibly stays in flight loses nothing and stops the growth.
  const now = options.now ?? new Date()
  const since = parseSince(options.since ?? '30d', now)
  const events = [...readLoopEvents(stateDir, since.getTime()).filter((event) => event['issue'] === issue)]
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  const steps: TimelineStep[] = []
  let previousAtMs: number | null = null
  let totalTokens = 0
  let totalCalls = 0
  for (const event of events) {
    const atMs = Date.parse(event.at)
    const tokens = tokensOf(event)
    if (tokens !== null) { totalTokens += tokens; totalCalls += 1 }
    steps.push({
      at: event.at,
      type: event.type,
      sinceLastMs: previousAtMs !== null && Number.isFinite(atMs) ? atMs - previousAtMs : null,
      provider: typeof event['provider'] === 'string' ? event['provider'] : null,
      model: typeof event['model'] === 'string' ? event['model'] : null,
      durationMs: typeof event['durationMs'] === 'number' ? event['durationMs'] : null,
      tokens,
      detail: detailOf(event),
    })
    if (Number.isFinite(atMs)) previousAtMs = atMs
  }
  const totalMs = steps.length >= 2 ? Date.parse(steps[steps.length - 1]!.at) - Date.parse(steps[0]!.at) : null
  const problems = events.filter((event) => PROBLEM_TYPES.has(event.type)).map((event) => ({ at: event.at, type: event.type, detail: detailOf(event) }))
  return { issue, steps, totalMs, totalTokens, totalCalls, problems }
}

export const renderIssueTimelineMarkdown = (report: IssueTimelineReport): string => {
  const lines: string[] = []
  lines.push(`# Timeline — ${report.issue}`, '')
  if (!report.steps.length) { lines.push('_No events logged for this issue yet._'); return lines.join('\n') }
  lines.push(`_${report.steps.length} step(s) · ${report.totalMs !== null ? `${Math.round(report.totalMs / 60_000)} min end to end` : 'span unknown'} · ${report.totalTokens} token(s) across ${report.totalCalls} call(s)_`, '')
  lines.push('| at | +since | type | provider/model | duration | tokens | detail |', '|---|---|---|---|---|---|---|')
  for (const step of report.steps) {
    const since = step.sinceLastMs !== null ? `${Math.round(step.sinceLastMs / 1000)}s` : '—'
    const providerModel = step.provider ? `${step.provider}${step.model ? `/${step.model}` : ''}` : '—'
    const duration = step.durationMs !== null ? `${Math.round(step.durationMs / 1000)}s` : '—'
    const tokens = step.tokens !== null ? String(step.tokens) : '—'
    lines.push(`| ${step.at.slice(0, 19)}Z | ${since} | \`${step.type}\` | ${providerModel} | ${duration} | ${tokens} | ${step.detail.replaceAll('\n', ' ').replaceAll('|', '\\|').slice(0, 140)} |`)
  }
  lines.push('')
  if (report.problems.length) {
    lines.push('## Problems', '')
    for (const problem of report.problems) lines.push(`- ${problem.at.slice(0, 19)}Z · \`${problem.type}\`: ${problem.detail.slice(0, 160)}`)
    lines.push('')
  }
  return lines.join('\n')
}

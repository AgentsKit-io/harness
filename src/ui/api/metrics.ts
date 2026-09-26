import { issueSpend } from '../../loop/budget.js'
import type { LoopConfig } from '../../loop/config.js'
import { readStoredContract } from '../../loop/contract.js'
import { normalizeReason, readLoopEvents, type LoopEvent } from '../../loop/retro.js'
import { readDispatchRecord } from '../../loop/tick.js'
import type { MetricsReport, MetricsWindow } from './contract.js'

/**
 * `GET /api/v1/metrics` read model. `buildMetrics` is pure over the events of the window plus the previous equal
 * window (the only history it needs, for `previousMedianMs` and for runs that started just before the window);
 * `loadMetrics` is the one place that touches disk, and it never reads the log without that bound (`windowed:`).
 */

const HOUR = 3_600_000
const DAY = 24 * HOUR
export const METRICS_WINDOWS: Readonly<Record<MetricsWindow, number>> = { '24h': DAY, '7d': 7 * DAY, '14d': 14 * DAY, '30d': 30 * DAY }
export const isMetricsWindow = (value: string): value is MetricsWindow => Object.hasOwn(METRICS_WINDOWS, value)

/** Terminal outcomes that count against throughput: a pass that failed, was abandoned, blocked, stuck or cancelled. */
const FAILED_TYPES = new Set(['worker.failed', 'worker.abandoned', 'worker.blocked', 'worker.stuck', 'worker.dispatch-failed', 'ui.cleanup-completed'])
const START_TYPES = new Set(['ui.run-enqueued', 'worker.dispatched'])
const FIX_ROUND_TYPES = new Set(['worker.ci-round', 'worker.review-round']) // a conflict round costs no fix round (event-vocabulary)
const STOP_TYPES = new Set(['worker.failed', 'worker.blocked', 'worker.stuck', 'worker.abandoned', 'worker.held', 'worker.needs-input', 'worker.dispatch-failed', 'issue.paused', 'cost-guard.tripped', 'max-duration.tripped', 'contract.failed'])
const CAP_REASON = /fix round|max(?:imum)? rounds|cap/i

export interface PerIssueSpend { readonly issue: string; readonly title: string | null; readonly tokens: number; readonly cap: number | null }
export interface MetricsInput {
  /** Events from `now - 2 × window` to `now`, any order. */
  readonly events: readonly LoopEvent[]
  /** Per-issue spend with its cap (`issueSpend`); derived from the window's own token events when omitted. */
  readonly perIssue?: readonly PerIssueSpend[]
}

const num = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0
const str = (value: unknown): string | null => typeof value === 'string' && value ? value : null
const quantile = (values: readonly number[], q: number): number | null => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  if (q === 0.5) { const mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2 }
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!
}

/** Tokens one event carries, the same arithmetic `issueSpend` uses: `totalTokens`, else input + output. */
export const eventTokens = (event: LoopEvent): { readonly total: number; readonly input: number; readonly output: number; readonly cached: number | null } => {
  const input = num(event['inputTokens'])
  const output = num(event['outputTokens'])
  const total = typeof event['totalTokens'] === 'number' && Number.isFinite(event['totalTokens']) ? event['totalTokens'] : input + output
  const cachedRaw = event['cacheReadTokens'] ?? event['cachedInputTokens'] ?? event['cachedTokens']
  return { total, input, output, cached: typeof cachedRaw === 'number' ? cachedRaw : null }
}
const roleOf = (event: LoopEvent): string => event.type === 'pr.reviewed' ? 'reviewer' : str(event['role']) ?? 'other'
const reasonsOf = (event: LoopEvent): readonly string[] => event.type === 'contract.escalated'
  ? (Array.isArray(event['reasons']) ? event['reasons'].map(String) : [])
  : [str(event['reason']) ?? str(event['error']) ?? event.type]

export const buildMetrics = (input: MetricsInput, window: MetricsWindow, now: Date): MetricsReport => {
  const span = METRICS_WINDOWS[window]
  const to = now.getTime()
  const from = to - span
  const prevFrom = from - span
  const size = window === '24h' ? HOUR : DAY
  const count = Math.round(span / size)
  const events = input.events
    .map((event) => ({ event, ms: Date.parse(event.at) }))
    .filter(({ ms }) => Number.isFinite(ms) && ms >= prevFrom && ms <= to)
    .sort((a, b) => a.ms - b.ms)
  const inWindow = events.filter(({ ms }) => ms >= from)
  const bucketOf = (ms: number): number => Math.min(count - 1, Math.floor((ms - from) / size))
  const bucketAt = (index: number): string => new Date(from + index * size).toISOString()

  // Throughput
  const merged = new Array<number>(count).fill(0)
  const failed = new Array<number>(count).fill(0)
  for (const { event, ms } of inWindow) {
    if (event.type === 'pr.merged') merged[bucketOf(ms)]! += 1
    else if (FAILED_TYPES.has(event.type)) failed[bucketOf(ms)]! += 1
  }

  // Per-merge facts: lead time (earliest queue/dispatch since the issue's previous merge), fix rounds, DoD at merge.
  interface Merge { readonly issue: string; readonly ms: number; readonly leadMs: number | null; readonly rounds: number; readonly dod: LoopEvent | null }
  const merges: Merge[] = []
  const lastMergeMs = new Map<string, number>()
  const byIssue = new Map<string, { ms: number; event: LoopEvent }[]>()
  for (const entry of events) {
    const issue = str(entry.event.issue)
    if (!issue) continue
    const list = byIssue.get(issue) ?? []
    list.push(entry)
    byIssue.set(issue, list)
    if (entry.event.type !== 'pr.merged') continue
    const since = lastMergeMs.get(issue) ?? -Infinity
    const attempt = list.filter(({ ms }) => ms > since && ms <= entry.ms)
    const start = attempt.find(({ event }) => START_TYPES.has(event.type))
    const dod = [...attempt].reverse().find(({ event }) => event.type === 'dod.assessed')?.event ?? null
    merges.push({ issue, ms: entry.ms, leadMs: start ? entry.ms - start.ms : null, rounds: attempt.filter(({ event }) => FIX_ROUND_TYPES.has(event.type)).length, dod })
    lastMergeMs.set(issue, entry.ms)
  }
  const current = merges.filter((merge) => merge.ms >= from)
  const leads = (list: readonly Merge[]): number[] => list.map((merge) => merge.leadMs).filter((value): value is number => value !== null)
  const leadSeries = Array.from({ length: count }, (_, index) => {
    const values = leads(current.filter((merge) => bucketOf(merge.ms) === index))
    return { at: bucketAt(index), medianMs: quantile(values, 0.5), p90Ms: quantile(values, 0.9) }
  })

  const roundLabels = ['0', '1', '2', '3+', 'cap']
  const rounds = new Map(roundLabels.map((label) => [label, 0]))
  for (const merge of current) { const label = merge.rounds >= 3 ? '3+' : String(merge.rounds); rounds.set(label, rounds.get(label)! + 1) }
  const capped = new Set(inWindow.filter(({ event }) => (event.type === 'worker.blocked' || event.type === 'github-intake.blocked') && CAP_REASON.test(String(event['reason'] ?? ''))).map(({ event }) => String(event.issue ?? event['pr'] ?? '?')))
  rounds.set('cap', capped.size)

  // First review per PR, counted when that first review is inside the window.
  const firstReview = new Map<string, { ms: number; clean: boolean }>()
  for (const { event, ms } of events) {
    if (event.type !== 'pr.reviewed') continue
    const key = `${String(event.issue ?? '')}#${String(event['pr'] ?? '')}`
    if (!firstReview.has(key)) firstReview.set(key, { ms, clean: event['status'] === 'clean' })
  }
  const firsts = [...firstReview.values()].filter((review) => review.ms >= from)

  // DoD lines at merge: proven, or merged without proof (waived); held = unproven lines on issues that ended held.
  let proven = 0, waived = 0, held = 0
  for (const merge of current) if (merge.dod) { proven += num(merge.dod['proven']); waived += num(merge.dod['missing']) + num(merge.dod['failed']) }
  for (const [, list] of byIssue) {
    const recent = list.filter(({ ms }) => ms >= from)
    const terminal = [...recent].reverse().find(({ event }) => event.type === 'worker.held' || event.type === 'pr.merged')
    if (terminal?.event.type !== 'worker.held') continue
    const dod = [...recent].reverse().find(({ event, ms }) => event.type === 'dod.assessed' && ms <= terminal.ms)?.event
    if (dod) held += num(dod['missing']) + num(dod['failed'])
  }

  const reasons = new Map<string, number>()
  for (const { event } of inWindow) {
    if (event.type !== 'contract.escalated' && !STOP_TYPES.has(event.type)) continue
    for (const reason of reasonsOf(event)) { const key = normalizeReason(reason); reasons.set(key, (reasons.get(key) ?? 0) + 1) }
  }

  // Tokens: every event that carries them (pr.reviewed, provider.call when its result was parsed).
  let total = 0, tokensIn = 0, tokensOut = 0, cachedTokens = 0, cachedInput = 0
  const byRole: Record<string, number> = {}
  const roleSeries = Array.from({ length: count }, (): Record<string, number> => ({}))
  const windowSpend = new Map<string, number>()
  for (const { event, ms } of inWindow) {
    const tokens = eventTokens(event)
    if (tokens.total <= 0) continue
    const role = roleOf(event)
    total += tokens.total; tokensIn += tokens.input; tokensOut += tokens.output
    if (tokens.cached !== null) { cachedTokens += tokens.cached; cachedInput += tokens.input }
    byRole[role] = (byRole[role] ?? 0) + tokens.total
    const bucket = roleSeries[bucketOf(ms)]!
    bucket[role] = (bucket[role] ?? 0) + tokens.total
    const issue = str(event.issue)
    if (issue) windowSpend.set(issue, (windowSpend.get(issue) ?? 0) + tokens.total)
  }
  const perIssue = input.perIssue ?? [...windowSpend.entries()].map(([issue, tokens]) => ({ issue, title: null, tokens, cap: null }))
  const mergedIssues = new Set(current.map((merge) => merge.issue))
  const spendOf = new Map(perIssue.map((row) => [row.issue, row.tokens]))

  // Providers: remaining-% series, projection on the stretch since the last window reset, cooldown still ahead.
  const providerRoles = new Map<string, Set<string>>()
  const addProvider = (provider: string | null, role?: string): void => { if (!provider) return; const set = providerRoles.get(provider) ?? new Set<string>(); if (role) set.add(role); providerRoles.set(provider, set) }
  const usage = new Map<string, { at: string; ms: number; remainingPercent: number }[]>()
  const cooldown = new Map<string, number>()
  for (const { event, ms } of inWindow) {
    const provider = str(event['provider'])
    if (event.type === 'provider.usage-observed' && provider && typeof event['currentRemainingPercent'] === 'number') {
      addProvider(provider, 'builder')
      usage.set(provider, [...(usage.get(provider) ?? []), { at: event.at, ms, remainingPercent: event['currentRemainingPercent'] }])
    } else if (event.type === 'provider.cooldown' && provider) {
      addProvider(provider)
      const until = Date.parse(String(event['until'] ?? ''))
      if (Number.isFinite(until)) cooldown.set(provider, Math.max(cooldown.get(provider) ?? 0, until))
    } else if (event.type === 'provider.call') addProvider(provider, str(event['role']) ?? undefined)
    else if (event.type === 'pr.reviewed') addProvider(provider, 'reviewer')
  }
  const providers = [...providerRoles.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([provider, roles]) => {
    const points = usage.get(provider) ?? []
    let reset = 0
    for (let index = 1; index < points.length; index += 1) if (points[index]!.remainingPercent > points[index - 1]!.remainingPercent + 5) reset = index
    const tail = points.slice(reset)
    const first = tail[0]
    const last = tail[tail.length - 1]
    let projectedZeroAt: string | null = null
    if (first && last && last.ms > first.ms && last.remainingPercent < first.remainingPercent) {
      const slope = (last.remainingPercent - first.remainingPercent) / (last.ms - first.ms)
      projectedZeroAt = new Date(last.ms - last.remainingPercent / slope).toISOString()
    }
    const until = cooldown.get(provider)
    return {
      provider, roles: [...roles].sort(),
      remainingPercent: last?.remainingPercent ?? null,
      series: points.map(({ at, remainingPercent }) => ({ at, remainingPercent })),
      projectedZeroAt,
      cooldownUntil: until !== undefined && until > to ? new Date(until).toISOString() : null,
    }
  })

  const sparks = { merged: new Array<number>(12).fill(0), failed: new Array<number>(12).fill(0), tokens: new Array<number>(12).fill(0) }
  for (const { event, ms } of inWindow) {
    if (ms < to - DAY) continue
    const index = Math.min(11, Math.floor((ms - (to - DAY)) / (2 * HOUR)))
    if (event.type === 'pr.merged') sparks.merged[index]! += 1
    else if (FAILED_TYPES.has(event.type)) sparks.failed[index]! += 1
    sparks.tokens[index]! += eventTokens(event).total
  }

  return {
    window, from: new Date(from).toISOString(), to: now.toISOString(), bucket: window === '24h' ? 'hour' : 'day',
    throughput: merged.map((value, index) => ({ at: bucketAt(index), merged: value, failed: failed[index]! })),
    leadTime: {
      medianMs: quantile(leads(current), 0.5),
      p90Ms: quantile(leads(current), 0.9),
      previousMedianMs: quantile(leads(merges.filter((merge) => merge.ms < from)), 0.5),
      series: leadSeries,
    },
    fixRounds: roundLabels.map((label) => ({ label, count: rounds.get(label)! })),
    firstReviewApprovalRate: firsts.length ? firsts.filter((review) => review.clean).length / firsts.length : null,
    criteriaAtMerge: { proven, waived, held },
    stopReasons: [...reasons.entries()].map(([reason, n]) => ({ reason, count: n })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)).slice(0, 12),
    tokens: {
      total, input: tokensIn, output: tokensOut,
      cacheHitRate: cachedInput > 0 ? cachedTokens / cachedInput : null,
      medianPerMergedIssue: quantile([...mergedIssues].map((issue) => spendOf.get(issue) ?? windowSpend.get(issue) ?? 0), 0.5),
      byRole,
      series: roleSeries.map((roles, index) => ({ at: bucketAt(index), byRole: roles })),
      perIssue: [...perIssue].sort((a, b) => b.tokens - a.tokens),
    },
    providers,
    memorySavedChars: inWindow.reduce((sum, { event }) => sum + (event.type === 'memory.recalled' ? num(event['approxCharsSaved']) : 0), 0),
    sparks,
    totals: {
      merged: merged.reduce((a, b) => a + b, 0),
      failed: failed.reduce((a, b) => a + b, 0),
      escalated: inWindow.filter(({ event }) => event.type === 'contract.escalated').length,
    },
  }
}

/** How many issues get an exact `issueSpend` (each is its own dispatch-bounded read); the rest keep window spend. */
const PER_ISSUE_LIMIT = 20

/** Disk side: the window plus the previous equal window, never more (`windowed:`). */
export const loadMetrics = (stateDir: string, config: Pick<LoopConfig, 'budget'>, window: MetricsWindow, now = new Date()): MetricsReport => {
  const sinceMs = now.getTime() - 2 * METRICS_WINDOWS[window]
  const events = readLoopEvents(stateDir, sinceMs)
  const draft = buildMetrics({ events }, window, now)
  const perIssue = draft.tokens.perIssue.slice(0, PER_ISSUE_LIMIT).map((row): PerIssueSpend => {
    const dispatch = readDispatchRecord(stateDir, row.issue)
    const cap = dispatch?.frozenPerIssueTokens ?? config.budget.perIssueTokens
    // ponytail: issueSpend without a dispatch record reads the whole log; keep the window's own spend instead.
    const tokens = dispatch?.dispatchedAt ? issueSpend(stateDir, row.issue).totalTokens : row.tokens
    return { issue: row.issue, title: readStoredContract(stateDir, row.issue)?.contract.intent ?? null, tokens, cap: cap > 0 ? cap : null }
  })
  return buildMetrics({ events, perIssue }, window, now)
}

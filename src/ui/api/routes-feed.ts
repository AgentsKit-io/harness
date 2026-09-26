import { readStoredContract } from '../../loop/contract.js'
import type { LoopEvent } from '../../loop/retro.js'
import type { CachedContract, RecentEvent } from './contract.js'
import { createEventTail } from './extras.js'
import { SAFE_IDENTIFIER, sendJson } from './http.js'
import type { RouteModule } from './routes.js'

const DAY_MS = 86_400_000
const SUMMARY_FIELDS = ['reason', 'status', 'error', 'round', 'pr', 'head', 'provider', 'model', 'stage', 'operation'] as const

/** One line out of an event's typed fields, in a fixed order; never the whole payload. */
export const summarizeEvent = (event: LoopEvent): string => SUMMARY_FIELDS
  .flatMap((key) => { const value = event[key]; return typeof value === 'string' || typeof value === 'number' ? [key === 'pr' ? `#${value}` : key === 'head' ? String(value).slice(0, 7) : key === 'round' ? `round ${value}` : String(value)] : [] })
  .join(' · ').slice(0, 200)

export const recentEvents = (events: readonly LoopEvent[], now: Date, limit: number): readonly RecentEvent[] => {
  const since = now.getTime() - DAY_MS
  return events.filter((event) => Date.parse(event.at) >= since).slice(-limit).reverse()
    .map((event) => ({ at: event.at, type: event.type, issue: typeof event.issue === 'string' ? event.issue : null, summary: summarizeEvent(event) }))
}

const tails = new Map<string, ReturnType<typeof createEventTail>>()

/** `GET /api/v1/events/recent` (home event stream) and `GET /api/v1/contracts` (New batch "contract cached"). */
export const feedRoutes: RouteModule = async (context, request, response, url) => {
  if (request.method !== 'GET') return false
  const { stateDir, config } = context.loaded
  if (url.pathname === '/api/v1/events/recent') {
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 30) || 30))
    // windowed: the tail re-reads the log only when it changes, and never more than its own 7-day window.
    const tail = tails.get(stateDir) ?? createEventTail(stateDir)
    tails.set(stateDir, tail)
    const now = new Date()
    sendJson(response, 200, { events: recentEvents(tail(now), now, limit) })
    return true
  }
  if (url.pathname === '/api/v1/contracts') {
    const issues = (url.searchParams.get('issues') ?? '').split(',').map((value) => value.trim()).filter(Boolean)
    if (issues.length > 100 || issues.some((issue) => !SAFE_IDENTIFIER.test(issue) || issue.includes('..'))) { sendJson(response, 400, { error: 'invalid_issues' }); return true }
    const reuseMs = (config.contract?.reuseHours ?? 0) * 3_600_000
    const now = Date.now()
    const contracts: Record<string, CachedContract> = {}
    for (const issue of issues) {
      const stored = readStoredContract(stateDir, issue)
      if (stored) contracts[issue] = { digest: stored.digest, generatedAt: stored.generatedAt, fresh: now - Date.parse(stored.generatedAt) < reuseMs, dispatchable: stored.assessment?.dispatchable !== false }
    }
    sendJson(response, 200, { contracts })
    return true
  }
  return false
}

import type { SearchType } from './contract.js'
import { SAFE_IDENTIFIER, sendJson } from './http.js'
import { isMetricsWindow, loadMetrics } from './metrics.js'
import type { RouteModule } from './routes.js'
import { SEARCH_TYPES, search } from './search.js'

/** Insights: `GET /api/v1/metrics?window=` and `GET /api/v1/search?q=&types=&window=&issue=`. Read-only. */
export const insightsRoutes: RouteModule = async (context, request, response, url) => {
  if (request.method !== 'GET') return false
  const refuse = (error: string): true => { sendJson(response, 400, { error }); return true }
  if (url.pathname === '/api/v1/metrics') {
    const window = url.searchParams.get('window') ?? '7d'
    if (!isMetricsWindow(window)) return refuse(`window must be one of 24h, 7d, 14d, 30d (got ${window})`)
    sendJson(response, 200, loadMetrics(context.loaded.stateDir, context.loaded.config, window))
    return true
  }
  if (url.pathname === '/api/v1/search') {
    const query = (url.searchParams.get('q') ?? '').trim()
    if (query.length < 2) return refuse('q is required (at least 2 characters)')
    const window = url.searchParams.get('window') ?? '7d'
    if (!isMetricsWindow(window)) return refuse(`window must be one of 24h, 7d, 14d, 30d (got ${window})`)
    const types = (url.searchParams.get('types') ?? '').split(',').map((type) => type.trim()).filter(Boolean)
    const unknown = types.filter((type) => !SEARCH_TYPES.includes(type as SearchType))
    if (unknown.length) return refuse(`unknown search type(s): ${unknown.join(', ')}`)
    const issue = url.searchParams.get('issue')?.trim() || null
    if (issue && (!SAFE_IDENTIFIER.test(issue) || issue.includes('..') || issue.includes('/'))) return refuse('issue is not a valid identifier')
    sendJson(response, 200, search(context.loaded.stateDir, query, { types: types as SearchType[], window, issue, config: context.loaded.config }))
    return true
  }
  return false
}

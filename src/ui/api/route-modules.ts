import type { RouteModule } from './routes.js'
import { insightsRoutes } from './routes-insights.js'

/** Every `/api/v1/*` area beyond the built-ins in `server.ts`, tried in this order. One line per module. */
export const ROUTE_MODULES: readonly RouteModule[] = [
  insightsRoutes,
]

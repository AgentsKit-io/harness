import type { RouteModule } from './routes.js'
import { actionRoutes } from './routes-actions.js'
import { configRoutes } from './routes-config.js'
import { insightsRoutes } from './routes-insights.js'
import { systemRoutes } from './routes-system.js'

/** Every `/api/v1/*` area beyond the built-ins in `server.ts`, tried in this order. One line per module. */
export const ROUTE_MODULES: readonly RouteModule[] = [
  actionRoutes,
  systemRoutes,
  insightsRoutes,
  configRoutes,
]

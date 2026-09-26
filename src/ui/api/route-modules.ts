import type { RouteModule } from './routes.js'
import { actionRoutes } from './routes-actions.js'
import { configRoutes } from './routes-config.js'
import { coreRoutes } from './routes-core.js'
import { feedRoutes } from './routes-feed.js'
import { insightsRoutes } from './routes-insights.js'
import { systemRoutes } from './routes-system.js'

/** Every `/api/v1/*` area beyond the built-ins in `server.ts`, tried in this order. One line per module. */
export const ROUTE_MODULES: readonly RouteModule[] = [
  coreRoutes,
  feedRoutes,
  actionRoutes,
  systemRoutes,
  insightsRoutes,
  configRoutes,
]

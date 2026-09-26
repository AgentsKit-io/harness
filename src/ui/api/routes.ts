import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ActionContext } from './actions.js'
import type { IssueBoardCache } from './board.js'
import type { UiJobManager } from './jobs.js'
import type { UiSnapshot } from './server.js'

/**
 * A route module owns one area of `/api/v1/*` (metrics, search, config, …). `server.ts` tries each module, in
 * `ROUTE_MODULES` order, after auth and after its own built-in routes; a module returns `true` once it has
 * answered. A thrown error becomes a 400 with the message. Modules hold no state of their own beyond caches:
 * every write goes through a kernel function (`src/loop/*`) or `actions.ts`.
 */
export interface RouteContext extends ActionContext {
  readonly board: IssueBoardCache
  readonly jobs: UiJobManager | null
  readonly snapshot: (force?: boolean) => UiSnapshot | Promise<UiSnapshot>
}

export type RouteModule = (context: RouteContext, request: IncomingMessage, response: ServerResponse, url: URL) => Promise<boolean>

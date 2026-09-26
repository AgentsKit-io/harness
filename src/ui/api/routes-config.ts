import { loadLoopConfig, type LoadedLoopConfig } from '../../loop/config.js'
import type { TuningRevertResult } from './contract.js'
import { readTuningState, setTuningFrozen } from '../../loop/tuning.js'
import { ConfigRefused, effectiveConfig, proposeTeamChange, writePersonalConfig } from './config-view.js'
import { readRequestBody, recordOf, sendJson, stringOf } from './http.js'
import type { RouteModule } from './routes.js'

/**
 * Swap the server's config for a fresh read, in place, so every holder of the object (action context, board,
 * route context) sees it. Runs queued after this use the new values; running runs keep their frozen snapshot.
 */
// ponytail: server.ts builds one context object and spreads it; mutating the shared LoadedLoopConfig avoids owning server.ts. A mutable holder there would be cleaner.
export const refreshLoaded = (loaded: LoadedLoopConfig, next: LoadedLoopConfig = loadLoopConfig(loaded.path)): void => {
  const target = loaded as unknown as Record<string, unknown>
  for (const key of Object.keys(target)) if (!(key in next)) Reflect.deleteProperty(target, key)
  Object.assign(target, next)
}

/** `GET /api/v1/config`, `PUT /api/v1/config/local`, `POST /api/v1/config/proposal`, `POST /api/v1/tuning/{revert,freeze,unfreeze}`. */
export const configRoutes: RouteModule = async (context, request, response, url) => {
  const { pathname } = url
  const { loaded } = context
  try {
    if (pathname === '/api/v1/config' && request.method === 'GET') { sendJson(response, 200, effectiveConfig(loaded)); return true }
    if (pathname === '/api/v1/config/local' && request.method === 'PUT') {
      refreshLoaded(loaded, writePersonalConfig(loaded, await readRequestBody(request)))
      sendJson(response, 200, effectiveConfig(loaded)); return true
    }
    if (pathname === '/api/v1/config/proposal' && request.method === 'POST') { sendJson(response, 200, proposeTeamChange(loaded, await readRequestBody(request))); return true }
    const tuning = /^\/api\/v1\/tuning\/(revert|freeze|unfreeze)$/.exec(pathname)
    if (tuning && request.method === 'POST') {
      const path = stringOf(recordOf(await readRequestBody(request))['path'])
      if (!path) { sendJson(response, 400, { error: 'path is required.' }); return true }
      if (tuning[1] === 'revert') {
        // The tuned value lives in the team file, which the UI never writes: freeze the knob so the tuner stops, and
        // hand back the undo as a team proposal to commit or open as a PR.
        const last = [...readTuningState(loaded.stateDir).history].reverse().find((record) => record.path === path)
        if (!last || last.status !== 'applied') { sendJson(response, 400, { error: `${path} has no applied tuning change to revert.` }); return true }
        setTuningFrozen(loaded.stateDir, path, true)
        const result: TuningRevertResult = { config: effectiveConfig(loaded), proposal: proposeTeamChange(loaded, { changes: [{ path, value: last.from }] }) }
        sendJson(response, 200, result); return true
      }
      setTuningFrozen(loaded.stateDir, path, tuning[1] === 'freeze')
      sendJson(response, 200, effectiveConfig(loaded)); return true
    }
    return false
  } catch (error) {
    if (error instanceof ConfigRefused) { sendJson(response, error.status, { error: error.message, paths: error.paths }); return true }
    throw error
  }
}

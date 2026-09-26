import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashJson } from '../../kernel/hash.js'
import { detectProviders } from '../../adapters/providers.js'
import { resolveConnectors } from '../../loop/connectors.js'
import { loadLoopConfig, parseModelRef, type LoadedLoopConfig, type ModelReference } from '../../loop/config.js'
import { contractIsFresh, readStoredContract, type StoredContract } from '../../loop/contract.js'
import { providerSpecs, runLoopDoctor } from '../../loop/doctor.js'
import { listDispatched, readDeliveryState } from '../../loop/deliver.js'
import { rankModels } from '../../loop/routing.js'
import { createProcessRunner } from '../../loop/process.js'
import { runTick } from '../../loop/tick.js'
import { readLoopEvents } from '../../loop/retro.js'
import type { CommandRunner } from '../../adapters/command.js'
import { createIssueBoardCache, createIssueBoardReader, type BoardSnapshot, type IssueBoardCache } from './board.js'
import { createUiWizardStore, parseUiWizardDraftPatch, type UiWizardStore } from './wizard.js'
import { createUiJobManager, type UiJobManager } from './jobs.js'
import { readCurrentProjection, syncProjection } from './store.js'
import { json, readRequestBody, recordOf, SAFE_IDENTIFIER, sendJson, sendText, stringOf } from './http.js'
import { ROUTE_MODULES } from './route-modules.js'
import type { RouteContext } from './routes.js'
import type { SnapshotExtras } from './contract.js'
import type { IssueRecord } from './projection.js'
import { installLoopAutomations } from '../../loop/install.js'
import {
  answerDecision, archiveRun, cancelRun, decideIssue, enqueueRun, generateOrReuseContract, resumePausedIssue,
  restoreRun, retryRun, type ActionContext,
} from './actions.js'

/**
 * The control plane's HTTP surface: `/api/v1/*` (thin — every handler here calls into `actions.ts`/`store.ts`,
 * no business logic lives in this file) plus serving the built frontend (or proxying its dev server). Auth,
 * loopback binding and the SSE poll loop are unchanged from the old `src/ui/server.ts` — none of that was ever
 * the source of the instability the rewrite was for.
 */

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 4321
const POLL_INTERVAL_MS = 1_000
const SESSION_HEADER = 'x-harness-session'

export const UI_SNAPSHOT_SCHEMA_VERSION = 1 as const

export interface UiSnapshot {
  readonly schemaVersion: typeof UI_SNAPSHOT_SCHEMA_VERSION
  readonly generatedAt: string
  readonly project: { readonly name: string; readonly repo: string; readonly baseBranch: string; readonly root: string; readonly stateDir: string; readonly configHash: string }
  readonly capacity: { readonly maxAgents: number; readonly running: number; readonly free: number }
  readonly board: BoardSnapshot | null
  readonly issues: readonly IssueRecord[]
  /** Attention, reconciliation and freshness — see `contract.ts`. Absent only from test snapshots. */
  readonly extras?: SnapshotExtras
}

export interface UiServerOptions {
  readonly configPath?: string
  readonly loaded?: LoadedLoopConfig
  readonly host?: string
  readonly port?: number
  /** Vite dev server origin (e.g. `http://127.0.0.1:5173`) — when set, every non-API request is proxied there
   * instead of served from `appDir`. Omit in production. */
  readonly devServerUrl?: string
  /** Directory of the built frontend (`vite build`'s output). Defaults to `./app` next to the compiled server
   * module, which is where the package's own build puts it. */
  readonly appDir?: string
  readonly board?: IssueBoardCache
  readonly jobs?: UiJobManager
  readonly wizard?: UiWizardStore
  /** Test seam: replaces the real snapshot builder. */
  readonly snapshot?: (force?: boolean) => UiSnapshot | Promise<UiSnapshot>
  /** Test seam: skip the fire-and-forget `installLoopAutomations` the server runs on startup. */
  readonly skipAutoInstall?: boolean
}

export interface UiServerHandle {
  readonly url: string
  readonly token: string
  readonly close: () => Promise<void>
}

const isLoopback = (host: string): boolean => host === '127.0.0.1' || host === 'localhost' || host === '::1'
const requestOrigin = (host: string, port: number): string => `http://${host === '::1' ? `[${host}]` : host}:${port}`
const sameLoopbackOrigin = (origin: string, expectedOrigin: string): boolean => {
  try {
    const actual = new URL(origin)
    const expected = new URL(expectedOrigin)
    return actual.protocol === expected.protocol && actual.port === expected.port && isLoopback(actual.hostname) && isLoopback(expected.hostname)
  } catch { return false }
}
const authorized = (request: IncomingMessage, token: string, expectedOrigin: string, url: URL): boolean => {
  const origin = request.headers.origin
  if (origin && origin !== expectedOrigin && !sameLoopbackOrigin(origin, expectedOrigin)) return false
  return request.headers[SESSION_HEADER] === token || url.searchParams.get('session') === token
}

// ---- static frontend / dev proxy -----------------------------------------------------------------------------

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
}

/** A static build has no per-request templating, so the session token — never in the URL, never fetchable by an
 * unauthenticated request (that would defeat the token entirely) — has to be injected into the one HTML
 * response every load starts from. `</head>` is the seam, chosen because it is present regardless of what else
 * `index.html` contains, both in the built file and in Vite's own dev-time transform of it. */
const injectSession = (html: string, token: string): string => html.replace('</head>', `<script>window.__HARNESS_SESSION__=${JSON.stringify(token)}</script></head>`)

/** Serves a built asset from `appDir`, falling back to `index.html` for any path that isn't a real file — the
 * client-side router owns every other route. Refuses to serve outside `appDir` (a `..` in the URL). */
const serveStatic = (appDir: string, pathname: string, token: string, response: ServerResponse): void => {
  const requested = normalize(join(appDir, decodeURIComponent(pathname)))
  const target = requested.startsWith(appDir + sep) && existsSync(requested) && statSync(requested).isFile() ? requested : join(appDir, 'index.html')
  if (!existsSync(target)) { sendJson(response, 503, { error: 'ui_not_built', detail: 'The frontend has not been built yet (`pnpm build`).' }); return }
  if (target.endsWith('index.html')) return sendText(response, 200, injectSession(readFileSync(target, 'utf8'), token))
  const body = readFileSync(target)
  response.writeHead(200, { 'content-type': MIME_TYPES[extname(target)] ?? 'application/octet-stream', 'cache-control': 'public, max-age=3600' })
  response.end(body)
}

/** Forwards a request to the Vite dev server. Every response is piped through untouched except an HTML one,
 * which is buffered just long enough to inject the session token the same way `serveStatic` does — the dev
 * server's own transform of `index.html` (its HMR client, etc.) still runs first, upstream, unaffected. */
const proxyToDevServer = (devServerUrl: string, token: string, request: IncomingMessage, response: ServerResponse): void => {
  const target = new URL(request.url ?? '/', devServerUrl)
  const proxied = httpRequest(target, { method: request.method, headers: { ...request.headers, host: target.host } }, (upstream) => {
    const isHtml = String(upstream.headers['content-type'] ?? '').includes('text/html')
    if (!isHtml) { response.writeHead(upstream.statusCode ?? 502, upstream.headers); upstream.pipe(response); return }
    const chunks: Buffer[] = []
    upstream.on('data', (chunk: Buffer) => chunks.push(chunk))
    upstream.on('end', () => sendText(response, upstream.statusCode ?? 200, injectSession(Buffer.concat(chunks).toString('utf8'), token)))
  })
  proxied.on('error', () => sendJson(response, 502, { error: 'dev_server_unreachable', detail: `Could not reach the Vite dev server at ${devServerUrl}.` }))
  request.pipe(proxied)
}

// ---- wizard data ------------------------------------------------------------------------------------------

const contractSummary = (stored: StoredContract): string => [
  `Intenção: ${stored.contract.intent}`,
  `Incluído: ${stored.contract.scope.inScope.join('; ')}`,
  ...(stored.contract.scope.outOfScope.length ? [`Fora do escopo: ${stored.contract.scope.outOfScope.join('; ')}`] : []),
  ...(stored.contract.outcomes.length ? [`Resultados verificáveis: ${stored.contract.outcomes.map((outcome) => `${outcome.id} — ${outcome.description}`).join('; ')}`] : []),
].join('\n')

const issueWizard = async (context: ActionContext, issue: string): Promise<Record<string, unknown>> => {
  const { loaded, runner } = context
  const tracker = resolveConnectors({ runner, config: loaded.config }).tracker
  const detail = await tracker.issue(issue)
  const availability = await detectProviders({ providers: providerSpecs(loaded.config), accountList: {}, agentHooks: {}, runner })
  const candidates = rankModels(loaded.config, 'builder', availability).map((candidate) => ({ provider: candidate.provider, model: candidate.model }))
  const cached = readStoredContract(loaded.stateDir, issue)
  const fresh = cached ? contractIsFresh(cached, detail, loaded.config.contract.reuseHours, new Date()) : false
  const contract = cached && fresh
    ? { status: cached.assessment?.dispatchable === false ? 'escalated' : 'valid', digest: cached.digest, summary: cached.assessment?.dispatchable === false ? cached.assessment.reasons.join('; ') : contractSummary(cached) }
    : cached
      ? { status: 'expired', digest: cached.digest, summary: 'O contrato existente expirou ou a issue mudou. Gere um novo contrato para continuar.' }
      : { status: 'missing', digest: null }
  const maxAgents = loaded.config.machine.ceiling ?? loaded.config.machine.floor
  const running = listDispatched(loaded.stateDir).filter((dispatch) => !readDeliveryState(loaded.stateDir, dispatch.issue).finishedAt).length
  const free = Math.max(0, maxAgents - running)
  const preflight = candidates.length > 0
    ? { status: 'passed', checkedAt: new Date().toISOString(), ...(free <= 0 ? { reason: 'Nenhum slot está livre agora; a execução será enfileirada.' } : {}) }
    : { status: 'blocked', checkedAt: new Date().toISOString(), reason: 'Nenhum modelo builder está roteável agora.' }
  return {
    issue: detail, configHash: loaded.configHash, contract, flows: Object.keys(loaded.config.flows.profiles), defaultFlow: loaded.config.flows.default ?? null,
    builderModels: candidates, limits: { maxFixRounds: loaded.config.delivery.maxFixRounds, perIssueTokens: loaded.config.budget.perIssueTokens },
    capacity: { maxAgents, running, free }, preflight,
  }
}

const modelReferenceFor = (value: unknown, loaded: LoadedLoopConfig): ModelReference => {
  const raw = stringOf(value)
  const configured = loaded.config.models.builder.flat().find((candidate) => candidate === raw && loaded.config.models.providers[candidate.slice(0, candidate.indexOf('/'))])
  if (!configured) throw new Error('O builder precisa ser um dos candidatos declarados e roteáveis.')
  return parseModelRef(configured)
}

interface EnqueueBody {
  readonly issue: string
  readonly configHash: string
  readonly flow: string | null
  readonly builder: ModelReference
  readonly contractDigest: string
  readonly maxFixRounds: number
  readonly perIssueTokens: number
}

const parseEnqueueBody = (body: unknown, loaded: LoadedLoopConfig): EnqueueBody => {
  const raw = recordOf(body)
  const issue = stringOf(raw['issue'])
  if (!issue || !SAFE_IDENTIFIER.test(issue)) throw new Error('É necessário um identificador de issue válido.')
  const configHash = stringOf(raw['configHash'])
  if (configHash && configHash !== loaded.configHash) throw new Error('A configuração do projeto mudou enquanto esta issue era configurada. Refaça o preflight.')
  const contractDigest = stringOf(raw['contractDigest'])
  if (!contractDigest) throw new Error('É necessário um contractDigest válido antes de confirmar.')
  if (raw['preflight'] !== true) throw new Error('É necessário um preflight aprovado antes de confirmar.')
  const flow = stringOf(raw['flow'])
  if (flow && !Object.prototype.hasOwnProperty.call(loaded.config.flows?.profiles ?? {}, flow)) throw new Error(`Flow desconhecido: ${flow}.`)
  const maxFixRounds = typeof raw['maxFixRounds'] === 'number' ? raw['maxFixRounds'] : loaded.config.delivery.maxFixRounds
  const perIssueTokens = typeof raw['perIssueTokens'] === 'number' ? raw['perIssueTokens'] : loaded.config.budget.perIssueTokens
  if (!Number.isInteger(maxFixRounds) || maxFixRounds < 0 || maxFixRounds > loaded.config.delivery.maxFixRounds) throw new Error(`maxFixRounds não pode passar do teto do projeto (${loaded.config.delivery.maxFixRounds}).`)
  if (!Number.isInteger(perIssueTokens) || perIssueTokens < 0 || (loaded.config.budget.perIssueTokens > 0 && perIssueTokens > loaded.config.budget.perIssueTokens)) throw new Error('perIssueTokens não pode passar do teto do projeto.')
  return { issue, configHash: loaded.configHash, flow, builder: modelReferenceFor(raw['builder'], loaded), contractDigest, maxFixRounds, perIssueTokens }
}

// ---- snapshot -----------------------------------------------------------------------------------------------

const buildSnapshot = async (context: ActionContext, board: IssueBoardCache, force = false): Promise<UiSnapshot> => {
  const { loaded } = context
  const projection = syncProjection(loaded.stateDir)
  const boardSnapshot = await board.read(force)
  const dispatches = listDispatched(loaded.stateDir)
  const running = dispatches.filter((dispatch) => !readDeliveryState(loaded.stateDir, dispatch.issue).finishedAt).length
  const maxAgents = loaded.config.machine.ceiling ?? loaded.config.machine.floor
  return {
    schemaVersion: UI_SNAPSHOT_SCHEMA_VERSION, generatedAt: new Date().toISOString(),
    project: { name: loaded.config.project.name, repo: loaded.config.project.repo, baseBranch: loaded.config.project.baseBranch, root: loaded.root, stateDir: loaded.stateDir, configHash: loaded.configHash },
    capacity: { maxAgents, running, free: Math.max(0, maxAgents - running) },
    board: boardSnapshot, issues: Object.values(projection.issues),
  }
}

/** Fire-and-forget: the wizard confirming a run should not wait out a whole tick before the page can navigate
 * to the run. Failure just leaves the issue queued for the next scheduled tick — never surfaced as an error
 * here, matching the old `startBestEffortTick`. */
const bestEffortTick = (loaded: LoadedLoopConfig, runner: CommandRunner, issue: string): void => {
  void runTick({ loaded, runner, onlyIssue: issue, maxDispatch: 1 }).catch(() => { /* the next scheduled tick retries */ })
}

// ---- server ---------------------------------------------------------------------------------------------------

const isApiRoute = (pathname: string): boolean => pathname.startsWith('/api/v1/')

export const startUiServer = async (options: UiServerOptions = {}): Promise<UiServerHandle> => {
  const host = options.host ?? DEFAULT_HOST
  const port = options.port ?? DEFAULT_PORT
  if (!isLoopback(host)) throw new Error('Harness UI only binds to loopback addresses.')
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('Harness UI port must be an integer between 0 and 65535.')
  const token = randomBytes(24).toString('hex')
  const runner = createProcessRunner()
  const loaded = options.loaded ?? (options.snapshot ? undefined : loadLoopConfig(options.configPath ?? 'loop.config.yaml'))
  const context: ActionContext | null = loaded ? { loaded, runner } : null
  const board = options.board ?? (loaded ? createIssueBoardCache({ loaded, reader: createIssueBoardReader({ loaded, runner }) }) : null)
  const jobs = options.jobs ?? (loaded ? createUiJobManager({ stateDir: loaded.stateDir }) : null)
  const wizard = options.wizard ?? (loaded ? createUiWizardStore(loaded.stateDir) : null)
  const appDir = options.appDir ?? fileURLToPath(new URL('./app', import.meta.url))
  const ownsJobs = options.jobs === undefined && jobs !== null

  const snapshot = options.snapshot ?? (async (force = false) => context && board ? buildSnapshot(context, board, force) : (() => { throw new Error('UI snapshot unavailable without a loaded config.') })())

  const routeContext: RouteContext | null = context && board ? { ...context, board, jobs, snapshot } : null
  const clients = new Set<ServerResponse>()
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `${host}:${port}`}`)
      if (!isApiRoute(url.pathname)) {
        if (options.devServerUrl) return proxyToDevServer(options.devServerUrl, token, request, response)
        return serveStatic(appDir, url.pathname, token, response)
      }
      const address = server.address()
      const boundPort = address && typeof address !== 'string' ? address.port : port
      if (!authorized(request, token, requestOrigin(host, boundPort), url)) return sendJson(response, 401, { error: 'unauthorized' })
      if (url.pathname === '/api/v1/health') return sendJson(response, 200, { status: 'ok', schemaVersion: UI_SNAPSHOT_SCHEMA_VERSION })
      if (url.pathname === '/api/v1/state') {
        try { return sendJson(response, 200, await snapshot(url.searchParams.get('refresh') === '1')) }
        catch (error) { return sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) }) }
      }

      if (url.pathname.startsWith('/api/v1/wizard/')) {
        if (!context || !wizard) return sendJson(response, 503, { error: 'wizard_unavailable' })
        const parts = url.pathname.split('/').filter(Boolean)
        const issue = parts[3] ? decodeURIComponent(parts[3]) : null
        const sub = parts[4]
        if (!issue || !SAFE_IDENTIFIER.test(issue)) return sendJson(response, 400, { error: 'invalid_issue' })
        try {
          if (request.method === 'GET' && !sub) return sendJson(response, 200, { ...(await issueWizard(context, issue)), draft: wizard.read(issue) })
          if (request.method === 'PUT' && !sub) return sendJson(response, 200, { draft: wizard.save(issue, parseUiWizardDraftPatch(await readRequestBody(request))) })
          if (request.method === 'POST' && sub === 'contract') {
            if (!jobs) return sendJson(response, 503, { error: 'contract_generation_unavailable' })
            const body = recordOf(await readRequestBody(request))
            const job = jobs.submit({
              kind: `contract:${issue}`, issue, actor: 'ui', reason: 'Preparar contrato no wizard',
              run: async ({ emit }) => { emit({ phase: 'generating', detail: 'Consultando o modelo orquestrador' }); return generateOrReuseContract(context, issue, { refresh: body['refresh'] === true }) },
            })
            return sendJson(response, 202, { job })
          }
        } catch (error) { return sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) }) }
        // unmatched here: fall through to the route modules
      }

      if (url.pathname === '/api/v1/runs' && request.method === 'POST') {
        if (!context) return sendJson(response, 503, { error: 'runs_unavailable' })
        try {
          const input = parseEnqueueBody(await readRequestBody(request), context.loaded)
          const { runId } = enqueueRun(context, { issue: input.issue, configHash: input.configHash, flow: input.flow, builder: input.builder, contractDigest: input.contractDigest, maxFixRounds: input.maxFixRounds, perIssueTokens: input.perIssueTokens })
          bestEffortTick(context.loaded, context.runner, input.issue)
          return sendJson(response, 202, { runId })
        } catch (error) { return sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) }) }
      }

      if (url.pathname.startsWith('/api/v1/issues/')) {
        if (!context) return sendJson(response, 503, { error: 'issues_unavailable' })
        const parts = url.pathname.split('/').filter(Boolean)
        const issue = parts[3] ? decodeURIComponent(parts[3]) : null
        const operation = parts[4]
        const sub = parts[5]
        if (!issue || !SAFE_IDENTIFIER.test(issue)) return sendJson(response, 400, { error: 'invalid_issue' })
        try {
          const record = readCurrentProjection(context.loaded.stateDir).issues[issue] ?? null
          if (request.method === 'GET' && operation === 'timeline') {
            if (!record) return sendJson(response, 404, { error: 'issue_not_found' })
            // windowed: the last 200 events for this one issue, newest first — not the whole log, and bounded
            // regardless of how long the issue has been open.
            const events = readLoopEvents(context.loaded.stateDir).filter((event) => event.issue === issue).sort((left, right) => Date.parse(right.at) - Date.parse(left.at)).slice(0, 200)
            return sendJson(response, 200, { events })
          }
          if (request.method === 'POST' && operation === 'cancel') {
            if (!record?.run) return sendJson(response, 404, { error: 'run_not_found' })
            await cancelRun(context, issue, record.run.id)
            return sendJson(response, 200, { issue })
          }
          if (request.method === 'POST' && operation === 'retry') {
            if (!record?.run) return sendJson(response, 404, { error: 'run_not_found' })
            retryRun(context, issue, record.run.id)
            bestEffortTick(context.loaded, context.runner, issue)
            return sendJson(response, 202, { issue })
          }
          if (request.method === 'POST' && operation === 'archive') {
            if (!record?.run) return sendJson(response, 404, { error: 'run_not_found' })
            archiveRun(context, record.run.id)
            return sendJson(response, 200, { issue })
          }
          if (request.method === 'POST' && operation === 'restore') {
            if (!record?.run) return sendJson(response, 404, { error: 'run_not_found' })
            restoreRun(context, record.run.id)
            return sendJson(response, 200, { issue })
          }
          if (request.method === 'POST' && operation === 'decision') {
            const body = recordOf(await readRequestBody(request))
            const action = stringOf(body['action'])
            if (action !== 'close-issue' && action !== 'reopen') return sendJson(response, 400, { error: 'invalid_decision' })
            await decideIssue(context, issue, action)
            return sendJson(response, 200, { issue })
          }
          if (request.method === 'POST' && operation === 'resume') {
            await resumePausedIssue(context, issue)
            bestEffortTick(context.loaded, context.runner, issue)
            return sendJson(response, 200, { issue })
          }
          if (operation === 'decisions' && sub && request.method === 'POST' && parts[6] === 'answer') {
            const body = recordOf(await readRequestBody(request))
            const optionId = stringOf(body['optionId'])
            const actor = stringOf(body['actor']) ?? 'ui'
            const expectedDigest = stringOf(body['expectedDigest'])
            if (!optionId || !expectedDigest) return sendJson(response, 400, { error: 'hitl_answer_incomplete' })
            const result = answerDecision(context, issue, expectedDigest, { requestId: decodeURIComponent(sub), optionId, actor, ...(typeof body['freeText'] === 'string' ? { freeText: body['freeText'] } : {}) })
            if (result.batchReady) { const resumesDelivery = result.stage !== null && ['review', 'worker'].includes(result.stage); if (resumesDelivery || result.stage === 'contract' || result.stage === 'plan') bestEffortTick(context.loaded, context.runner, issue) }
            return sendJson(response, 200, { issue, ...result })
          }
        } catch (error) { return sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) }) }
        // unmatched here: fall through to the route modules
      }

      if (url.pathname.startsWith('/api/v1/jobs/')) {
        const parts = url.pathname.split('/').filter(Boolean)
        const id = parts[3]
        const operation = parts[4]
        if (!id || !jobs) return sendJson(response, 404, { error: 'job_not_found' })
        if (request.method === 'GET' && !operation) { const job = jobs.get(id); return job ? sendJson(response, 200, { job }) : sendJson(response, 404, { error: 'job_not_found' }) }
        if (request.method === 'POST' && operation === 'cancel') return sendJson(response, 200, jobs.cancel(id))
        // unmatched here: fall through to the route modules
      }
      if (url.pathname === '/api/v1/jobs' && request.method === 'GET') return sendJson(response, 200, { jobs: jobs?.list() ?? [] })

      if (url.pathname === '/api/v1/events') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' })
        clients.add(response)
        request.on('close', () => clients.delete(response))
        try { response.write(`event: snapshot\ndata: ${json(await snapshot())}\n\n`) }
        catch (error) { response.write(`event: error\ndata: ${json({ error: error instanceof Error ? error.message : String(error) })}\n\n`) }
        return
      }
      if (routeContext) {
        for (const route of ROUTE_MODULES) {
          try { if (await route(routeContext, request, response, url)) return }
          catch (error) { return sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) }) }
        }
      }
      return sendJson(response, 404, { error: 'not_found' })
    })().catch(() => { try { response.destroy() } catch { /* client disconnected */ } })
  })

  const boundPort = await new Promise<number>((resolve, reject) => {
    const onError = (error: Error): void => { server.off('error', onError); reject(error) }
    server.once('error', onError)
    server.listen(port, host, () => {
      server.off('error', onError)
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('Harness UI did not receive a TCP address.'))
      resolve(address.port)
    })
  })
  const expectedUrl = `${requestOrigin(host, boundPort)}/`
  let previousDigest = ''
  let timerInFlight = false
  const timer = setInterval(() => {
    if (timerInFlight) return
    timerInFlight = true
    void (async () => {
      try {
        const current = await snapshot()
        const digest = hashJson(current)
        if (digest === previousDigest) return
        previousDigest = digest
        const message = `event: snapshot\ndata: ${json(current)}\n\n`
        for (const client of clients) { try { client.write(message) } catch { clients.delete(client) } }
      } catch (error) {
        const message = `event: error\ndata: ${json({ error: error instanceof Error ? error.message : String(error) })}\n\n`
        for (const client of clients) { try { client.write(message) } catch { clients.delete(client) } }
      } finally { timerInFlight = false }
    })()
  }, POLL_INTERVAL_MS)
  timer.unref()

  // UI-first: opening the control plane is enough to keep this config's tick and deliver running. Multi-project
  // setups (one Orca, many `loop.config.yaml`s) need every config to own its own automations by name, otherwise
  // a second `ak-harness ui` overwrites the first's `<prefix>-tick`/`<prefix>-deliver`. The install is idempotent
  // (`installLoopAutomations` reconciles drift) and runs fire-and-forget: a failed Orca call never blocks the UI.
  // Test seam: `options.skipAutoInstall` keeps the suite deterministic.
  if (loaded && options.skipAutoInstall !== true) {
    void installLoopAutomations({ loaded, runner }).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error)
      // eslint-disable-next-line no-console -- surface the bootstrap failure to the operator's terminal
      console.warn(`ak-harness ui: failed to bootstrap delivery for ${loaded.path}: ${detail}`)
    })
  }

  return {
    url: expectedUrl,
    token,
    close: async () => {
      clearInterval(timer)
      if (ownsJobs) jobs?.close()
      for (const client of clients) client.end()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    },
  }
}

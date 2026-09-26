import { cpus, freemem, loadavg } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { orcaAutomationsList } from '../../adapters/orca-cli.js'
import { detectProviders } from '../../adapters/providers.js'
import { readJsonFile } from '../../kernel/json-file.js'
import { automationSpecs, MANAGED_STAGES, reconcileAutomations, type AutomationDriftRow } from '../../loop/automations.js'
import { activeCooldowns, readCooldowns } from '../../loop/cooldown.js'
import { providerSpecs, runLoopDoctor, type LoopDoctorReport } from '../../loop/doctor.js'
import { writeJsonAtomic } from '../../loop/fs-atomic.js'
import { installLoopAutomations, loopStatus, type AutomationStatus } from '../../loop/install.js'
import { readLearningsLedger } from '../../loop/memory.js'
import { stageEntry, type LoopStageName } from '../../loop/resilience-state.js'
import { buildRetroReport, readLoopEvents } from '../../loop/retro.js'
import { routeAllRoles } from '../../loop/routing.js'
import type { ActionContext } from './actions.js'
import type { CheckStatus, SystemReport } from './contract.js'
import { sendJson } from './http.js'
import type { RouteModule } from './routes.js'
import { humanActor } from './routes-actions.js'

/**
 * `GET /system` is a read model: it never runs doctor (only reads the last report `POST /system/doctor` saved), makes
 * no provider call, and hits Orca at most once a minute (automation status/drift) — the retro digest is rebuilt at
 * most every ten minutes, offline. `POST /system/doctor` and `/automations/reinstall` are the only writes here.
 */

export const doctorReportPath = (stateDir: string): string => join(stateDir, 'ui', 'doctor.json')
export const alertsStatePath = (stateDir: string): string => join(stateDir, 'ui', 'alerts-state.json')

const ORCA_TTL_MS = 60_000
const RETRO_TTL_MS = 10 * 60_000
const MAX_LEARNINGS = 100
const DAY_MS = 24 * 60 * 60_000

const CHECK_STATUS = { passed: 'pass', warning: 'warn', failed: 'fail' } as const satisfies Record<string, CheckStatus>
const doctorSchema = z.object({ ranAt: z.string(), checks: z.array(z.object({ name: z.string(), status: z.enum(['pass', 'warn', 'fail']), detail: z.string() })) }).loose()
const alertsSchema = z.object({ lastDelivery: z.object({ at: z.string(), status: z.union([z.number(), z.literal('error')]) }).nullable().optional() }).loose()

export const summarizeDoctor = (report: LoopDoctorReport): NonNullable<SystemReport['doctor']> & { readonly status: LoopDoctorReport['status'] } => ({
  ranAt: report.generatedAt, status: report.status,
  checks: report.checks.map((check) => ({ name: check.id, status: CHECK_STATUS[check.status], detail: check.detail })),
})

export interface SystemRouteDeps {
  readonly doctor: typeof runLoopDoctor
  readonly install: typeof installLoopAutomations
  readonly now: () => Date
}

interface OrcaStages { readonly statuses: readonly AutomationStatus[]; readonly rows: readonly AutomationDriftRow[] }

/** Status (last run) and drift both come from Orca; a failure reads as "nothing known", never as an error page. */
const readOrcaStages = async ({ loaded, runner }: ActionContext): Promise<OrcaStages> => {
  try {
    const status = await loopStatus({ loaded, runner })
    const existing = await orcaAutomationsList(runner, { bin: loaded.config.orca.bin, timeoutMs: loaded.config.orca.timeoutMs })
    // Empty provider: drift on a field the UI did not resolve would be invented (see `automationDrift`).
    return { statuses: status.automations, rows: reconcileAutomations(automationSpecs(loaded, ''), existing, loaded.config) }
  } catch { return { statuses: [], rows: [] } }
}

/** A tiny per-state-dir TTL cache; the in-flight promise is cached too, so concurrent GETs share one Orca read. */
const ttlCache = <T>(ttlMs: number, now: () => Date) => {
  const entries = new Map<string, { readonly at: number; readonly value: Promise<T> }>()
  return {
    get: (key: string, load: () => Promise<T>): Promise<T> => {
      const hit = entries.get(key)
      if (hit && now().getTime() - hit.at < ttlMs) return hit.value
      const value = load()
      entries.set(key, { at: now().getTime(), value })
      return value
    },
    clear: (key: string): void => { entries.delete(key) },
  }
}

export const createSystemRoutes = (deps: SystemRouteDeps = { doctor: runLoopDoctor, install: installLoopAutomations, now: () => new Date() }): RouteModule => {
  const orca = ttlCache<OrcaStages>(ORCA_TTL_MS, deps.now)
  const retro = ttlCache<SystemReport['retroSuggestions']>(RETRO_TTL_MS, deps.now)

  const systemReport = async (context: ActionContext): Promise<SystemReport> => {
    const { loaded } = context
    const { config, stateDir } = loaded
    const now = deps.now()
    const cooldownState = readCooldowns(stateDir)
    const availability = await detectProviders({ providers: providerSpecs(config), accountList: {}, agentHooks: {}, exhaustedPercent: config.models.cooldown.exhaustedPercent, cooldowns: activeCooldowns(cooldownState, now), now: () => now })
    const routing = Object.values(routeAllRoles(config, availability)).map((decision) => ({
      role: decision.role,
      model: decision.selected ? `${decision.selected.provider}/${decision.selected.model}` : null,
      reason: decision.selected?.reason ?? `no available provider (${decision.skipped.length} skipped)`,
    }))
    const orcaStages = await orca.get(stateDir, () => readOrcaStages(context))
    const specs = automationSpecs(loaded, '')
    const stages = MANAGED_STAGES.map((stage) => {
      const status = orcaStages.statuses.find((item) => item.stage === stage)
      const row = orcaStages.rows.find((item) => item.stage === stage)
      const pause = stage === 'tick' || stage === 'deliver' ? stageEntry(stateDir, stage as LoopStageName) : null
      return {
        stage, schedule: status?.trigger ?? specs.find((spec) => spec.name === row?.name)?.trigger ?? null,
        lastRunAt: status?.lastRun?.at ?? null, lastStatus: status?.lastRun?.status ?? null,
        paused: Boolean(pause?.pausedAt), pausedReason: pause?.pausedReason ?? null,
        installed: status?.installed ?? false,
        drift: row?.state === 'drifted' ? row.fields : row?.state === 'undeclared' ? ['undeclared'] : [],
      }
    })
    const statusRank = { proposed: 0, promoted: 1, rejected: 2 } as const
    const learnings = [...readLearningsLedger(stateDir).records]
      .sort((left, right) => statusRank[left.status] - statusRank[right.status] || (right.sightings ?? 1) - (left.sightings ?? 1))
      .slice(0, MAX_LEARNINGS)
      .map((record) => ({ id: record.id, category: record.category, text: record.text, sightings: record.sightings ?? 1, source: record.source, status: record.status }))
    // windowed: only the last 24h of events are counted.
    const since = now.getTime() - DAY_MS
    const handoffs = readLoopEvents(stateDir, since).filter((event) => event.type === 'worker.handed-off' && Date.parse(event.at) >= since).length
    const retroSuggestions = await retro.get(stateDir, () => buildRetroReport({ loaded, since: '7d', skipOrca: true, now: () => now })
      .then((report) => report.suggestions.map((item) => ({ text: item.text, knob: item.knob ?? null, target: item.target })))
      .catch(() => []))
    const cpuCount = cpus().length || 1
    const alerts = (config as { readonly alerts?: { readonly webhook?: unknown } }).alerts
    return {
      doctor: (() => { const saved = readJsonFile(doctorReportPath(stateDir), doctorSchema); return saved ? { ranAt: saved.ranAt, checks: saved.checks } : null })(),
      machine: { loadPercent: process.platform === 'win32' ? null : Math.round(((loadavg()[0] ?? 0) / cpuCount) * 100), freeRamGb: Math.round((freemem() / 1024 ** 3) * 10) / 10, liveTerminals: null, slots: config.machine.ceiling ?? config.machine.floor },
      routing,
      cooldowns: Object.entries(cooldownState).filter(([, entry]) => Date.parse(entry.until) > now.getTime()).map(([provider, entry]) => ({ provider, until: entry.until, reason: entry.reason })),
      handoffs, stages, learnings, retroSuggestions,
      alerts: { configured: Boolean(alerts?.webhook), lastDelivery: readJsonFile(alertsStatePath(stateDir), alertsSchema)?.lastDelivery ?? null },
    }
  }

  return async (context, request, response, url) => {
    const { loaded, runner } = context
    if (url.pathname === '/api/v1/system' && request.method === 'GET') { sendJson(response, 200, await systemReport(context)); return true }
    if (url.pathname === '/api/v1/system/doctor' && request.method === 'POST') {
      if (!context.jobs) { sendJson(response, 503, { error: 'jobs_unavailable' }); return true }
      const job = context.jobs.submit({
        kind: 'doctor', issue: null, actor: humanActor(loaded), reason: 'Run doctor',
        run: async ({ emit }) => {
          emit({ phase: 'checking', detail: 'Running loop doctor' })
          const summary = summarizeDoctor(await deps.doctor({ loaded, runner }))
          writeJsonAtomic(doctorReportPath(loaded.stateDir), summary)
          return summary
        },
      })
      sendJson(response, 202, { job })
      return true
    }
    if (url.pathname === '/api/v1/automations/reinstall' && request.method === 'POST') {
      const report = await deps.install({ loaded, runner })
      orca.clear(loaded.stateDir)
      sendJson(response, 200, report)
      return true
    }
    return false
  }
}

export const systemRoutes: RouteModule = createSystemRoutes()

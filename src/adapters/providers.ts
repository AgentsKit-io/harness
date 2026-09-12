import { findExecutable, type CommandRunner } from './command.js'

export type UsageWindowKind = 'session' | 'weekly' | 'monthly' | string

export interface UsageWindow {
  readonly kind: UsageWindowKind
  readonly usedPercent: number
  readonly windowMinutes: number | null
  readonly resetsAt: string | null
}

export interface ProviderUsage {
  /** `ok` when Orca reported live usage, `unavailable` when Orca could not, `unknown` when Orca did not mention the provider. */
  readonly status: 'ok' | 'unavailable' | 'unknown'
  readonly error: string | null
  readonly windows: readonly UsageWindow[]
  readonly exhausted: boolean
  /** Earliest reset among exhausted windows, ISO-8601. */
  readonly resetsAt: string | null
  readonly hasAuth: boolean | null
}

export type ProviderAuthStatus = 'ok' | 'unknown' | 'missing'

export interface ProviderAvailability {
  readonly id: string
  readonly binary: string | null
  readonly hookState: 'installed' | 'not_installed' | 'unknown'
  readonly auth: ProviderAuthStatus
  readonly usage: ProviderUsage
  readonly probe: 'passed' | 'failed' | 'skipped'
  readonly coolingDownUntil: string | null
  readonly available: boolean
  readonly reasons: readonly string[]
}

export interface ProviderSpec {
  readonly id: string
  readonly bin: string
  readonly auth: 'subscription' | 'api-key' | 'none'
  readonly envKeys: readonly string[]
  readonly orcaUsageKey: string
  readonly probe?: readonly string[]
}

export interface DetectProvidersInput {
  readonly providers: readonly ProviderSpec[]
  readonly accountList: unknown
  readonly agentHooks: Readonly<Record<string, 'installed' | 'not_installed' | 'unknown'>>
  readonly env?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
  readonly exhaustedPercent?: number
  readonly cooldowns?: Readonly<Record<string, string>>
  readonly now?: () => Date
  readonly runner?: CommandRunner
  readonly probeTimeoutMs?: number
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const iso = (value: unknown): string | null => typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null

export const parseUsageWindows = (entry: unknown): readonly UsageWindow[] => {
  if (!isRecord(entry)) return []
  return Object.entries(entry).flatMap(([kind, value]) => {
    if (!isRecord(value) || typeof value['usedPercent'] !== 'number') return []
    return [{ kind, usedPercent: value['usedPercent'] as number, windowMinutes: typeof value['windowMinutes'] === 'number' ? value['windowMinutes'] as number : null, resetsAt: iso(value['resetsAt']) }]
  })
}

/** Read one provider's usage out of `orca account list --json` → `result`. */
export const parseProviderUsage = (accountList: unknown, usageKey: string, exhaustedPercent = 100): ProviderUsage => {
  const result = isRecord(accountList) ? accountList : {}
  const rateLimits = isRecord(result['rateLimits']) ? result['rateLimits'] : {}
  const entry = isRecord(rateLimits[usageKey]) ? rateLimits[usageKey] : null
  const account = isRecord(result[usageKey]) ? result[usageKey] : null
  const systemDefault = account && isRecord(account['systemDefault']) ? account['systemDefault'] : null
  const accounts = account && Array.isArray(account['accounts']) ? account['accounts'] : []
  const hasAuth = systemDefault ? systemDefault['hasAuth'] === true : accounts.length ? true : null
  if (!entry) return { status: 'unknown', error: null, windows: [], exhausted: false, resetsAt: null, hasAuth }
  const windows = parseUsageWindows(entry)
  const exhaustedWindows = windows.filter((window) => window.usedPercent >= exhaustedPercent)
  const resetsAt = exhaustedWindows.map((window) => window.resetsAt).filter((value): value is string => Boolean(value)).sort()[0] ?? null
  return {
    status: entry['status'] === 'ok' ? 'ok' : entry['status'] === 'unavailable' ? 'unavailable' : 'unknown',
    error: typeof entry['error'] === 'string' ? entry['error'] : null,
    windows,
    exhausted: exhaustedWindows.length > 0,
    resetsAt,
    hasAuth,
  }
}

export const authStatusFor = (spec: ProviderSpec, usage: ProviderUsage, env: NodeJS.ProcessEnv): ProviderAuthStatus => {
  const hasEnvKey = spec.envKeys.some((key) => Boolean(env[key]?.trim()))
  if (spec.auth === 'api-key') return hasEnvKey ? 'ok' : 'missing'
  // Subscription CLIs Orca does not track (e.g. grok) authenticate through their own login; the binary being present is the best signal we have.
  if (spec.auth === 'subscription') return usage.hasAuth === true || usage.status === 'ok' ? 'ok' : usage.hasAuth === false ? 'missing' : hasEnvKey || usage.status === 'unknown' ? 'ok' : 'unknown'
  return hasEnvKey || usage.status === 'ok' ? 'ok' : 'unknown'
}

const runProbe = async (spec: ProviderSpec, binary: string, runner: CommandRunner | undefined, timeoutMs: number): Promise<'passed' | 'failed' | 'skipped'> => {
  if (!spec.probe || !runner) return 'skipped'
  const [head, ...rest] = spec.probe
  const argv = [head === spec.bin ? binary : head ?? binary, ...rest]
  try { const outcome = await runner.run(argv, { timeoutMs }); return outcome.code === 0 && !outcome.timedOut ? 'passed' : 'failed' } catch { return 'failed' }
}

/** Detect which coding-agent CLIs can take work right now. Pure over its inputs except the optional probe. */
export const detectProviders = async (input: DetectProvidersInput): Promise<readonly ProviderAvailability[]> => {
  const env = input.env ?? process.env
  const platform = input.platform ?? process.platform
  const now = input.now ?? (() => new Date())
  const results: ProviderAvailability[] = []
  for (const spec of input.providers) {
    const binary = findExecutable(spec.bin, env, platform)
    const hookState = input.agentHooks[spec.id] ?? 'unknown'
    const usage = parseProviderUsage(input.accountList, spec.orcaUsageKey, input.exhaustedPercent ?? 100)
    const auth = authStatusFor(spec, usage, env)
    const cooldown = input.cooldowns?.[spec.id] ?? null
    const coolingDownUntil = cooldown && Date.parse(cooldown) > now().getTime() ? new Date(cooldown).toISOString() : null
    const reasons: string[] = []
    if (!binary) reasons.push(`binary "${spec.bin}" not found on PATH`)
    if (auth === 'missing') reasons.push(spec.auth === 'api-key' ? `none of ${spec.envKeys.join(', ') || 'the configured env keys'} is set` : `Orca reports no ${spec.id} credentials`)
    if (usage.exhausted) reasons.push(`usage exhausted${usage.resetsAt ? ` until ${usage.resetsAt}` : ''}`)
    if (coolingDownUntil) reasons.push(`cooling down until ${coolingDownUntil}`)
    const probe = binary && !reasons.length ? await runProbe(spec, binary, input.runner, input.probeTimeoutMs ?? 15_000) : 'skipped'
    if (probe === 'failed') reasons.push('probe command failed')
    results.push({ id: spec.id, binary, hookState, auth, usage, probe, coolingDownUntil, available: reasons.length === 0, reasons })
  }
  return results
}

/** Exponential cooldown: initial × 2^attempts, capped. Returns the ISO instant the provider may be retried. */
export const cooldownUntil = (attempt: number, initialMin: number, maxMin: number, from: Date, resetsAt: string | null = null): string => {
  const minutes = Math.min(maxMin, initialMin * 2 ** Math.max(0, attempt))
  const backoff = from.getTime() + minutes * 60_000
  const reset = resetsAt ? Date.parse(resetsAt) : Number.NaN
  return new Date(Number.isFinite(reset) && reset > from.getTime() ? Math.max(reset, backoff) : backoff).toISOString()
}

export type UsageMetric = 'max' | 'session' | 'weekly' | 'monthly'

/** Remaining capacity 0–100 from usage windows, or null when unknown. `max` = most constrained window. */
export const remainingUsagePercent = (usage: ProviderUsage, metric: UsageMetric = 'max'): number | null => {
  if (usage.status !== 'ok' || !usage.windows.length) return null
  const windows = metric === 'max' ? usage.windows : usage.windows.filter((window) => window.kind === metric)
  const pool = windows.length ? windows : usage.windows
  if (!pool.length) return null
  const worst = Math.max(...pool.map((window) => window.usedPercent))
  return Math.max(0, Math.min(100, 100 - worst))
}

/** Sort key for usage-aware ranking: higher remaining first; known before unknown when preferKnownUsage. */
export const usageRankTuple = (
  usage: ProviderUsage,
  metric: UsageMetric,
  preferKnownUsage: boolean,
): readonly [number, number, number] => {
  const remaining = remainingUsagePercent(usage, metric)
  const known = remaining === null ? 1 : 0
  const remainingKey = remaining === null ? 0 : -remaining
  const resetMs = usage.resetsAt ? Date.parse(usage.resetsAt) : Number.POSITIVE_INFINITY
  return preferKnownUsage ? [known, remainingKey, resetMs] : [remainingKey, known, resetMs]
}

/** Orca rateLimit / account keys that are not provider ids. */
const ORCA_META_KEYS = new Set([
  'minimaxCookieConfigured', 'minimaxApiKeyConfigured', 'grokAuthConfigured',
  'claudeTarget', 'codexTarget', 'inactiveClaudeAccounts', 'inactiveCodexAccounts',
])

/** Map Orca account/rateLimit key → loop provider id via configured orcaUsageKey (and identity). */
export const listOrcaIntegratedProviderKeys = (accountList: unknown): readonly string[] => {
  const result = isRecord(accountList) ? accountList : {}
  const rateLimits = isRecord(result['rateLimits']) ? result['rateLimits'] : {}
  const keys = new Set<string>()
  for (const key of Object.keys(rateLimits)) {
    if (!ORCA_META_KEYS.has(key) && isRecord(rateLimits[key])) keys.add(key)
  }
  for (const key of Object.keys(result)) {
    if (key === 'rateLimits' || ORCA_META_KEYS.has(key)) continue
    if (isRecord(result[key])) keys.add(key)
  }
  return [...keys].sort()
}

/** Warn when Orca shows an integration that has no `models.providers` entry. */
export const undeclaredOrcaProviders = (
  accountList: unknown,
  declared: Readonly<Record<string, { readonly orcaUsageKey?: string }>>,
): readonly string[] => {
  const usageKeyToId = new Map<string, string>()
  for (const [id, settings] of Object.entries(declared)) {
    usageKeyToId.set(settings.orcaUsageKey ?? id, id)
    usageKeyToId.set(id, id)
  }
  // common Orca aliases
  usageKeyToId.set('opencodeGo', usageKeyToId.get('opencodeGo') ?? 'opencode')
  return listOrcaIntegratedProviderKeys(accountList).filter((key) => !usageKeyToId.has(key))
}

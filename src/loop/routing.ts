import { MODEL_ROLES, type ModelRole } from '../kernel/model-policy.js'
import type { ProviderAvailability } from '../adapters/providers.js'
import { remainingUsagePercent, usageRankTuple } from '../adapters/providers.js'
import { parseModelRef, providerIdentity, renderTuiCommand, tiersFor, type EffortLevel, type LoopConfig, type ModelReference } from './config.js'

export interface RoutingSkip { readonly tier: number; readonly ref: ModelReference; readonly reasons: readonly string[] }

export interface RankedModel extends ModelReference {
  readonly tier: number
  readonly orcaAgent: string
  readonly tui: string
  readonly remainingPercent: number | null
  readonly reason: string
  readonly preferenceIndex: number
  /** Reasoning effort requested for this role (`models.effort.<role>`); only takes effect on providers with `effortFlag` set. */
  readonly effort: EffortLevel
}

export interface RoutingDecision {
  readonly role: ModelRole
  readonly selected: RankedModel | null
  readonly skipped: readonly RoutingSkip[]
}

const allowedProvider = (config: LoopConfig, providerId: string): boolean => {
  const { excludeProviders, includeProviders } = config.models.routing
  if (excludeProviders.includes(providerId)) return false
  if (includeProviders.length && !includeProviders.includes(providerId)) return false
  return true
}

const materialize = (
  config: LoopConfig,
  role: ModelRole,
  ref: ModelReference,
  tier: number,
  preferenceIndex: number,
  availability: ProviderAvailability | undefined,
  reason: string,
): RankedModel => {
  const identity = providerIdentity(config, ref.provider)
  const effort = config.models.effort[role]
  return {
    ...ref,
    tier,
    preferenceIndex,
    orcaAgent: identity.orcaAgent,
    tui: renderTuiCommand(identity.settings, ref.model, effort),
    remainingPercent: availability ? remainingUsagePercent(availability.usage, config.models.routing.usageMetric) : null,
    reason,
    effort,
  }
}

const compareUsageAware = (config: LoopConfig, left: RankedModel, right: RankedModel, byId: Map<string, ProviderAvailability>): number => {
  const leftAv = byId.get(left.provider)
  const rightAv = byId.get(right.provider)
  const leftTuple = leftAv
    ? usageRankTuple(leftAv.usage, config.models.routing.usageMetric, config.models.routing.preferKnownUsage)
    : ([1, 0, Number.POSITIVE_INFINITY] as const)
  const rightTuple = rightAv
    ? usageRankTuple(rightAv.usage, config.models.routing.usageMetric, config.models.routing.preferKnownUsage)
    : ([1, 0, Number.POSITIVE_INFINITY] as const)
  for (let i = 0; i < leftTuple.length; i += 1) {
    if (leftTuple[i] !== rightTuple[i]) return leftTuple[i]! - rightTuple[i]!
  }
  if (left.preferenceIndex !== right.preferenceIndex) return left.preferenceIndex - right.preferenceIndex
  return left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model)
}

/** Collect YAML tier candidates that are currently available. */
const availableFromTiers = (
  config: LoopConfig,
  role: ModelRole,
  availability: readonly ProviderAvailability[],
): { readonly ranked: RankedModel[]; readonly skipped: RoutingSkip[] } => {
  const byId = new Map(availability.map((item) => [item.id, item]))
  const skipped: RoutingSkip[] = []
  const ranked: RankedModel[] = []
  let preferenceIndex = 0
  for (const [tier, refs] of tiersFor(config, role).entries()) {
    for (const ref of refs) {
      const index = preferenceIndex
      preferenceIndex += 1
      if (!allowedProvider(config, ref.provider)) {
        skipped.push({ tier, ref, reasons: ['provider excluded by models.routing'] })
        continue
      }
      const provider = byId.get(ref.provider)
      if (provider?.available) {
        ranked.push(materialize(config, role, ref, tier, index, provider, `yaml tier ${tier + 1}`))
      } else {
        skipped.push({ tier, ref, reasons: provider ? provider.reasons : ['provider was not detected'] })
      }
    }
  }
  return { ranked, skipped }
}

const applyPin = (
  config: LoopConfig,
  role: ModelRole,
  availability: readonly ProviderAvailability[],
  skipped: RoutingSkip[],
): RankedModel | null => {
  const pin = config.models.routing.pin[role]
  if (!pin) return null
  const ref = parseModelRef(pin)
  const byId = new Map(availability.map((item) => [item.id, item]))
  const provider = byId.get(ref.provider)
  if (provider?.available && allowedProvider(config, ref.provider)) {
    return materialize(config, role, ref, -1, -1, provider, `pinned ${pin}`)
  }
  skipped.push({ tier: -1, ref, reasons: provider ? provider.reasons : ['pinned provider was not detected'] })
  if (config.models.routing.pinStrict) return null
  return null
}

/**
 * Walk the role's candidates according to `models.routing.mode`.
 * - tiers: declaration order (0.6 behaviour)
 * - hybrid: keep tier bands; within a tier pick highest remaining usage
 * - dynamic: flatten all YAML candidates; sort by remaining usage
 * - catalog: same as dynamic over YAML seeds for now; catalog enrichment is applied by `rankModels` callers that pass extra refs via `extraCandidates`
 */
export const selectModel = (
  config: LoopConfig,
  role: ModelRole,
  availability: readonly ProviderAvailability[],
  extraCandidates: readonly ModelReference[] = [],
): RoutingDecision => {
  const byId = new Map(availability.map((item) => [item.id, item]))
  const mode = config.models.routing.mode
  const { ranked: fromYaml, skipped } = availableFromTiers(config, role, availability)

  if (config.models.routing.pin[role]) {
    const pinned = applyPin(config, role, availability, skipped)
    if (pinned) return { role, selected: pinned, skipped }
    if (config.models.routing.pinStrict) return { role, selected: null, skipped }
  }

  const extras: RankedModel[] = []
  let extraIndex = 10_000
  for (const ref of extraCandidates) {
    if (!allowedProvider(config, ref.provider)) continue
    const provider = byId.get(ref.provider)
    if (!provider?.available) continue
    extras.push(materialize(config, role, ref, 99, extraIndex, provider, 'catalog'))
    extraIndex += 1
  }

  if (mode === 'tiers') {
    const first = fromYaml[0] ?? extras[0] ?? null
    return { role, selected: first ?? null, skipped }
  }

  if (mode === 'hybrid') {
    const byTier = new Map<number, RankedModel[]>()
    for (const item of fromYaml) {
      const list = byTier.get(item.tier) ?? []
      list.push(item)
      byTier.set(item.tier, list)
    }
    const tiers = [...byTier.keys()].sort((a, b) => a - b)
    for (const tier of tiers) {
      const pool = byTier.get(tier) ?? []
      pool.sort((left, right) => compareUsageAware(config, left, right, byId))
      if (pool[0]) {
        return {
          role,
          selected: {
            ...pool[0],
            reason: `hybrid tier ${tier + 1} · remaining ${pool[0].remainingPercent ?? 'unknown'}%`,
          },
          skipped,
        }
      }
    }
    if (extras.length) {
      extras.sort((left, right) => compareUsageAware(config, left, right, byId))
      return { role, selected: { ...extras[0]!, reason: `hybrid catalog · remaining ${extras[0]!.remainingPercent ?? 'unknown'}%` }, skipped }
    }
    return { role, selected: null, skipped }
  }

  // dynamic + catalog: flatten and usage-rank
  const pool = [...fromYaml, ...extras]
  pool.sort((left, right) => compareUsageAware(config, left, right, byId))
  const best = pool[0] ?? null
  return {
    role,
    selected: best
      ? { ...best, reason: `${mode} · remaining ${best.remainingPercent ?? 'unknown'}% · ${best.reason}` }
      : null,
    skipped,
  }
}

export const routeAllRoles = (
  config: LoopConfig,
  availability: readonly ProviderAvailability[],
  extrasByRole: Partial<Record<ModelRole, readonly ModelReference[]>> = {},
): Readonly<Record<ModelRole, RoutingDecision>> =>
  Object.fromEntries(MODEL_ROLES.map((role) => [role, selectModel(config, role, availability, extrasByRole[role] ?? [])])) as Record<ModelRole, RoutingDecision>

/** Every available candidate for a role in preference / usage order. */
export const rankModels = (
  config: LoopConfig,
  role: ModelRole,
  availability: readonly ProviderAvailability[],
  extraCandidates: readonly ModelReference[] = [],
): readonly RankedModel[] => {
  const byId = new Map(availability.map((item) => [item.id, item]))
  const { ranked } = availableFromTiers(config, role, availability)
  const extras: RankedModel[] = []
  let extraIndex = 10_000
  for (const ref of extraCandidates) {
    if (!allowedProvider(config, ref.provider)) continue
    const provider = byId.get(ref.provider)
    if (!provider?.available) continue
    extras.push(materialize(config, role, ref, 99, extraIndex, provider, 'catalog'))
    extraIndex += 1
  }
  const mode = config.models.routing.mode
  if (mode === 'tiers') return [...ranked, ...extras]
  if (mode === 'hybrid') {
    const byTier = new Map<number, RankedModel[]>()
    for (const item of ranked) {
      const list = byTier.get(item.tier) ?? []
      list.push(item)
      byTier.set(item.tier, list)
    }
    const ordered: RankedModel[] = []
    for (const tier of [...byTier.keys()].sort((a, b) => a - b)) {
      const pool = byTier.get(tier) ?? []
      pool.sort((left, right) => compareUsageAware(config, left, right, byId))
      ordered.push(...pool)
    }
    extras.sort((left, right) => compareUsageAware(config, left, right, byId))
    return [...ordered, ...extras]
  }
  const pool = [...ranked, ...extras]
  pool.sort((left, right) => compareUsageAware(config, left, right, byId))
  return pool
}

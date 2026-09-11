import { MODEL_ROLES, type ModelRole } from '../kernel/model-policy.js'
import type { ProviderAvailability } from '../adapters/providers.js'
import { providerIdentity, renderTuiCommand, tiersFor, type LoopConfig, type ModelReference } from './config.js'

export interface RoutingSkip { readonly tier: number; readonly ref: ModelReference; readonly reasons: readonly string[] }

export interface RoutingDecision {
  readonly role: ModelRole
  readonly selected: (ModelReference & { readonly tier: number; readonly orcaAgent: string; readonly tui: string }) | null
  readonly skipped: readonly RoutingSkip[]
}

/** Walk the role's tiers in order; inside a tier keep declaration order; first available provider wins. */
export const selectModel = (config: LoopConfig, role: ModelRole, availability: readonly ProviderAvailability[]): RoutingDecision => {
  const byId = new Map(availability.map((item) => [item.id, item]))
  const skipped: RoutingSkip[] = []
  for (const [tier, refs] of tiersFor(config, role).entries()) {
    for (const ref of refs) {
      const provider = byId.get(ref.provider)
      if (provider?.available) {
        const identity = providerIdentity(config, ref.provider)
        return { role, selected: { ...ref, tier, orcaAgent: identity.orcaAgent, tui: renderTuiCommand(identity.settings, ref.model) }, skipped }
      }
      skipped.push({ tier, ref, reasons: provider ? provider.reasons : ['provider was not detected'] })
    }
  }
  return { role, selected: null, skipped }
}

export const routeAllRoles = (config: LoopConfig, availability: readonly ProviderAvailability[]): Readonly<Record<ModelRole, RoutingDecision>> => Object.fromEntries(MODEL_ROLES.map((role) => [role, selectModel(config, role, availability)])) as Record<ModelRole, RoutingDecision>

export interface RankedModel extends ModelReference { readonly tier: number; readonly orcaAgent: string; readonly tui: string }

/** Every available candidate for a role in preference order (tier, then declaration order). */
export const rankModels = (config: LoopConfig, role: ModelRole, availability: readonly ProviderAvailability[]): readonly RankedModel[] => {
  const byId = new Map(availability.map((item) => [item.id, item]))
  return tiersFor(config, role).flatMap((refs, tier) => refs.filter((ref) => byId.get(ref.provider)?.available).map((ref) => { const identity = providerIdentity(config, ref.provider); return { ...ref, tier, orcaAgent: identity.orcaAgent, tui: renderTuiCommand(identity.settings, ref.model) } }))
}

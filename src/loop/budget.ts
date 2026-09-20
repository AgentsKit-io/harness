import type { ProviderAvailability } from '../adapters/providers.js'
import { remainingUsagePercent } from '../adapters/providers.js'
import type { LoopConfig } from './config.js'
import { readLoopEvents } from './retro.js'
import type { RankedModel } from './routing.js'

/**
 * Providers the loop may still use under `budget.perProvider`.
 *
 * The budget leaves the rest of the window for the human who shares the plan: at `perProvider: 80` the loop stops
 * at 80% used and the last fifth stays theirs. A provider whose usage is unknown is left alone — refusing to work
 * because a number is missing would be worse than the problem.
 */
export const withinProviderBudget = (config: LoopConfig, availability: readonly ProviderAvailability[]): readonly ProviderAvailability[] => {
  const budget = config.budget.perProvider
  if (budget >= 100) return availability
  return availability.map((provider) => {
    const remaining = remainingUsagePercent(provider.usage, config.models.routing.usageMetric)
    if (remaining === null) return provider
    const used = 100 - remaining
    if (used < budget) return provider
    return { ...provider, available: false, reasons: [...provider.reasons, `budget.perProvider: ${used.toFixed(0)}% of the window used, ceiling ${budget}%`] }
  })
}

const costOf = (config: LoopConfig, model: RankedModel): number | null => {
  const declared = config.models.cost[`${model.provider}/${model.model}`]
  return typeof declared === 'number' ? declared : null
}

/**
 * Order the candidates a role already allows. Policy never widens the set — an unavailable or excluded provider
 * stays out — it only decides which of the allowed ones is tried first.
 */
export const applyRoutingPolicy = (config: LoopConfig, candidates: readonly RankedModel[]): readonly RankedModel[] => {
  const policy = config.models.routing.policy
  if (policy === 'quality-first' || candidates.length < 2) return candidates
  const sorted = [...candidates]
  if (policy === 'usage-balanced') {
    // Most remaining window first; unknown usage sorts last so a measured provider is preferred to a guess.
    sorted.sort((left, right) => (right.remainingPercent ?? -1) - (left.remainingPercent ?? -1) || left.preferenceIndex - right.preferenceIndex)
    return sorted.map((model) => ({ ...model, reason: `${model.reason} · usage-balanced (${model.remainingPercent ?? 'unknown'}% left)` }))
  }
  // cost-first: declared cost when the project declared one, otherwise the last tier — which is where a config
  // already keeps its cheap last resort. Saying which of the two decided is the difference between a policy and
  // a coin flip.
  const declared = candidates.some((model) => costOf(config, model) !== null)
  sorted.sort((left, right) => {
    if (declared) {
      const leftCost = costOf(config, left) ?? Number.POSITIVE_INFINITY
      const rightCost = costOf(config, right) ?? Number.POSITIVE_INFINITY
      if (leftCost !== rightCost) return leftCost - rightCost
    } else if (left.tier !== right.tier) return right.tier - left.tier
    return left.preferenceIndex - right.preferenceIndex
  })
  return sorted.map((model) => ({ ...model, reason: `${model.reason} · cost-first (${declared ? `cost ${costOf(config, model) ?? 'undeclared'}` : `tier ${model.tier + 1}`})` }))
}

export interface IssueSpend { readonly issue: string; readonly totalTokens: number; readonly calls: number }

/** What the loop has already spent on one issue, from the durable event log. */
export const issueSpend = (stateDir: string, issue: string): IssueSpend => {
  const events = readLoopEvents(stateDir).filter((event) => event['issue'] === issue)
  let totalTokens = 0
  let calls = 0
  for (const event of events) {
    const total = event['totalTokens']
    const input = event['inputTokens']
    const output = event['outputTokens']
    const sum = typeof total === 'number' && Number.isFinite(total) ? total : (typeof input === 'number' ? input : 0) + (typeof output === 'number' ? output : 0)
    if (sum > 0) { totalTokens += sum; calls += 1 }
  }
  return { issue, totalTokens, calls }
}

export interface BudgetVerdict { readonly exceeded: boolean; readonly spent: number; readonly ceiling: number; readonly reason: string | null }

/**
 * Whether one issue has spent its ceiling. Exceeding it is an escalation, never a retry with less headroom: an
* item that has already cost more than it was worth does not get cheaper by being attempted again.
 */
export const issueBudget = (config: LoopConfig, stateDir: string, issue: string): BudgetVerdict => {
  const ceiling = config.budget.perIssueTokens
  const { totalTokens } = issueSpend(stateDir, issue)
  if (ceiling <= 0) return { exceeded: false, spent: totalTokens, ceiling: 0, reason: null }
  return totalTokens >= ceiling
    ? { exceeded: true, spent: totalTokens, ceiling, reason: `budget.perIssueTokens: ${totalTokens} of ${ceiling} tokens spent on ${issue}` }
    : { exceeded: false, spent: totalTokens, ceiling, reason: null }
}

/**
 * Pick the reviewer tier from the size and shape of the change (cost lever 3).
 *
 * A docs-only or tiny diff does not need the frontier model; a large one, or one touching a path the project
 * called critical, does. Returns the candidate to use, never an empty result — a cheap model is still a model.
 */
export const modelForChange = (input: {
  readonly candidates: readonly RankedModel[]
  readonly files: readonly string[]
  readonly changedLines: number
  readonly smallChangeLines: number
  readonly criticalPaths: readonly string[]
}): { readonly model: RankedModel | null; readonly reason: string } => {
  const [strongest] = input.candidates
  if (!strongest) return { model: null, reason: 'no candidate available' }
  const critical = input.files.some((file) => input.criticalPaths.some((pattern) => file.startsWith(pattern.replace(/\*+$/, ''))))
  if (critical) return { model: strongest, reason: `critical path touched (${input.criticalPaths.join(', ')})` }
  const docsOnly = input.files.length > 0 && input.files.every((file) => /\.(md|mdx|txt)$/i.test(file))
  const small = input.changedLines > 0 && input.changedLines <= input.smallChangeLines
  if (!docsOnly && !small) return { model: strongest, reason: `${input.changedLines} changed line(s)` }
  const cheapest = [...input.candidates].sort((left, right) => right.tier - left.tier || right.preferenceIndex - left.preferenceIndex)[0] ?? strongest
  return { model: cheapest, reason: docsOnly ? 'documentation-only change' : `small change (${input.changedLines} ≤ ${input.smallChangeLines} lines)` }
}

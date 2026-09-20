import { resolveReviewSettings, type EffectiveReviewSettings, type LoopConfig } from './config.js'

export type FlowProfile = LoopConfig['flows']['profiles'][string]

/** What picked this flow, so a costlier gate can always say why it cost more. */
export type FlowSource = 'label' | 'flow-label' | 'project' | 'priority' | 'default' | 'none'

export interface ResolvedFlow {
  readonly name: string | null
  readonly source: FlowSource
  readonly matched: string | null
  readonly profile: FlowProfile | null
}

export interface FlowIssue {
  readonly labels?: readonly string[]
  readonly project?: string | null
  readonly priorityLabel?: string | null
}

const FLOW_LABEL_PREFIX = 'flow:'

/**
 * Pick the flow for one issue.
 *
 * Precedence is by kind, not by position in the list: an explicit `flow:<name>` label first, then a rule matching a
 * label, then the project, then the priority, then `flows.default`. A label is somebody stating an intention; a
 * priority is a signal, and a signal must never outrank a statement.
 */
export const resolveFlow = (config: LoopConfig, issue: FlowIssue = {}): ResolvedFlow => {
  const { profiles, select } = config.flows
  const labels = issue.labels ?? []
  const found = (name: string, source: FlowSource, matched: string | null): ResolvedFlow => ({ name, source, matched, profile: profiles[name] ?? null })

  const explicit = labels.find((label) => label.startsWith(FLOW_LABEL_PREFIX) && profiles[label.slice(FLOW_LABEL_PREFIX.length)])
  if (explicit) return found(explicit.slice(FLOW_LABEL_PREFIX.length), 'flow-label', explicit)

  for (const rule of select) {
    const matched = rule.anyLabels.find((label) => labels.includes(label))
    if (matched !== undefined) return found(rule.flow, 'label', matched)
  }
  const project = issue.project ?? null
  if (project) for (const rule of select) if (rule.projects.includes(project)) return found(rule.flow, 'project', project)
  const priority = issue.priorityLabel ?? null
  if (priority) for (const rule of select) if (rule.priorities.includes(priority)) return found(rule.flow, 'priority', priority)

  const fallback = config.flows.default
  if (fallback) return found(fallback, 'default', null)
  return { name: null, source: 'none', matched: null, profile: null }
}

export interface EffectiveFlowSettings {
  readonly flow: ResolvedFlow
  readonly review: EffectiveReviewSettings
  readonly merge: LoopConfig['delivery']['merge']
  readonly maxFixRounds: number
}

/**
 * The delivery settings in force for one issue: the project's, with the label `reviewOverrides` applied first and
 * the flow profile on top. Only the fields a layer names are replaced — a flow that raises `votes` must not
 * silently reset the deadline, the merge method or the CLI.
 */
export const resolveFlowSettings = (config: LoopConfig, issue: FlowIssue = {}): EffectiveFlowSettings => {
  const flow = resolveFlow(config, issue)
  const review = resolveReviewSettings(config, issue.labels ?? [])
  const profile = flow.profile
  if (!profile) return { flow, review, merge: config.delivery.merge, maxFixRounds: config.delivery.maxFixRounds }
  return {
    flow,
    review: { ...review, ...(profile.review ?? {}) },
    merge: { ...config.delivery.merge, ...(profile.merge ?? {}) },
    maxFixRounds: profile.maxFixRounds ?? config.delivery.maxFixRounds,
  }
}

/** Every flow named by a rule or by `flows.default` that has no profile — a typo that would otherwise change nothing, silently. */
export const unknownFlowReferences = (config: LoopConfig): readonly string[] => {
  const names = new Set<string>(config.flows.select.map((rule) => rule.flow))
  if (config.flows.default) names.add(config.flows.default)
  return [...names].filter((name) => !config.flows.profiles[name]).sort()
}

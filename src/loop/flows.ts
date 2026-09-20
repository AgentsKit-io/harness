import { resolveReviewSettings, type EffectiveReviewSettings, type EffortLevel, type LoopConfig, type LoopRole, type WorkerRole } from './config.js'
import type { ModelRole } from '../kernel/model-policy.js'

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

/**
 * Which model list backs each role. The four that own one map to themselves; the finer phases borrow the list
 * their work resembles — a planner thinks like the orchestrator, a voter reads like a reviewer.
 */
const ROLE_MODEL_LIST: Readonly<Record<LoopRole, ModelRole>> = {
  orchestrator: 'orchestrator', planner: 'orchestrator', vote: 'reviewer', review: 'reviewer',
  builder: 'builder', verify: 'builder', dod: 'builder', watcher: 'watcher',
}

export interface RoleSettings {
  readonly role: LoopRole
  /** The `models.<list>` this role draws its candidates from. */
  readonly list: ModelRole
  /** Pin declared by the flow, or null when routing decides as usual. */
  readonly provider: string | null
  readonly model: string | null
  readonly effort: EffortLevel
  /** Null = the caller's own default; a flow only shortens a leash it names. */
  readonly timeoutMs: number | null
  readonly source: 'flow' | 'config'
}

/**
 * What one role costs on one flow: who runs it, how hard it thinks, how long it may take.
 *
 * Narrow beats broad — the role inside the profile first, then the project's config, which `composeLoopConfig` has
 * already merged over the global one, and that is why there is nothing left to do for that layer here.
 */
export const resolveRoleSettings = (config: LoopConfig, flow: ResolvedFlow | null, role: LoopRole): RoleSettings => {
  const list = ROLE_MODEL_LIST[role]
  const override = flow?.profile?.roles?.[role]
  return {
    role,
    list,
    provider: override?.provider ?? null,
    model: override?.model ?? null,
    effort: override?.effort ?? config.models.effort[list],
    timeoutMs: override?.timeoutMs ?? null,
    source: override ? 'flow' : 'config',
  }
}

/**
 * The role's candidates under its flow settings: the pin first where the pin is available, and everyone carrying
 * the flow's effort.
 *
 * A pin nobody can serve right now falls through to the ordinary candidates. Refusing to run would turn a
 * preference into an outage, and the dispatch record says which model actually ran either way.
 */
export const applyRoleSettings = <T extends { readonly provider: string; readonly model: string; readonly effort: EffortLevel }>(
  candidates: readonly T[],
  settings: RoleSettings,
): readonly T[] => {
  const pinned = settings.provider || settings.model
    ? candidates.filter((candidate) => (!settings.provider || candidate.provider === settings.provider) && (!settings.model || candidate.model === settings.model))
    : []
  const ordered = pinned.length ? [...pinned, ...candidates.filter((candidate) => !pinned.includes(candidate))] : candidates
  return ordered.map((candidate) => candidate.effort === settings.effort ? candidate : { ...candidate, effort: settings.effort })
}

/**
 * Whether one per-issue phase runs.
 *
 * The flow's `stages` toggle wins, then an explicit `worker.roles` list, and with neither the phase keeps
 * answering from its own block — which is what `fallback` carries, so a project that never opted in sees no
 * change at all. `builder` is the work itself: it always runs.
 */
export const workerPhaseEnabled = (config: LoopConfig, flow: ResolvedFlow | null, phase: WorkerRole, fallback: boolean): boolean => {
  if (phase === 'builder') return true
  const toggle = flow?.profile?.stages?.[phase]
  if (typeof toggle === 'boolean') return toggle
  const declared = config.worker.roles
  return declared ? declared.includes(phase) : fallback
}

/** Every flow named by a rule or by `flows.default` that has no profile — a typo that would otherwise change nothing, silently. */
export const unknownFlowReferences = (config: LoopConfig): readonly string[] => {
  const names = new Set<string>(config.flows.select.map((rule) => rule.flow))
  if (config.flows.default) names.add(config.flows.default)
  return [...names].filter((name) => !config.flows.profiles[name]).sort()
}

import type { Decision, IssuePhase } from './projection.js'

/**
 * Wire types for the control plane v2 endpoints. Server modules produce these; the app consumes them through
 * `src/ui/app/src/lib/api.ts`. Every read model here is a pure function of state the loop already writes —
 * nothing in this file implies new persisted state.
 */

// ---- freshness & reconciliation (snapshot extras) ------------------------------------------------------------

export type FreshnessSource = 'loop' | 'tracker' | 'orca'

export interface Freshness {
  readonly source: FreshnessSource
  /** When that source was last read successfully; `null` = never / unknown (never treated as fresh). */
  readonly at: string | null
  readonly ageMs: number | null
  readonly stale: boolean
}

export type DriftKind =
  | 'tracker-closed' // tracker says Done/Canceled while the loop still holds a slot, lease or active run
  | 'lease-without-dispatch' // a coordination lease with no dispatch record behind it
  | 'dispatch-without-worker' // dispatched and unfinished, but no live worktree/terminal in Orca
  | 'capacity-overcount' // running count above the machine ceiling

export interface Drift {
  readonly issue: string | null
  readonly kind: DriftKind
  readonly detail: string
  readonly trackerState: string | null
  readonly loopPhase: IssuePhase | null
}

// ---- attention ---------------------------------------------------------------------------------------------

/** Display order, highest first: human decisions → stuck/failed → out of sync → system. */
export type AttentionGroup = 'human' | 'failed' | 'drift' | 'system'

export type AttentionKind =
  | 'hitl' | 'held-pr' | 'plan-gate' | 'design-gate' | 'release-gate'
  | 'ci-failed' | 'fix-round-cap' | 'blocked' | 'stuck' | 'permission-wait' | 'cost-guard' | 'max-duration'
  | 'drift'
  | 'doctor' | 'provider-cooldown' | 'automation-drift' | 'automation-missing' | 'stage-paused' | 'tracker-sync' | 'pii'

/** `id` is what the app dispatches on; each maps to one endpoint (see `ATTENTION_ACTION_ENDPOINTS` in the app). */
export type AttentionActionId =
  | 'answer' | 'approve-pr' | 'approve-plan' | 'approve-design' | 'approve-release'
  | 'retry' | 'cancel' | 'resume' | 'open' | 'reconcile'
  | 'reinstall-automations' | 'resume-stage' | 'run-doctor'

export interface AttentionAction {
  readonly id: AttentionActionId
  readonly label: string
  readonly primary: boolean
  /** Destructive or gate actions always go through the confirmation modal and require typing the id. */
  readonly destructive: boolean
  readonly gate: boolean
}

export interface AttentionItem {
  /** Stable across refreshes for the same condition (e.g. `hitl:<requestId>`, `drift:<issue>:<kind>`). */
  readonly id: string
  readonly group: AttentionGroup
  readonly kind: AttentionKind
  readonly issue: string | null
  readonly title: string
  /** One sentence: why this needs the operator. Human-readable, never a raw error code. */
  readonly reason: string
  /** Raw code/detail kept for the detail view (e.g. `HARNESS_ERROR…`), `null` when none. */
  readonly detail: string | null
  readonly since: string
  readonly actions: readonly AttentionAction[]
  /** True when destructive actions on this item must stay disabled (stale inputs or drift). */
  readonly locked: boolean
  readonly lockReason: string | null
  readonly decision?: Decision
  /** Held-PR head SHA the approval is pinned to. */
  readonly head?: string | null
  readonly stage?: string | null
}

export interface SnapshotExtras {
  readonly freshness: readonly Freshness[]
  readonly drift: readonly Drift[]
  readonly attention: readonly AttentionItem[]
  /** Issues whose destructive actions are locked right now, with the reason. */
  readonly locks: Readonly<Record<string, string>>
  /** Snapshot is considered stale after this many ms (2× the tick cadence). */
  readonly staleAfterMs: number
}

// ---- metrics (Costs, Trends, sparklines) ---------------------------------------------------------------------

export type MetricsWindow = '24h' | '7d' | '14d' | '30d'

export interface TimePoint { readonly at: string }

export interface MetricsReport {
  readonly window: MetricsWindow
  readonly from: string
  readonly to: string
  readonly bucket: 'hour' | 'day'
  readonly throughput: readonly (TimePoint & { readonly merged: number; readonly failed: number })[]
  readonly leadTime: {
    readonly medianMs: number | null
    readonly p90Ms: number | null
    readonly previousMedianMs: number | null
    readonly series: readonly (TimePoint & { readonly medianMs: number | null; readonly p90Ms: number | null })[]
  }
  /** Labels `'0'`, `'1'`, `'2'`, `'3+'`, `'cap'`. */
  readonly fixRounds: readonly { readonly label: string; readonly count: number }[]
  readonly firstReviewApprovalRate: number | null
  readonly criteriaAtMerge: { readonly proven: number; readonly waived: number; readonly held: number }
  readonly stopReasons: readonly { readonly reason: string; readonly count: number }[]
  readonly tokens: {
    readonly total: number
    readonly input: number
    readonly output: number
    readonly cacheHitRate: number | null
    readonly medianPerMergedIssue: number | null
    readonly byRole: Readonly<Record<string, number>>
    readonly series: readonly (TimePoint & { readonly byRole: Readonly<Record<string, number>> })[]
    readonly perIssue: readonly { readonly issue: string; readonly title: string | null; readonly tokens: number; readonly cap: number | null }[]
  }
  readonly providers: readonly {
    readonly provider: string
    readonly roles: readonly string[]
    readonly remainingPercent: number | null
    readonly series: readonly (TimePoint & { readonly remainingPercent: number })[]
    /** Linear projection of `remainingPercent` to 0 at the window's recent pace; `null` when not falling. */
    readonly projectedZeroAt: string | null
    readonly cooldownUntil: string | null
  }[]
  readonly memorySavedChars: number
  /** Last 24h in 12 buckets, for the home sparklines. */
  readonly sparks: { readonly merged: readonly number[]; readonly failed: readonly number[]; readonly tokens: readonly number[] }
  /** Window totals: `merged`/`failed` sum `throughput`; `escalated` counts `contract.escalated` (same as the retro). */
  readonly totals?: { readonly merged: number; readonly failed: number; readonly escalated: number }
}

// ---- search (Explore) ------------------------------------------------------------------------------------------

export type SearchType = 'event' | 'contract' | 'evidence' | 'review' | 'learning'

export interface SearchHit {
  readonly id: string
  readonly type: SearchType
  readonly issue: string | null
  readonly title: string
  readonly snippet: { readonly pre: string; readonly hit: string; readonly post: string }
  readonly at: string | null
  /** Human-readable origin, relative to the state dir (e.g. `issues/X/dod.json`), never an absolute path. */
  readonly source: string
  readonly body: Readonly<Record<string, unknown>>
}

export interface SearchResult {
  readonly query: string
  readonly window: MetricsWindow
  readonly hits: readonly SearchHit[]
  readonly counts: Readonly<Record<SearchType, number>>
  readonly tookMs: number
  readonly truncated: boolean
}

// ---- system ----------------------------------------------------------------------------------------------------

export type CheckStatus = 'pass' | 'warn' | 'fail'

export interface SystemReport {
  readonly doctor: { readonly ranAt: string; readonly checks: readonly { readonly name: string; readonly status: CheckStatus; readonly detail: string }[] } | null
  readonly machine: { readonly loadPercent: number | null; readonly freeRamGb: number | null; readonly liveTerminals: number | null; readonly slots: number }
  readonly routing: readonly { readonly role: string; readonly model: string | null; readonly reason: string }[]
  readonly cooldowns: readonly { readonly provider: string; readonly until: string; readonly reason: string }[]
  readonly handoffs: number
  readonly stages: readonly {
    readonly stage: string
    readonly schedule: string | null
    readonly lastRunAt: string | null
    readonly lastStatus: string | null
    readonly paused: boolean
    readonly pausedReason: string | null
    readonly installed: boolean
    readonly drift: readonly string[]
  }[]
  readonly learnings: readonly { readonly id: string; readonly category: string; readonly text: string; readonly sightings: number; readonly source: string; readonly status: 'proposed' | 'promoted' | 'rejected' }[]
  readonly retroSuggestions: readonly { readonly text: string; readonly knob: string | null; readonly target: 'project' | 'harness' }[]
  readonly alerts: { readonly configured: boolean; readonly lastDelivery: { readonly at: string; readonly status: number | 'error' } | null }
}

// ---- config (Settings) -----------------------------------------------------------------------------------------

export type ConfigLayer = 'default' | 'global' | 'team' | 'team-overlay' | 'personal'
/** `gate` = weakening it lowers a delivery guarantee (review, human approval, token cap, DoD, verification). */
export type FieldClass = 'safe' | 'sensitive' | 'gate'

export interface ConfigField {
  readonly path: string
  readonly value: unknown
  readonly layer: ConfigLayer
  readonly section: string
  readonly description: string
  readonly classification: FieldClass
  /** `personal` = written to the local overlay; `propose` = team value, only as a diff; `readonly` = neither. */
  readonly editable: 'personal' | 'propose' | 'readonly'
  readonly tuning: { readonly from: unknown; readonly to: unknown; readonly at: string; readonly metric: string; readonly frozen: boolean } | null
}

export interface EffectiveConfig {
  readonly hash: string
  readonly layers: readonly { readonly layer: ConfigLayer; readonly file: string | null }[]
  readonly fields: readonly ConfigField[]
  /** Paths the personal layer sets below the team value on a `gate` field. Runs record these. */
  readonly weakenedGates: readonly string[]
}

export interface ConfigChange {
  readonly path: string
  readonly value: unknown
  /** Remove the key from the target file instead of setting it (personal: fall back to the team value). */
  readonly reset?: boolean
}

export interface ConfigWriteRequest {
  readonly changes: readonly ConfigChange[]
  /** Must be true when any change weakens a `gate` field, or the write is refused. */
  readonly confirmWeakening: boolean
}

export interface ConfigProposal { readonly file: string; readonly diff: string }

/** `POST /tuning/revert`: the knob is frozen and the undo comes back as a team proposal (the UI never writes the team file). */
export interface TuningRevertResult { readonly config: EffectiveConfig; readonly proposal: ConfigProposal }

// ---- batch enqueue ---------------------------------------------------------------------------------------------

export interface BatchRunSettings {
  readonly flow?: string | null
  readonly builder?: string
  readonly maxFixRounds?: number
  readonly perIssueTokens?: number
}

export interface BatchRequest {
  readonly defaults: BatchRunSettings
  readonly issues: readonly ({ readonly issue: string } & BatchRunSettings)[]
}

// ---- issue detail (side panel) ----------------------------------------------------------------------------------

export type CriterionStatus = 'proven' | 'failed' | 'missing'

/** `GET /api/v1/issues/:id/detail` — everything the side panel's tabs show beyond the snapshot record. */
export interface IssueDetail {
  readonly issue: string
  readonly contract: { readonly digest: string; readonly intent: string; readonly inScope: readonly string[]; readonly outOfScope: readonly string[]; readonly frozenAt: string | null } | null
  /** Contract outcomes joined with DoD evidence; project-level DoD items appear with ids prefixed `dod:`. */
  readonly criteria: readonly { readonly id: string; readonly text: string; readonly status: CriterionStatus; readonly evidence: string | null; readonly source: 'worker' | 'harness' | null }[]
  readonly review: {
    readonly head: string | null
    readonly status: string
    readonly blocking: number
    readonly provider: string | null
    readonly model: string | null
    readonly findings: readonly { readonly severity: string; readonly text: string; readonly file: string | null }[]
  } | null
  readonly spend: { readonly tokens: number; readonly cap: number | null; readonly calls: number }
  readonly worker: { readonly terminal: string | null; readonly lastOutputAt: string | null; readonly preview: string | null } | null
  /** Why the run stopped (human-readable) and what to do, when it needs the operator; `null` when it is moving. */
  readonly nextStep: { readonly reason: string; readonly detail: string | null; readonly actions: readonly AttentionAction[] } | null
  readonly fixRounds: { readonly used: number; readonly max: number | null }
}

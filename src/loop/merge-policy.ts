import { isProven, meetsVerdict, verdictRank, type Verdict } from './verdict.js'

/**
 * ADR-0046: the one place that decides whether a PR merges. Pure — everything it needs comes in as data, nothing is
 * read, so the whole decision table is a unit test and `deliver` cannot merge by any other road. Gates that need
 * the world (fetching checks, running a review, proving the definition of done) stay in `deliver`; they produce
 * these inputs, they do not decide.
 */
export interface MergePolicyInput {
  /** One verdict per definition-of-done item; null = nothing recorded. */
  readonly verdicts: readonly { readonly id: string; readonly verdict: Verdict | null }[]
  /** Project minimum (`delivery.merge.minVerdict`). */
  readonly minVerdict: Verdict
  /** Patch-id the verdicts were made on, and the PR's patch-id now. Both known and different = the verdicts are stale. */
  readonly patch: { readonly verified: string | null; readonly current: string | null }
  /** `gating` off is a flow's deliberate choice (`merge.requireChecks: false`); the status is then only reported. */
  readonly checks: { readonly gating: boolean; readonly status: 'green' | 'pending' | 'red' | 'missing' }
  /**
   * `required` off = the flow turned the review phase off. `leftovers`: the stop rule moved this head's remaining
   * (medium/low, non-correctness) findings into that issue, so they no longer block. `personLabels`: labels the
   * issue was dispatched with that keep such a PR for a person.
   */
  readonly review: { readonly required: boolean; readonly status: 'clean' | 'findings' | 'incomplete' | null; readonly blocking: number; readonly leftovers?: string | null; readonly personLabels?: readonly string[] }
  readonly heldPaths: {
    readonly protectedFiles: readonly string[]
    /** A person approved this exact head. */
    readonly protectedApproved: boolean
    readonly secretFiles: readonly string[]
    /** The enforced layer-boundary violation, if any. */
    readonly boundary: string | null
  }
  readonly autonomy: 'supervised' | 'autonomous'
  /** The flow's `merge.auto`. */
  readonly autoMerge: boolean
  readonly humanApproval: { readonly required: boolean; readonly given: boolean }
  /** What actually examined the diff (CI, review, verify, definition of done). Empty = nothing did. */
  readonly vouchedBy: readonly string[]
  readonly escalation: { readonly onBlockedVerdict: boolean }
}

export type MergeDecision =
  | { readonly action: 'merge' }
  | { readonly action: 'hold'; readonly reason: string }
  | { readonly action: 'escalate'; readonly reason: string }

const hold = (reason: string): MergeDecision => ({ action: 'hold', reason })

export const decideMerge = (input: MergePolicyInput): MergeDecision => {
  const { verdicts, minVerdict, heldPaths, review, checks } = input

  // A person has to look: the worker said it cannot verify the item at all, so another fix round cannot help.
  const blocked = verdicts.filter((item) => item.verdict === 'blocked').map((item) => item.id)
  if (blocked.length && input.escalation.onBlockedVerdict) return { action: 'escalate', reason: `could not be verified (blocked): ${blocked.join(', ')}` }

  if (heldPaths.protectedFiles.length && !heldPaths.protectedApproved) return hold(`touches protected paths: ${heldPaths.protectedFiles.join(', ')}`)
  if (heldPaths.secretFiles.length) return hold(`touches secret-shaped file(s): ${heldPaths.secretFiles.join(', ')}`)
  if (heldPaths.boundary) return hold(`outside its layer boundary — ${heldPaths.boundary}`)

  if (review.required) {
    if (review.status === null) return hold('no review recorded for this head')
    // `findings` with nothing at or above the severity floor (blocking 0) is a clean review; anything blocking, or no complete review, is not.
    if (review.status === 'incomplete' || (review.blocking > 0 && !review.leftovers)) return hold(`review is not clean (${review.status}, ${review.blocking} blocking)`)
    if (review.leftovers && review.personLabels?.length) return hold(`ready to merge with leftovers (${review.leftovers}); ${review.personLabels.join(', ')} stays for a person`)
  }
  if (checks.gating && checks.status !== 'green') return hold(`checks ${checks.status}`)

  const { verified, current } = input.patch
  if (verified !== null && current !== null && verified !== current) return hold('the verdicts were made on a different patch than this PR now carries; re-verify')
  const short = verdicts.filter((item) => item.verdict === null || !isProven(item.verdict) || !meetsVerdict(item.verdict, minVerdict))
  if (short.length) {
    return hold(`verdict below ${minVerdict}: ${short.map((item) => `${item.id} (${item.verdict ?? 'none recorded'})`).join(', ')}`)
  }

  if (!input.vouchedBy.length) return hold('nothing examined this change — CI gating, review, verify and the definition of done are all off for this flow; auto-merge needs at least one')
  if (input.autonomy === 'supervised') return hold('delivery.merge.autonomy is supervised; a person merges')
  if (!input.autoMerge) return hold('review clean; auto-merge disabled')
  if (input.humanApproval.required && !input.humanApproval.given) return hold('review clean and checks green, but delivery.merge.requireHumanApproval is set and no human has approved this PR on GitHub yet')
  return { action: 'merge' }
}

/** The weakest verdict among the items, or null when there are none — what the proof shows as the PR's level. */
export const weakestVerdict = (verdicts: readonly { readonly verdict: Verdict | null }[]): Verdict | null => {
  let weakest: Verdict | null = null
  for (const { verdict } of verdicts) {
    if (verdict === null) return 'failed'
    if (weakest === null || verdictRank(verdict) < verdictRank(weakest)) weakest = verdict
  }
  return weakest
}

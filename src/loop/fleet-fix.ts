import type { WorkspaceObservation } from './runner-connector.js'

/** The fleet's reason classes for a task that ended without doing the work, none of them a verdict on the code. */
const INFRA_REASONS: readonly (readonly [string, RegExp])[] = [
  ['no-op on every variant', /\bno-?op\b/i],
  ['no eligible host', /no eligible host|no host (?:could|can) run/i],
  ['install failed', /install(?:ation)? failed|failed to install/i],
  ['host down', /host (?:is )?(?:down|died|unreachable|lost)|lost (?:the )?host/i],
  ['cancelled by the fleet', /cancel(?:l)?ed by the fleet/i],
]

export interface FixFailure { readonly infrastructure: boolean; readonly reason: string }

/**
 * Why a fix task (conflict/CI/review/continuation) did not give the PR a new head. Infrastructure — the fleet could not
 * run it, or it changed nothing on any variant — is retried; only a task that ran and produced a failing result is the
 * kind a person has to look at. A task the fleet cancelled is infrastructure unless its own output says otherwise.
 */
export const classifyFixFailure = (state: NonNullable<WorkspaceObservation['state']>, tail: string, collectedNothing: boolean): FixFailure => {
  const named = INFRA_REASONS.find(([, pattern]) => pattern.test(tail))
  if (named) return { infrastructure: true, reason: named[0] }
  if (state === 'cancelled') return { infrastructure: true, reason: 'cancelled by the fleet' }
  if (state === 'done' && collectedNothing) return { infrastructure: true, reason: 'no-op on every variant (done with no commit)' }
  return { infrastructure: false, reason: state === 'failed' ? 'the fix task failed' : `the fix task ended ${state}` }
}

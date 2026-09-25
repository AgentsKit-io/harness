import type { BoardIssue, Decision, IssueRecord, UiSnapshot } from './api'

export type { IssueRecord } from './api'

export interface AvailableIssue {
  readonly identifier: string
  readonly title: string
  readonly state: string
  readonly labels: readonly string[]
  readonly error: string | null
}

/** A board issue counts as available for the wizard when the control plane has never touched it, or has and
 * settled back to `available` (a failed dispatch, a resumed pause, a reopened decision). */
export const deriveAvailable = (snapshot: UiSnapshot): readonly AvailableIssue[] => {
  const byIssue = new Map(snapshot.issues.map((record) => [record.issue, record]))
  const fromBoard: readonly AvailableIssue[] = (snapshot.board?.issues ?? [])
    .filter((issue): issue is BoardIssue => !byIssue.has(issue.identifier) || byIssue.get(issue.identifier)?.phase === 'available')
    .map((issue) => ({ identifier: issue.identifier, title: issue.title, state: issue.state, labels: issue.labels, error: byIssue.get(issue.identifier)?.error ?? null }))
  const boardIds = new Set((snapshot.board?.issues ?? []).map((issue) => issue.identifier))
  const offBoard: readonly AvailableIssue[] = snapshot.issues
    .filter((record) => record.phase === 'available' && !boardIds.has(record.issue))
    .map((record) => ({ identifier: record.issue, title: record.title ?? record.issue, state: record.trackerState ?? '', labels: [], error: record.error }))
  return [...fromBoard, ...offBoard]
}

export const deriveRunning = (snapshot: UiSnapshot): readonly IssueRecord[] => snapshot.issues.filter((record) => record.phase === 'running' && !record.run?.archived)
export const deriveReview = (snapshot: UiSnapshot): readonly IssueRecord[] => snapshot.issues.filter((record) => (record.phase === 'review' || record.phase === 'needs-decision') && !record.run?.archived)
export const deriveBlocked = (snapshot: UiSnapshot): readonly IssueRecord[] => snapshot.issues.filter((record) => record.phase === 'blocked' && !record.run?.archived)
export const deriveHistory = (snapshot: UiSnapshot): readonly IssueRecord[] => snapshot.issues.filter((record) => record.phase === 'completed' && !record.run?.archived)
export const deriveArchived = (snapshot: UiSnapshot): readonly IssueRecord[] => snapshot.issues.filter((record) => record.run?.archived)
// `pendingDecisions` only ever holds open ones — the server's overlay reads `hitl.ts` filtered to `status: 'open'`.
export const deriveInbox = (snapshot: UiSnapshot): readonly Decision[] => snapshot.issues.flatMap((record) => record.pendingDecisions)

export const phaseTone = (phase: IssueRecord['phase']): 'ok' | 'warn' | 'bad' | 'neutral' => {
  if (phase === 'completed') return 'ok'
  if (phase === 'blocked' || phase === 'needs-decision') return 'bad'
  if (phase === 'needs-input') return 'warn'
  return 'neutral'
}

import * as React from 'react'
import { useConfirm, type ConfirmBasis, type ConfirmRequest } from '@/components/ConfirmDialog'
import {
  approveDesign, approveHeldPr, approvePlan, approveRelease, cancelRun, reconcileIssue, reinstallAutomations, resumePausedIssue,
  resumeStage, retryRun, runDoctor, type AttentionAction, type UiSnapshot,
} from './api'
import { useLiveSnapshot, useSnapshotAge } from './snapshot'
import { useIssuePanel } from './useIssuePanel'

/** What an action is about. `planId` defaults to `issue` for plan/design gates. */
export interface ActionTarget {
  readonly issue: string | null
  readonly head?: string | null
  readonly stage?: string | null
  readonly planId?: string | null
  /** Set when destructive actions are locked (drift, stale inputs); makes the confirm basis stale. */
  readonly lockReason?: string | null
}

/** The facts a confirmation relies on, each with its age — loop/tracker/orca freshness plus the issue's own state. */
export const confirmBasis = (snapshot: UiSnapshot | null, snapshotAgeMs: number | null, target: ActionTarget): readonly ConfirmBasis[] => {
  const extras = snapshot?.extras
  const rows: ConfirmBasis[] = (extras?.freshness ?? []).map((item) => ({
    label: `${item.source} read`, value: item.at ? new Date(item.at).toLocaleTimeString() : 'never', ageMs: item.ageMs, stale: item.stale,
  }))
  const record = target.issue ? snapshot?.issues.find((candidate) => candidate.issue === target.issue) : undefined
  const snapshotStale = extras ? snapshotAgeMs === null || snapshotAgeMs > extras.staleAfterMs : false
  if (record) rows.push({ label: 'loop state', value: `${record.phase}${record.run ? ` · run ${record.run.status}` : ''}`, ageMs: snapshotAgeMs, stale: snapshotStale })
  if (record?.trackerState) {
    const tracker = extras?.freshness.find((item) => item.source === 'tracker')
    rows.push({ label: 'tracker state', value: record.trackerState, ageMs: tracker?.ageMs ?? snapshotAgeMs, stale: tracker?.stale ?? false })
  }
  if (target.head) rows.push({ label: 'PR head', value: target.head.slice(0, 7), ageMs: snapshotAgeMs, stale: snapshotStale })
  const lock = target.lockReason ?? (target.issue ? extras?.locks[target.issue] : undefined)
  if (lock) rows.push({ label: 'out of sync', value: lock, ageMs: null, stale: true })
  return rows
}

type Confirmable = Omit<ConfirmRequest, 'basis' | 'onConfirm'>

const confirmation = (action: AttentionAction, target: ActionTarget): Confirmable | null => {
  const issue = target.issue ?? ''
  switch (action.id) {
    case 'cancel': return {
      title: <>Cancel run <span className="font-mono text-danger">{issue}</span>?</>, tone: 'danger', confirmLabel: 'Cancel run', typeToConfirm: issue,
      effects: ['Close the worker terminal and force-remove its worktree', 'Release the slot and lease held for this issue', 'Move the tracker issue back to its return state (Todo by default)'],
    }
    case 'approve-pr': return {
      title: <>Approve held PR for <span className="font-mono text-warning">{issue}</span>?</>, tone: 'gate', confirmLabel: 'Approve', typeToConfirm: issue,
      effects: [`Record your approval pinned to head ${target.head?.slice(0, 7) ?? '(unknown)'}`, 'Let the loop merge it on the next delivery if checks still pass', 'A new push invalidates this approval'],
    }
    case 'approve-plan':
    case 'approve-design': return {
      title: `Approve the ${action.id === 'approve-plan' ? 'plan' : 'design'} for ${target.planId ?? issue}?`, tone: 'gate', confirmLabel: 'Approve', typeToConfirm: target.planId ?? issue,
      effects: [`Mark the ${action.id === 'approve-plan' ? 'plan' : 'design'} as human-approved`, 'Allow its issues to be dispatched'],
    }
    case 'approve-release': return { title: 'Approve the release?', tone: 'gate', confirmLabel: 'Approve release', effects: ['Record human approval for the pending release', 'Let the release stage publish it'] }
    default: return action.destructive || action.gate
      ? { title: `${action.label}${issue ? ` · ${issue}` : ''}?`, tone: action.destructive ? 'danger' : 'gate', confirmLabel: action.label, typeToConfirm: issue || undefined, effects: [action.label] }
      : null
  }
}

const call = (action: AttentionAction, target: ActionTarget): Promise<unknown> => {
  const issue = target.issue ?? ''
  switch (action.id) {
    case 'approve-pr': return approveHeldPr(issue, target.head ?? '')
    case 'approve-plan': return approvePlan(target.planId ?? issue)
    case 'approve-design': return approveDesign(target.planId ?? issue)
    case 'approve-release': return approveRelease()
    case 'retry': return retryRun(issue)
    case 'cancel': return cancelRun(issue, 'Cancelled from the control plane')
    case 'resume': return resumePausedIssue(issue)
    case 'reconcile': return reconcileIssue(issue)
    case 'reinstall-automations': return reinstallAutomations()
    case 'resume-stage': return resumeStage(target.stage ?? issue)
    case 'run-doctor': return runDoctor()
    case 'answer':
    case 'open': return Promise.resolve()
  }
}

/** One dispatcher for every `AttentionAction`: gates and destructive actions go through the confirm dialog with
 * a freshness basis; the rest run directly. Render `dialog` once. */
export const useActionRunner = (): {
  readonly run: (action: AttentionAction, target: ActionTarget) => void
  readonly busy: string | null
  readonly error: string | null
  readonly dialog: React.ReactElement | null
} => {
  const { snapshot, refresh } = useLiveSnapshot()
  const age = useSnapshotAge()
  const { ask, dialog } = useConfirm()
  const panel = useIssuePanel()
  const [busy, setBusy] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const run = (action: AttentionAction, target: ActionTarget): void => {
    if ((action.id === 'open' || action.id === 'answer') && target.issue) { panel.open(target.issue); return }
    const confirm = confirmation(action, target)
    if (confirm) { ask({ ...confirm, basis: confirmBasis(snapshot, age, target), onConfirm: () => call(action, target).then(refresh) }); return }
    const key = `${action.id}:${target.issue ?? ''}`
    setBusy(key); setError(null)
    call(action, target).then(refresh).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setBusy(null))
  }
  return { run, busy, error, dialog }
}

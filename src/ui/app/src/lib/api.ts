import { useCallback, useEffect, useRef, useState } from 'react'
import type { UiSnapshot } from '../../../api/server'
import type { UiJobRecord } from '../../../api/jobs'

export type { UiSnapshot } from '../../../api/server'
export type { IssueRecord, Decision, RunRecord, DispatchRef, PullRequestRef, IssuePhase, ReviewSubstatus } from '../../../api/projection'
export type { BoardSnapshot, BoardIssue } from '../../../api/board'
export type { UiJobRecord } from '../../../api/jobs'
export type { UiWizardDraft, UiWizardDraftPatch } from '../../../api/wizard'

declare global {
  interface Window { __HARNESS_SESSION__?: string }
}

const token = (): string => window.__HARNESS_SESSION__ ?? ''

export class ApiError extends Error {
  public readonly status: number
  public readonly body: Record<string, unknown>
  public constructor(status: number, body: Record<string, unknown>) {
    super(typeof body['error'] === 'string' ? body['error'] : `Request failed (${status}).`)
    this.status = status
    this.body = body
  }
}

const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const response = await fetch(`/api/v1/${path}`, { ...init, headers: { 'x-harness-session': token(), 'content-type': 'application/json', ...init.headers } })
  const body = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) throw new ApiError(response.status, body)
  return body as T
}

export const getState = (force = false): Promise<UiSnapshot> => api(`state${force ? '?refresh=1' : ''}`)
export const getWizard = (issue: string): Promise<Record<string, unknown>> => api(`wizard/${encodeURIComponent(issue)}`)
export const saveWizardDraft = (issue: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> => api(`wizard/${encodeURIComponent(issue)}`, { method: 'PUT', body: JSON.stringify(patch) })
export const generateContract = (issue: string, refresh: boolean): Promise<{ readonly job: UiJobRecord }> => api(`wizard/${encodeURIComponent(issue)}/contract`, { method: 'POST', body: JSON.stringify({ refresh }) })
export const getJob = (id: string): Promise<{ readonly job: UiJobRecord }> => api(`jobs/${encodeURIComponent(id)}`)

export interface TimelineEvent { readonly at: string; readonly type: string; readonly [key: string]: unknown }
export const getTimeline = (issue: string): Promise<{ readonly events: readonly TimelineEvent[] }> => api(`issues/${encodeURIComponent(issue)}/timeline`)

export interface EnqueueRunInput {
  readonly issue: string
  readonly configHash: string
  readonly flow: string | null
  readonly builder: string
  readonly contractDigest: string
  readonly maxFixRounds: number
  readonly perIssueTokens: number
}
export const enqueueRun = (input: EnqueueRunInput): Promise<{ readonly runId: string }> => api('runs', { method: 'POST', body: JSON.stringify({ ...input, preflight: true }) })
export const cancelRun = (issue: string, reason: string): Promise<unknown> => api(`issues/${encodeURIComponent(issue)}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) })
export const retryRun = (issue: string): Promise<unknown> => api(`issues/${encodeURIComponent(issue)}/retry`, { method: 'POST' })
export const archiveRun = (issue: string): Promise<unknown> => api(`issues/${encodeURIComponent(issue)}/archive`, { method: 'POST' })
export const restoreRun = (issue: string): Promise<unknown> => api(`issues/${encodeURIComponent(issue)}/restore`, { method: 'POST' })
export const decideIssue = (issue: string, action: 'close-issue' | 'reopen'): Promise<unknown> => api(`issues/${encodeURIComponent(issue)}/decision`, { method: 'POST', body: JSON.stringify({ action }) })
export const resumePausedIssue = (issue: string): Promise<unknown> => api(`issues/${encodeURIComponent(issue)}/resume`, { method: 'POST' })
export const answerDecision = (issue: string, requestId: string, input: { readonly optionId: string; readonly freeText?: string; readonly expectedDigest: string }): Promise<{ readonly batchReady: boolean }> =>
  api(`issues/${encodeURIComponent(issue)}/decisions/${encodeURIComponent(requestId)}/answer`, { method: 'POST', body: JSON.stringify({ ...input, actor: 'ui' }) })

/** Live state: an SSE connection when the browser has one, falling back to polling on the same interval the
 * server already broadcasts at if the connection drops — the server is the single source of truth either way,
 * this only decides how quickly the tab notices. */
export const useSnapshot = (): { readonly snapshot: UiSnapshot | null; readonly error: string | null; readonly refresh: () => void } => {
  const [snapshot, setSnapshot] = useState<UiSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(() => { getState(true).then(setSnapshot).then(() => setError(null)).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause))) }, [])

  useEffect(() => {
    let cancelled = false
    getState().then((value) => { if (!cancelled) setSnapshot(value) }).catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)) })
    const source = new EventSource(`/api/v1/events?session=${encodeURIComponent(token())}`)
    source.addEventListener('snapshot', (event) => { try { setSnapshot(JSON.parse((event as MessageEvent<string>).data) as UiSnapshot); setError(null) } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } })
    source.onerror = () => {
      if (pollTimer.current) return
      pollTimer.current = setInterval(() => { getState().then(setSnapshot).catch(() => { /* try again next tick */ }) }, 2_000)
    }
    source.onopen = () => { if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null } }
    return () => { cancelled = true; source.close(); if (pollTimer.current) clearInterval(pollTimer.current) }
  }, [])

  return { snapshot, error, refresh }
}

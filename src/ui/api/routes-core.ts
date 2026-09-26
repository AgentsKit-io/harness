import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseReviewResult } from '../../adapters/code-review.js'
import { issueSpend } from '../../loop/budget.js'
import type { LoadedLoopConfig } from '../../loop/config.js'
import { readStoredContract } from '../../loop/contract.js'
import { readDeliveryState } from '../../loop/deliver.js'
import { assessDod, readDodEvidence } from '../../loop/dod.js'
import { readLoopEvents } from '../../loop/retro.js'
import { readDispatchRecord, type DispatchRecordFile } from '../../loop/tick.js'
import { reconcileIssue } from './actions.js'
import type { AttentionItem, IssueDetail } from './contract.js'
import { orcaCacheFor, type OrcaView } from './extras.js'
import { SAFE_IDENTIFIER, sendJson } from './http.js'
import type { IssueRecord } from './projection.js'
import type { RouteModule } from './routes.js'
import { readCurrentProjection } from './store.js'

/** `GET /issues/:id/detail` (the side panel) and `POST /issues/:id/reconcile` (settle drift). */

const PREVIEW_LINES = 40

type Criterion = IssueDetail['criteria'][number]

/** Contract outcomes (and project DoD items as `dod:<id>`) joined with the worker's proofs; falls back to the
 * harness's own last `dod.assessed` verdict when the worktree (and its evidence file) is gone. */
const criteriaFor = (loaded: LoadedLoopConfig, issue: string, worktreePath: string | null, contract: ReturnType<typeof readStoredContract>): readonly Criterion[] => {
  if (!loaded.config.dod) return (contract?.contract.outcomes ?? []).map((outcome) => ({ id: outcome.id, text: outcome.description, status: 'missing' as const, evidence: null, source: null }))
  const evidence = readDodEvidence(worktreePath, loaded.config)
  const assessment = assessDod({ config: loaded.config, contract: contract?.contract ?? null, evidence })
  const toCriterion = (line: (typeof assessment.lines)[number], status = line.status, proofless = false): Criterion => ({
    id: line.list === 'project' ? `dod:${line.id}` : line.id, text: line.description, status,
    evidence: proofless ? null : line.evidence || null, source: proofless ? 'harness' : line.source,
  })
  const proven = evidence.project.length + evidence.outcomes.length > 0
  if (proven) return assessment.lines.map((line) => toCriterion(line))
  // windowed: only since this issue's dispatch, the same bound `issueSpend` uses.
  const dispatchedAt = readDispatchRecord(loaded.stateDir, issue)?.dispatchedAt
  const assessed = dispatchedAt ? readLoopEvents(loaded.stateDir, Date.parse(dispatchedAt)).filter((event) => event.type === 'dod.assessed' && event.issue === issue).at(-1) : undefined
  if (!assessed) return assessment.lines.map((line) => toCriterion(line))
  const ids = (value: unknown): readonly string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  const missing = ids(assessed['missing']); const failed = ids(assessed['failed'])
  return assessment.lines.map((line) => toCriterion(line, failed.includes(line.id) ? 'failed' : missing.includes(line.id) ? 'missing' : 'proven', true))
}

const reviewFor = (loaded: LoadedLoopConfig, issue: string): IssueDetail['review'] => {
  const state = readDeliveryState(loaded.stateDir, issue)
  const head = Object.keys(state.reviews).at(-1) ?? state.heldFor
  if (!head) return null
  const summary = state.reviews[head]
  const path = join(loaded.stateDir, 'issues', issue, `review-${head.slice(0, 12)}.json`)
  let findings: NonNullable<IssueDetail['review']>['findings'] = []
  try { if (existsSync(path)) findings = parseReviewResult(JSON.parse(readFileSync(path, 'utf8')) as unknown).findings.map((finding) => ({ severity: finding.severity, text: finding.title, file: finding.file })) } catch { /* unreadable review file: summary only */ }
  return { head, status: summary?.status ?? 'unknown', blocking: summary?.blocking ?? 0, provider: summary?.provider ?? null, model: summary?.model ?? null, findings }
}

const workerFor = (dispatch: DispatchRecordFile | null, orca: OrcaView): IssueDetail['worker'] => {
  if (!dispatch) return null
  const handle = dispatch.terminal
  const terminal = handle ? orca.terminals.find((item) => item.handle === handle) : undefined
  return { terminal: handle, lastOutputAt: terminal?.lastOutputAt ? new Date(terminal.lastOutputAt).toISOString() : null, preview: terminal?.preview ? terminal.preview.split('\n').slice(-PREVIEW_LINES).join('\n') : null }
}

export const buildIssueDetail = (loaded: LoadedLoopConfig, record: IssueRecord | null, issue: string, attention: readonly AttentionItem[], orca: OrcaView): IssueDetail => {
  const stored = readStoredContract(loaded.stateDir, issue)
  const dispatch = readDispatchRecord(loaded.stateDir, issue)
  const spend = issueSpend(loaded.stateDir, issue)
  const cap = record?.run?.perIssueTokens || dispatch?.frozenPerIssueTokens || loaded.config.budget?.perIssueTokens || 0
  const next = attention.find((item) => item.issue === issue && item.group !== 'system')
  return {
    issue,
    contract: stored ? { digest: stored.digest, intent: stored.contract.intent, inScope: stored.contract.scope.inScope, outOfScope: stored.contract.scope.outOfScope, frozenAt: stored.generatedAt ?? null } : null,
    criteria: criteriaFor(loaded, issue, dispatch?.worktreePath ?? dispatch?.worktree ?? null, stored),
    review: reviewFor(loaded, issue),
    spend: { tokens: spend.totalTokens, cap: cap > 0 ? cap : null, calls: spend.calls },
    worker: workerFor(dispatch, orca),
    nextStep: next ? { reason: next.reason, detail: next.detail, actions: next.actions } : null,
    fixRounds: { used: readDeliveryState(loaded.stateDir, issue).fixRounds, max: record?.run?.maxFixRounds ?? dispatch?.frozenMaxFixRounds ?? loaded.config.delivery?.maxFixRounds ?? null },
  }
}

export const coreRoutes: RouteModule = async (context, request, response, url) => {
  const match = /^\/api\/v1\/issues\/([^/]+)\/(detail|reconcile)$/.exec(url.pathname)
  if (!match) return false
  const issue = decodeURIComponent(match[1]!)
  if (!SAFE_IDENTIFIER.test(issue)) { sendJson(response, 400, { error: 'invalid_issue' }); return true }
  const { loaded } = context
  if (match[2] === 'detail' && request.method === 'GET') {
    const record = readCurrentProjection(loaded.stateDir).issues[issue] ?? null
    const snapshot = await context.snapshot()
    const detail = buildIssueDetail(loaded, record, issue, snapshot.extras?.attention ?? [], await orcaCacheFor(loaded, context.runner).read())
    sendJson(response, 200, detail)
    return true
  }
  if (match[2] === 'reconcile' && request.method === 'POST') {
    const before = (await context.snapshot(true)).extras?.drift ?? []
    if (!before.some((item) => item.issue === issue)) { sendJson(response, 409, { error: 'no_drift', reason: `${issue} has no drift to reconcile.` }); return true }
    const { actions } = reconcileIssue(context, issue, before)
    const after = (await context.snapshot()).extras?.drift ?? []
    sendJson(response, 200, { issue, actions, drift: after.filter((item) => item.issue === issue) })
    return true
  }
  return false
}

import { scanForPii } from '../kernel/pii.js'
import { REVIEW_SEVERITIES, type ReviewSeverity } from '../adapters/code-review.js'
import type { CommentBlock, CommentDocument } from './comment-format.js'

/**
 * The delivery evidence posted on the tracker issue when the loop finishes it: what was verified, by what, at which
 * head — so a reader can audit the merge from the issue alone. Pure: deliver gathers the data it already holds
 * (delivery state, review result, `verify.json`, the DoD file, the PR's checks, the event log) and this turns it into
 * a `CommentDocument` the tracker connector renders.
 *
 * Fail-closed in presentation: anything absent is said to be absent, a skipped or blocked item is never shown as
 * passed, and every free-text field passes `scanForPii` before it reaches a comment.
 */

export type EvidenceStatus = 'passed' | 'failed' | 'skipped' | 'blocked' | 'missing' | 'pending'

export interface EvidenceProof { readonly id: string; readonly status: EvidenceStatus; readonly evidence: string; readonly description?: string; readonly list?: string }

export interface DeliveryEvidence {
  readonly issue: string
  readonly pr: { readonly number: number; readonly url: string; readonly title?: string } | null
  /** `null`: not merged (an escalation). `sha` null: the host did not report the merge commit. */
  readonly merge: { readonly sha: string | null; readonly by: 'loop' | 'outside' } | null
  /** Head the PR was merged (or stopped) at. */
  readonly head: string | null
  readonly worker: { readonly provider: string; readonly model: string } | null
  /** `null`: no review was recorded for this PR. */
  readonly review: {
    readonly head: string
    readonly status: 'clean' | 'findings' | 'incomplete'
    readonly provider: string
    readonly model: string | null
    readonly attempts: number
    readonly minSeverity: ReviewSeverity
    /** `null`: the review's result file is gone, so only the counts in the delivery state are known. */
    readonly findings: readonly { readonly severity: ReviewSeverity; readonly file: string | null; readonly line: number | null; readonly title: string }[] | null
    readonly blocking: number
  } | null
  /** Why the review was not run, when the flow turned it off. */
  readonly reviewSkipped?: string | null
  /** Every INCOMPLETE reason recorded on this PR, any head. */
  readonly incompleteReasons: readonly string[]
  /** `null`: the code host did not report them. */
  readonly unresolvedThreads: number | null
  /** The worker's `verify.json`. `null`: none recorded. */
  readonly verify: { readonly command: string; readonly exitCode: number | null; readonly ranAt: string | null; readonly outcomes: readonly EvidenceProof[] } | null
  /** The project verify the harness ran itself (`delivery.verify.argv`) — at which head, or why not. */
  readonly harnessVerify: { readonly command: string; readonly status: EvidenceStatus; readonly head: string | null } | null
  /** DoD lines (project list + issue outcomes). `null`: no DoD recorded or assessed. */
  readonly dod: readonly EvidenceProof[] | null
  readonly dodSkipped?: string | null
  /** Negative and recovery proofs, only when the DoD file records them. */
  readonly negativeProofs: readonly EvidenceProof[] | null
  readonly recoveryProofs: readonly EvidenceProof[] | null
  /** CI checks on the head. `null`: the host reported none. */
  readonly checks: readonly { readonly name: string; readonly outcome: string; readonly required: boolean }[] | null
  readonly checksGating: boolean
  readonly fixRounds: { readonly counted: number; readonly limit: number | null; readonly byKind: Readonly<Record<string, number>> }
  readonly handoffs: readonly string[]
  readonly elapsedMs: number | null
  readonly spend: { readonly totalTokens: number; readonly calls: number; readonly ceiling: number | null; readonly usageDeltaPercent: number | null } | null
  /** Run id in the local run store (`loop run show <id>`). */
  readonly runId: string | null
}

export interface EvidenceOptions {
  /** First line, e.g. `Loop: merged` or `Loop: blocked after 3 fix round(s)`. */
  readonly title: string
  /** One sentence after the title (what happened, who decided). */
  readonly summary: string
  readonly marker?: string
  /** Escalations: review findings, checks and DoD status only, no per-command tails. */
  readonly brief?: boolean
}

// ponytail: fixed caps; the tracker's character ceiling (`fitComment`) is the real bound, these keep one noisy list from eating it.
const MAX_ROWS = 40
const TAIL_CHARS = 400
const CELL_CHARS = 300

const clean = (value: string): string => scanForPii(value).redacted
const oneLine = (value: string, max = CELL_CHARS): string => { const text = clean(value).replace(/\s+/g, ' ').trim(); return text.length > max ? `${text.slice(0, max - 1)}…` : text }
const tail = (value: string): string => { const text = clean(value).trim(); return text.length > TAIL_CHARS ? `…${text.slice(-TAIL_CHARS)}` : text }
const short = (sha: string | null | undefined): string => sha ? sha.slice(0, 12) : 'unknown'
const label = (status: EvidenceStatus): string => status.toUpperCase()
const capped = <T>(rows: readonly T[]): { readonly rows: readonly T[]; readonly more: number } => ({ rows: rows.slice(0, MAX_ROWS), more: Math.max(0, rows.length - MAX_ROWS) })
const moreRow = (more: number, width: number): readonly (readonly string[])[] => more ? [[`… ${more} more`, ...Array.from({ length: width - 1 }, () => '')]] : []

export const formatDuration = (ms: number): string => {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 48 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/** APPROVE / COMMENT / REQUEST CHANGES / INCOMPLETE — the verdict a human reviewer would have given. */
export const reviewVerdict = (review: NonNullable<DeliveryEvidence['review']>): 'APPROVE' | 'COMMENT' | 'REQUEST CHANGES' | 'INCOMPLETE' => {
  if (review.status === 'incomplete') return 'INCOMPLETE'
  if (review.status === 'findings' && review.blocking > 0) return 'REQUEST CHANGES'
  return (review.findings?.length ?? 0) > 0 ? 'COMMENT' : 'APPROVE'
}

const severityCounts = (findings: NonNullable<NonNullable<DeliveryEvidence['review']>['findings']>): string =>
  [...REVIEW_SEVERITIES].reverse().map((severity) => `${severity} ${findings.filter((finding) => finding.severity === severity).length}`).join(', ')

const proofTable = (proofs: readonly EvidenceProof[], drop: CommentBlock['drop']): CommentBlock => {
  const { rows, more } = capped(proofs)
  const withList = proofs.some((proof) => proof.list)
  const header = withList ? ['status', 'list', 'id', 'evidence'] : ['status', 'id', 'evidence']
  return {
    kind: 'table', header, ...(drop ? { drop } : {}),
    rows: [...rows.map((proof) => [label(proof.status), ...(withList ? [proof.list ?? ''] : []), oneLine(proof.id, 80), oneLine(proof.evidence || (proof.status === 'missing' ? 'no proof recorded' : '—'))]), ...moreRow(more, header.length)],
  }
}

/** Counts per status, failing/missing/skipped/blocked first — the line a skimming reader needs. */
const tally = (proofs: readonly EvidenceProof[]): string => {
  const order: readonly EvidenceStatus[] = ['failed', 'blocked', 'missing', 'skipped', 'pending', 'passed']
  return order.map((status) => [status, proofs.filter((proof) => proof.status === status).length] as const).filter(([, count]) => count > 0).map(([status, count]) => `${count} ${status}`).join(', ') || 'no items'
}

export const buildEvidenceDocument = (evidence: DeliveryEvidence, options: EvidenceOptions): CommentDocument => {
  const blocks: CommentBlock[] = []
  const unavailable: string[] = []
  blocks.push({ kind: 'heading', text: oneLine(options.title, 200) })
  blocks.push({ kind: 'paragraph', text: clean(options.summary) })

  // Overview: one line per gate, each with an explicit state.
  const overview: string[] = []
  if (evidence.pr) overview.push(`PR: #${evidence.pr.number} ${evidence.pr.url}`)
  else { overview.push('PR: none recorded'); unavailable.push('pull request') }
  if (evidence.merge) overview.push(`Merged: ${evidence.merge.sha ? `\`${short(evidence.merge.sha)}\`` : 'merge commit not reported'} by ${evidence.merge.by === 'loop' ? 'the loop' : 'a person outside the loop — the loop\'s gates did not decide it'}`)
  overview.push(`Head: ${evidence.head ? `\`${short(evidence.head)}\`` : 'unknown'}`)
  if (evidence.review) {
    const sameHead = evidence.head ? evidence.review.head === evidence.head : true
    overview.push(`Code review: ${reviewVerdict(evidence.review)} at \`${short(evidence.review.head)}\`${sameHead ? '' : ' — NOT the final head; the final head was not reviewed by the loop'} (${evidence.review.provider}${evidence.review.model ? `/${evidence.review.model}` : ''}, ${evidence.review.attempts} attempt(s))`)
  } else if (evidence.reviewSkipped) overview.push(`Code review: SKIPPED — ${oneLine(evidence.reviewSkipped)}`)
  else { overview.push('Code review: no review recorded'); unavailable.push('code review') }
  overview.push(`Unresolved review threads: ${evidence.unresolvedThreads === null ? 'unavailable' : evidence.unresolvedThreads}`)
  if (evidence.unresolvedThreads === null) unavailable.push('review threads')
  if (evidence.checks?.length) {
    const failing = evidence.checks.filter((check) => check.outcome === 'failure' || check.outcome === 'unknown').length
    const pending = evidence.checks.filter((check) => check.outcome === 'pending').length
    const skipped = evidence.checks.filter((check) => check.outcome === 'skipped' || check.outcome === 'neutral').length
    overview.push(`CI: ${evidence.checks.length} check(s) — ${evidence.checks.length - failing - pending - skipped} passed, ${failing} failed, ${pending} pending, ${skipped} skipped/neutral${evidence.checksGating ? '' : ' (not gating for this flow)'}`)
  } else { overview.push('CI: no checks reported — not run or unavailable'); unavailable.push('CI checks') }
  if (evidence.harnessVerify) overview.push(`Harness verify \`${oneLine(evidence.harnessVerify.command, 120)}\`: ${label(evidence.harnessVerify.status)}${evidence.harnessVerify.head ? ` at \`${short(evidence.harnessVerify.head)}\`` : ''}`)
  if (evidence.verify) overview.push(`Worker verify: exit ${evidence.verify.exitCode ?? 'not recorded'} — ${tally(evidence.verify.outcomes)}`)
  else { overview.push('Worker verify (verify.json): no evidence recorded'); unavailable.push('verify.json') }
  if (evidence.dod?.length) overview.push(`Definition of Done: ${tally(evidence.dod)}`)
  else if (evidence.dodSkipped) overview.push(`Definition of Done: SKIPPED — ${oneLine(evidence.dodSkipped)}`)
  else if (evidence.dod) overview.push('Definition of Done: no items to prove (no project items, no contract outcomes)')
  else { overview.push('Definition of Done: no evidence recorded'); unavailable.push('definition of done') }
  const rounds = Object.entries(evidence.fixRounds.byKind).filter(([, count]) => count > 0).map(([kind, count]) => `${kind} ${count}`).join(', ')
  overview.push(`Fix rounds: ${evidence.fixRounds.counted}${evidence.fixRounds.limit === null ? '' : `/${evidence.fixRounds.limit}`}${rounds ? ` (nudges: ${rounds})` : ''}`)
  if (evidence.handoffs.length) overview.push(`Handoffs: ${evidence.handoffs.map((handoff) => oneLine(handoff, 120)).join('; ')}`)
  if (evidence.worker) overview.push(`Worker: \`${evidence.worker.provider}/${evidence.worker.model}\``)
  overview.push(`Elapsed: ${evidence.elapsedMs === null ? 'unknown' : formatDuration(evidence.elapsedMs)}`)
  if (evidence.spend) overview.push(`Tokens (loop-side calls; the worker CLI does not report its own): ${evidence.spend.calls ? `${evidence.spend.totalTokens.toLocaleString('en-US')} over ${evidence.spend.calls} recorded call(s)` : 'none recorded'}${evidence.spend.ceiling ? ` of a ${evidence.spend.ceiling.toLocaleString('en-US')} per-issue ceiling` : ''}${evidence.spend.usageDeltaPercent === null ? '' : `; worker provider usage −${evidence.spend.usageDeltaPercent.toFixed(1)} pts since dispatch`}`)
  else { overview.push('Tokens: not recorded'); unavailable.push('token spend') }
  if (evidence.runId) overview.push(`Run: \`${evidence.runId}\` (\`ak-harness loop run show ${evidence.runId}\`)`)
  blocks.push({ kind: 'list', items: overview })

  // Review detail: counts by severity, then the findings themselves.
  if (evidence.review) {
    const findings = evidence.review.findings
    const at = `at or above "${evidence.review.minSeverity}"`
    blocks.push({ kind: 'heading', text: 'Code review' })
    blocks.push({ kind: 'paragraph', text: findings ? `Findings by severity: ${severityCounts(findings)} — ${evidence.review.blocking} blocking (${at}).` : `${evidence.review.blocking} blocking finding(s) (${at}); the review result file is no longer available, so per-severity counts are unknown.` })
    if (findings?.length) {
      const ordered = [...findings].sort((left, right) => REVIEW_SEVERITIES.indexOf(right.severity) - REVIEW_SEVERITIES.indexOf(left.severity))
      const { rows, more } = capped(ordered)
      blocks.push({ kind: 'table', header: ['severity', 'location', 'finding'], rows: [...rows.map((finding) => [finding.severity, finding.file ? oneLine(`${finding.file}${finding.line ? `:${finding.line}` : ''}`, 120) : '—', oneLine(finding.title)]), ...moreRow(more, 3)], drop: { label: 'review findings table', priority: options.brief ? 1 : 2 } })
    }
  }
  if (evidence.incompleteReasons.length) blocks.push({ kind: 'list', items: evidence.incompleteReasons.map((reason) => `INCOMPLETE: ${oneLine(reason)}`), drop: { label: 'incomplete-review reasons', priority: 2 } })

  if (evidence.checks?.length && !options.brief) {
    const { rows, more } = capped([...evidence.checks].sort((left, right) => Number(right.outcome !== 'success') - Number(left.outcome !== 'success')))
    blocks.push({ kind: 'heading', text: 'CI checks', drop: { label: 'CI check list', priority: 3 } })
    blocks.push({ kind: 'table', header: ['check', 'result', 'required'], rows: [...rows.map((check) => [oneLine(check.name, 120), check.outcome.toUpperCase(), check.required ? 'yes' : 'no']), ...moreRow(more, 3)], drop: { label: 'CI check list', priority: 3 } })
  }

  if (evidence.verify && !options.brief) {
    blocks.push({ kind: 'heading', text: 'Worker verify (verify.json)' })
    blocks.push({ kind: 'paragraph', text: `\`${oneLine(evidence.verify.command || 'command not recorded', 200)}\` → exit ${evidence.verify.exitCode ?? 'not recorded'}${evidence.verify.ranAt ? ` at ${oneLine(evidence.verify.ranAt, 40)}` : ''}` })
    if (evidence.verify.outcomes.length) blocks.push(proofTable(evidence.verify.outcomes, { label: 'verify outcome table', priority: 4 }))
    const tails = evidence.verify.outcomes.filter((outcome) => outcome.evidence.length > CELL_CHARS || outcome.evidence.includes('\n'))
    if (tails.length) blocks.push({ kind: 'code', text: tails.slice(0, 10).map((outcome) => `# ${outcome.id} (${label(outcome.status)})\n${tail(outcome.evidence)}`).join('\n\n'), drop: { label: 'verify output tails', priority: 5 } })
  }

  if (evidence.dod?.length) {
    blocks.push({ kind: 'heading', text: 'Definition of Done' })
    const shown = options.brief ? evidence.dod.filter((proof) => proof.status !== 'passed') : evidence.dod
    if (shown.length) blocks.push(proofTable(shown, { label: 'DoD table', priority: options.brief ? 1 : 3 }))
    else blocks.push({ kind: 'paragraph', text: 'Every item proven.' })
  }
  for (const [name, proofs] of [['Negative proofs', evidence.negativeProofs], ['Recovery proofs', evidence.recoveryProofs]] as const) {
    if (!proofs?.length || options.brief) continue
    blocks.push({ kind: 'heading', text: name, drop: { label: name.toLowerCase(), priority: 4 } })
    blocks.push(proofTable(proofs, { label: name.toLowerCase(), priority: 4 }))
  }

  if (unavailable.length) blocks.push({ kind: 'paragraph', text: `Unavailable or not recorded: ${unavailable.join(', ')}. Absent evidence is not a pass.` })
  return { blocks, ...(options.marker ? { marker: options.marker } : {}) }
}

import { splitLines, toPosix } from '@agentskit/cross-platform'
import { scanForPii } from '../kernel/pii.js'
import { REVIEW_SEVERITIES, type ReviewSeverity } from '../adapters/code-review.js'
import type { CommentBlock, CommentDocument } from './comment-format.js'
import type { Verdict } from './verdict.js'

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

export interface EvidenceProof {
  readonly id: string; readonly status: EvidenceStatus; readonly evidence: string
  /** The human-readable criterion (the frozen contract's outcome description, or the project DoD item). */
  readonly description?: string
  readonly list?: string
  /** ADR-0046: how far the item was verified; shown next to the status. */
  readonly verdict?: Verdict | null
}

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
  /** The tracker issue as fetched at completion. `null`/absent: not fetched or the fetch failed. */
  readonly issueInfo?: { readonly bug: boolean; readonly reproduction: string | null; readonly checklist: { readonly done: number; readonly total: number } | null } | null
  /** Paths the PR changed. `null`/absent: the host did not report them. */
  readonly changedFiles?: readonly string[] | null
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
/** The status cell: the status, and the verdict level when the item has one. */
const statusCell = (text: string, proof: EvidenceProof): string => proof.verdict ? `${text} (${proof.verdict})` : text
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
  // 'findings' means the review recorded some, even when the result file with their detail is gone.
  if (review.status === 'findings') return review.blocking > 0 ? 'REQUEST CHANGES' : 'COMMENT'
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
    rows: [...rows.map((proof) => [statusCell(label(proof.status), proof), ...(withList ? [oneLine(proof.list ?? '', 80)] : []), oneLine(proof.id, 80), oneLine(proof.evidence || (proof.status === 'missing' ? 'no proof recorded' : '—'))]), ...moreRow(more, header.length)],
  }
}

/** Counts per status, failing/missing/skipped/blocked first — the line a skimming reader needs. */
const tally = (proofs: readonly EvidenceProof[]): string => {
  const order: readonly EvidenceStatus[] = ['failed', 'blocked', 'missing', 'skipped', 'pending', 'passed']
  return order.map((status) => [status, proofs.filter((proof) => proof.status === status).length] as const).filter(([, count]) => count > 0).map(([status, count]) => `${count} ${status}`).join(', ') || 'no items'
}


/** Test files by path convention (`*.test.*`, `*.spec.*`, `test(s)/`, `__tests__/`, `*_test.go|py`, `test_*.py`). */
export const isTestFile = (path: string): boolean => /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]*\.py$/i.test(toPosix(path))

/** Case-insensitive: the issue carries at least one of the configured bug labels. */
export const isBugIssue = (labels: readonly string[], bugLabels: readonly string[]): boolean => labels.some((label) => bugLabels.some((bug) => bug.toLowerCase() === label.toLowerCase()))

const REPRO_HEADING = /^\s{0,3}(?:#{1,6}\s*|\*\*|__)?\s*(?:steps to reproduce|steps to repro|reproduction(?: steps)?|how to reproduce|repro(?: steps)?|passos para reproduzir|como reproduzir|reprodu[cç][aã]o)\b/i
const ANY_HEADING = /^\s{0,3}#{1,6}\s|^\s*(?:\*\*|__)[^*_\n]+(?:\*\*|__)\s*:?\s*$/

/** The reproduction section of an issue body: the lines after its heading up to the next heading, one line, truncated. `null`: none found. */
export const extractReproduction = (description: string, max = 500): string | null => {
  const lines = splitLines(description)
  const start = lines.findIndex((line) => REPRO_HEADING.test(line))
  if (start < 0) return null
  const body: string[] = []
  for (const line of lines.slice(start + 1)) { if (ANY_HEADING.test(line)) break; body.push(line) }
  const text = oneLine(body.join(' '), max)
  return text || null
}

/** Checked and total markdown checkboxes in an issue body. `null`: the issue has none. */
export const checklistState = (description: string): { readonly done: number; readonly total: number } | null => {
  const boxes = [...description.matchAll(/^\s*[-*]\s+\[( |x|X)\]\s+/gm)]
  return boxes.length ? { done: boxes.filter((box) => box[1] !== ' ').length, total: boxes.length } : null
}

// ponytail: test names are read from ✓/✔ lines in the worker's verify evidence (vitest/jest/mocha style); other runners show none.
const testNamesFrom = (outcomes: readonly EvidenceProof[]): readonly string[] =>
  [...new Set(outcomes.flatMap((outcome) => [...outcome.evidence.matchAll(/^\s*[✓✔√]\s+(.+?)(?:\s+\d+\s?ms)?\s*$/gm)].map((match) => oneLine(match[1]!, 160))))].slice(0, 8)

export type ResolutionVerdict = 'RESOLVED' | 'PARTIAL' | 'NOT PROVEN'

/** The acceptance criteria: the frozen contract's outcomes, as the DoD assessment saw them. */
const criteriaOf = (evidence: DeliveryEvidence): readonly EvidenceProof[] => evidence.dod?.filter((proof) => proof.list === 'issue') ?? []
const criterionLabel = (status: EvidenceStatus): string => status === 'missing' || status === 'pending' ? 'UNPROVEN' : label(status)

/**
 * Was the task resolved? Computed ONLY from recorded evidence — a merge alone never makes it RESOLVED. RESOLVED: at
 * least one criterion and every one proven. NOT PROVEN: none proven (or none recorded). PARTIAL: some proven, the
 * rest listed.
 */
export const resolutionVerdict = (evidence: DeliveryEvidence): { readonly verdict: ResolutionVerdict; readonly detail: string } => {
  const criteria = criteriaOf(evidence)
  const unproven = criteria.filter((proof) => proof.status !== 'passed')
  const list = unproven.slice(0, 10).map((proof) => `${oneLine(proof.id, 40)} (${criterionLabel(proof.status)})`).join(', ') + (unproven.length > 10 ? `, … ${unproven.length - 10} more` : '')
  const merged = evidence.merge ? ' The PR is merged, but a merge does not prove the task was resolved.' : ' The PR was not merged.'
  if (!criteria.length) return { verdict: 'NOT PROVEN', detail: `${evidence.dodSkipped ? `The ${evidence.dodSkipped}.` : 'No acceptance criteria or contract outcomes were recorded for this issue.'} Nothing shows the task was resolved.${evidence.merge ? ' A merge alone is not proof.' : ''}` }
  const proven = criteria.length - unproven.length
  if (!unproven.length) return { verdict: 'RESOLVED', detail: `${proven} of ${criteria.length} acceptance criteria proven by recorded evidence.${evidence.merge ? '' : ' The PR was not merged.'}` }
  return { verdict: proven ? 'PARTIAL' : 'NOT PROVEN', detail: `${proven} of ${criteria.length} acceptance criteria proven. Not proven: ${list}.${evidence.merge ? merged : ' The PR was not merged.'}` }
}

const criteriaTable = (evidence: DeliveryEvidence, criteria: readonly EvidenceProof[], drop: CommentBlock['drop']): CommentBlock => {
  const { rows, more } = capped(criteria)
  const ran = evidence.verify ? ` [verify \`${oneLine(evidence.verify.command || 'command not recorded', 80)}\` → exit ${evidence.verify.exitCode ?? 'not recorded'}]` : ''
  const proof = (item: EvidenceProof): string => {
    const ownVerify = (item.status === 'passed' || item.status === 'failed') && evidence.verify?.outcomes.some((outcome) => outcome.id === item.id)
    const text = oneLine(item.evidence)
    if (item.status === 'missing' || item.status === 'pending') return `no evidence recorded${text ? ` (${text})` : ''}`
    return `${text || '—'}${ownVerify ? ran : ''}`
  }
  return { kind: 'table', header: ['status', 'id', 'criterion', 'evidence'], ...(drop ? { drop } : {}), rows: [...rows.map((item) => [statusCell(criterionLabel(item.status), item), oneLine(item.id, 40), item.description ? oneLine(item.description, 200) : '—', proof(item)]), ...moreRow(more, 4)] }
}

export const buildEvidenceDocument = (evidence: DeliveryEvidence, options: EvidenceOptions): CommentDocument => {
  const blocks: CommentBlock[] = []
  const unavailable: string[] = []
  blocks.push({ kind: 'heading', text: oneLine(options.title, 200) })
  blocks.push({ kind: 'paragraph', text: clean(options.summary) })

  // Resolution: the verdict from recorded evidence, then the links a reader needs to check it.
  const { verdict, detail } = resolutionVerdict(evidence)
  const info = evidence.issueInfo
  const testFiles = (evidence.changedFiles ?? []).filter(isTestFile)
  blocks.push({ kind: 'heading', text: 'Resolution' })
  blocks.push({ kind: 'paragraph', text: `${verdict} — ${detail}${info?.bug && verdict === 'RESOLVED' ? ' Bug fix: see "Bug fix proof" — the regression test was not shown to fail before the fix.' : ''}` })
  const links: string[] = []
  if (evidence.pr) links.push(`PR: #${evidence.pr.number} ${evidence.pr.url}`)
  else { links.push('PR: none recorded'); unavailable.push('pull request') }
  if (evidence.merge) links.push(`Merged: ${evidence.merge.sha ? `\`${short(evidence.merge.sha)}\`` : 'merge commit not reported'} by ${evidence.merge.by === 'loop' ? 'the loop' : 'a person outside the loop — the loop\'s gates did not decide it'}`)
  else links.push('Merged: no')
  links.push(`Files changed: ${evidence.changedFiles ? evidence.changedFiles.length : 'unavailable'}`)
  if (info?.checklist) links.push(`Issue checklist (as fetched at completion): ${info.checklist.done}/${info.checklist.total} item(s) checked`)
  else if (info) links.push('Issue checklist: the issue has no checklist items')
  else unavailable.push('issue details (labels, checklist)')
  blocks.push({ kind: 'list', items: links })

  const criteria = criteriaOf(evidence)
  if (criteria.length) {
    const shown = options.brief ? criteria.filter((proof) => proof.status !== 'passed') : criteria
    blocks.push({ kind: 'heading', text: 'Acceptance criteria', drop: { label: 'acceptance criteria table', priority: 0 } })
    if (shown.length) blocks.push(criteriaTable(evidence, shown, { label: 'acceptance criteria table', priority: 0 }))
    else blocks.push({ kind: 'paragraph', text: 'Every criterion proven.', drop: { label: 'acceptance criteria table', priority: 0 } })
  }

  if (info?.bug) {
    const names = testNamesFrom(evidence.verify?.outcomes ?? [])
    const regression = evidence.changedFiles === null || evidence.changedFiles === undefined
      ? 'PR file list unavailable — cannot tell whether a regression test was added'
      : testFiles.length ? `${testFiles.slice(0, 10).map((file) => `\`${oneLine(file, 120)}\``).join(', ')}${testFiles.length > 10 ? ` (+${testFiles.length - 10} more)` : ''}${names.length ? `; passing tests named in the worker's verify output: ${names.map((name) => oneLine(name, 120)).join('; ')}` : ''}` : 'no regression test in this PR'
    const bugDrop = { label: 'bug fix proof', priority: 1 }
    blocks.push({ kind: 'heading', text: 'Bug fix proof', drop: bugDrop })
    blocks.push({ kind: 'list', drop: bugDrop, items: [
      `Reproduction (from the issue): ${info.reproduction ?? 'no reproduction steps found in the issue'}`,
      `Regression test(s) in this PR: ${regression}`,
      'Fails before / passes after: not demonstrated: regression test not verified to fail before the fix.',
    ] })
  }

  // Overview: one line per gate, each with an explicit state.
  const overview: string[] = []
  overview.push(`Head: ${evidence.head ? `\`${short(evidence.head)}\`` : 'unknown'}`)
  if (evidence.review) {
    const headNote = evidence.head === null ? ' — final head unknown, cannot confirm it was reviewed' : evidence.review.head === evidence.head ? '' : ' — NOT the final head; the final head was not reviewed by the loop'
    overview.push(`Code review: ${reviewVerdict(evidence.review)} at \`${short(evidence.review.head)}\`${headNote} (${evidence.review.provider}${evidence.review.model ? `/${evidence.review.model}` : ''}, ${evidence.review.attempts} attempt(s))`)
  } else if (evidence.reviewSkipped) overview.push(`Code review: SKIPPED — ${oneLine(evidence.reviewSkipped)}`)
  else { overview.push('Code review: no review recorded'); unavailable.push('code review') }
  overview.push(`Unresolved review threads: ${evidence.unresolvedThreads === null ? 'unavailable' : evidence.unresolvedThreads}`)
  if (evidence.unresolvedThreads === null) unavailable.push('review threads')
  if (evidence.checks?.length) {
    const passed = evidence.checks.filter((check) => check.outcome === 'success').length
    const pending = evidence.checks.filter((check) => check.outcome === 'pending').length
    const skipped = evidence.checks.filter((check) => check.outcome === 'skipped' || check.outcome === 'neutral').length
    // Only `success` is a pass; any other outcome (cancelled, timed_out, action_required, …) that is not pending or skipped counts as failed.
    const failing = evidence.checks.length - passed - pending - skipped
    overview.push(`CI: ${evidence.checks.length} check(s) — ${passed} passed, ${failing} failed, ${pending} pending, ${skipped} skipped/neutral${evidence.checksGating ? '' : ' (not gating for this flow)'}`)
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
  if (evidence.spend) overview.push(`Tokens (loop-side calls; the worker CLI does not report its own): ${evidence.spend.calls ? `${evidence.spend.totalTokens.toLocaleString('en-US')} over ${evidence.spend.calls} recorded call(s)` : 'none recorded'}${evidence.spend.ceiling ? ` of a ${evidence.spend.ceiling.toLocaleString('en-US')} per-issue ceiling` : ''}${evidence.spend.usageDeltaPercent === null ? '' : `; worker provider usage ${evidence.spend.usageDeltaPercent < 0 ? '+' : '−'}${Math.abs(evidence.spend.usageDeltaPercent).toFixed(1)} pts since dispatch`}`)
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

  const projectDod = (evidence.dod ?? []).filter((proof) => proof.list !== 'issue')
  if (projectDod.length) {
    blocks.push({ kind: 'heading', text: 'Definition of Done (project)' })
    const shown = options.brief ? projectDod.filter((proof) => proof.status !== 'passed') : projectDod
    if (shown.length) blocks.push(proofTable(shown.map((proof) => ({ id: proof.id, status: proof.status, evidence: proof.evidence })), { label: 'DoD table', priority: options.brief ? 1 : 3 }))
    else blocks.push({ kind: 'paragraph', text: 'Every project item proven.' })
  }
  for (const [name, proofs] of [['Negative proofs', evidence.negativeProofs], ['Recovery proofs', evidence.recoveryProofs]] as const) {
    if (!proofs?.length || options.brief) continue
    blocks.push({ kind: 'heading', text: name, drop: { label: name.toLowerCase(), priority: 4 } })
    blocks.push(proofTable(proofs, { label: name.toLowerCase(), priority: 4 }))
  }

  if (unavailable.length) blocks.push({ kind: 'paragraph', text: `Unavailable or not recorded: ${unavailable.join(', ')}. Absent evidence is not a pass.` })
  return { blocks, ...(options.marker ? { marker: options.marker } : {}) }
}

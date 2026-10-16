import { describe, expect, it } from 'vitest'
import { buildEvidenceDocument, reviewVerdict, type DeliveryEvidence } from '../src/loop/evidence.js'
import { DEFAULT_COMMENT_OPTIONS, fitComment, renderComment, type CommentDocument } from '../src/loop/comment-format.js'

const HEAD = 'c74d687ee59927dbbe2972649d7b58dbad16bcd0'

const full = (over: Partial<DeliveryEvidence> = {}): DeliveryEvidence => ({
  issue: 'ENG-10',
  pr: { number: 42, url: 'https://github.com/o/r/pull/42', title: 'feat: demo' },
  merge: { sha: 'deadbeefcafe0123456789', by: 'loop' },
  head: HEAD,
  worker: { provider: 'claude', model: 'sonnet' },
  review: { head: HEAD, status: 'clean', provider: 'codex-cli', model: 'gpt-5.6', attempts: 1, minSeverity: 'med', blocking: 0, findings: [{ severity: 'nit', file: 'src/a.ts', line: 3, title: 'Name could be clearer' }] },
  incompleteReasons: [],
  unresolvedThreads: 0,
  verify: { command: 'pnpm test', exitCode: 0, ranAt: '2026-09-11T11:50:00.000Z', outcomes: [{ id: 'O1', status: 'passed', evidence: 'Tests 120 passed (120)' }, { id: 'O2', status: 'failed', evidence: 'line 1\nline 2\nexpected 2, got 3' }] },
  harnessVerify: { command: 'pnpm typecheck', status: 'passed', head: HEAD },
  dod: [{ id: 'tests', list: 'project', status: 'passed', evidence: 'vitest: 120 passed' }, { id: 'O1', list: 'issue', status: 'passed', evidence: 'Tests 120 passed' }],
  negativeProofs: [{ id: 'rejects-empty', status: 'passed', evidence: 'POST /x with {} → 400' }],
  recoveryProofs: null,
  checks: [{ name: 'ci', outcome: 'success', required: true }, { name: 'lint', outcome: 'skipped', required: false }],
  checksGating: true,
  fixRounds: { counted: 1, limit: 3, byKind: { review: 1, ci: 0 } },
  handoffs: [],
  elapsedMs: 2 * 60 * 60_000 + 14 * 60_000,
  spend: { totalTokens: 184_220, calls: 3, ceiling: 2_000_000, usageDeltaPercent: 4.5 },
  runId: 'ENG-10-1',
  ...over,
})

const md = (evidence: DeliveryEvidence, brief = false): string => renderComment(buildEvidenceDocument(evidence, { title: 'Loop: merged', summary: 'https://github.com/o/r/pull/42 after a clean review and green checks.', marker: 'loop:merged:42', brief }), 'markdown')

describe('delivery evidence comment', () => {
  it('renders every gate with its result, the review verdict, counts by severity, and the dedupe marker', () => {
    const body = md(full())
    expect(body.startsWith('**Loop: merged**')).toBe(true)
    expect(body).toContain('Merged: `deadbeefcafe` by the loop')
    expect(body).toContain(`Code review: COMMENT at \`${HEAD.slice(0, 12)}\` (codex-cli/gpt-5.6, 1 attempt(s))`)
    expect(body).toContain('Findings by severity: blocker 0, high 0, med 0, nit 1 — 0 blocking (at or above "med")')
    expect(body).toContain('Unresolved review threads: 0')
    expect(body).toContain('CI: 2 check(s) — 1 passed, 0 failed, 0 pending, 1 skipped/neutral')
    expect(body).toContain('| ci | SUCCESS | yes |')
    expect(body).toContain('| lint | SKIPPED | no |')
    expect(body).toContain('Harness verify `pnpm typecheck`: PASSED')
    expect(body).toContain('Worker verify: exit 0 — 1 failed, 1 passed')
    expect(body).toContain('`pnpm test` → exit 0')
    expect(body).toContain('| FAILED | O2 | line 1 line 2 expected 2, got 3 |')
    expect(body).toContain('# O2 (FAILED)\nline 1\nline 2')
    expect(body).toContain('Definition of Done: 2 passed')
    expect(body).toContain('| PASSED | rejects-empty | POST /x with {} → 400 |')
    expect(body).toContain('**Negative proofs**')
    expect(body).toContain('Fix rounds: 1/3 (nudges: review 1)')
    expect(body).toContain('Elapsed: 2h 14m')
    expect(body).toContain('Tokens (loop-side calls; the worker CLI does not report its own): 184,220 over 3 recorded call(s) of a 2,000,000 per-issue ceiling; worker provider usage −4.5 pts since dispatch')
    expect(body).toContain('Run: `ENG-10-1`')
    expect(body).not.toContain('Unavailable or not recorded')
    expect(body.endsWith('<!-- loop:merged:42 -->')).toBe(true)
  })

  it('maps the review state to the verdict a reviewer would give', () => {
    const review = full().review!
    expect(reviewVerdict({ ...review, findings: [] })).toBe('APPROVE')
    expect(reviewVerdict(review)).toBe('COMMENT')
    expect(reviewVerdict({ ...review, status: 'findings', blocking: 2 })).toBe('REQUEST CHANGES')
    expect(reviewVerdict({ ...review, status: 'incomplete' })).toBe('INCOMPLETE')
  })

  it('never shows a skipped or blocked gate as passed', () => {
    const body = md(full({
      review: null, reviewSkipped: 'review phase off for this flow',
      harnessVerify: { command: 'pnpm typecheck', status: 'skipped', head: null },
      dod: [{ id: 'e2e', list: 'project', status: 'skipped', evidence: 'no browser in CI' }, { id: 'O1', list: 'issue', status: 'blocked', evidence: 'staging down' }, { id: 'O2', list: 'issue', status: 'missing', evidence: '' }],
      checksGating: false,
    }))
    expect(body).toContain('Code review: SKIPPED — review phase off for this flow')
    expect(body).toContain('Harness verify `pnpm typecheck`: SKIPPED')
    expect(body).toContain('Definition of Done: 1 blocked, 1 missing, 1 skipped')
    expect(body).toContain('| SKIPPED | project | e2e | no browser in CI |')
    expect(body).toContain('| BLOCKED | issue | O1 | staging down |')
    expect(body).toContain('| MISSING | issue | O2 | no proof recorded |')
    expect(body).toContain('(not gating for this flow)')
    expect(body).not.toMatch(/PASSED \| (project|issue) \| (e2e|O1|O2)/)
  })

  it('says what is missing instead of crashing when nothing was recorded', () => {
    const body = md(full({ pr: null, merge: null, head: null, worker: null, review: null, unresolvedThreads: null, verify: null, harnessVerify: null, dod: null, negativeProofs: null, checks: null, fixRounds: { counted: 0, limit: null, byKind: {} }, elapsedMs: null, spend: null, runId: null }))
    expect(body).toContain('PR: none recorded')
    expect(body).toContain('Code review: no review recorded')
    expect(body).toContain('Unresolved review threads: unavailable')
    expect(body).toContain('CI: no checks reported — not run or unavailable')
    expect(body).toContain('Worker verify (verify.json): no evidence recorded')
    expect(body).toContain('Definition of Done: no evidence recorded')
    expect(body).toContain('Tokens: not recorded')
    expect(body).toContain('Unavailable or not recorded: pull request, code review, review threads, CI checks, verify.json, definition of done, token spend. Absent evidence is not a pass.')
  })

  it('assembles a merge made outside the loop from what exists, and flags an unreviewed final head', () => {
    const body = md(full({ merge: { sha: null, by: 'outside' }, review: { ...full().review!, head: 'aaaaaaaaaaaa1111' }, verify: null, dod: null }))
    expect(body).toContain('Merged: merge commit not reported by a person outside the loop — the loop\'s gates did not decide it')
    expect(body).toContain('at `aaaaaaaaaaaa` — NOT the final head; the final head was not reviewed by the loop')
    expect(body).toContain('Unavailable or not recorded: verify.json, definition of done.')
  })

  it('redacts tokens and emails, including inside URLs, in every free-text field', () => {
    const body = md(full({
      verify: { command: 'curl https://x-access-token:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/o/r', exitCode: 1, ranAt: null, outcomes: [{ id: 'O1', status: 'failed', evidence: 'mailto https://example.com/u/jane.doe@corp.example.com/profile\nsk-proj-abcdefghijklmnopqrstuvwxyz' }] },
      incompleteReasons: ['auth failed for ops@corp.example.com'],
    }))
    expect(body).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123')
    expect(body).not.toContain('jane.doe@corp.example.com')
    expect(body).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz')
    expect(body).not.toContain('ops@corp.example.com')
    expect(body).toContain('[REDACTED:api-key]')
    expect(body).toContain('[REDACTED:email]')
  })

  it('fits the tracker limit by dropping detail first, says what was cut, and keeps the marker', () => {
    const many = Array.from({ length: 200 }, (_, index) => ({ id: `O${index}`, status: 'passed' as const, evidence: `${'x'.repeat(250)}\n${'y'.repeat(600)}` }))
    const document = buildEvidenceDocument(full({ verify: { command: 'pnpm test', exitCode: 0, ranAt: null, outcomes: many }, dod: many }), { title: 'Loop: merged', summary: 'merged', marker: 'loop:merged:42' })
    const untouched = renderComment(document, 'markdown')
    expect(untouched.length).toBeGreaterThan(8_000)
    const fitted = fitComment(document, { format: 'markdown', maxChars: 8_000 })
    expect(fitted.length).toBeLessThanOrEqual(8_000)
    expect(fitted).toContain('Truncated to fit this tracker\'s 8000-character comment limit. Omitted: verify output tails')
    expect(fitted).toContain('Code review: COMMENT')
    expect(fitted.endsWith('<!-- loop:merged:42 -->')).toBe(true)
    // Within the limit nothing is cut.
    expect(fitComment(document, DEFAULT_COMMENT_OPTIONS)).toBe(untouched)
    // A core that alone exceeds the limit is still cut to it, marker intact.
    const huge: CommentDocument = { blocks: [{ kind: 'heading', text: 'h'.repeat(5_000) }, { kind: 'paragraph', text: 'p'.repeat(5_000) }], marker: 'loop:merged:42' }
    const cut = fitComment(huge, { format: 'markdown', maxChars: 1_000 })
    expect(cut.length).toBeLessThanOrEqual(1_000)
    expect(cut).toContain('Omitted: later sections')
    expect(cut.endsWith('<!-- loop:merged:42 -->')).toBe(true)
  })

  it('renders through the connector\'s format: plain text drops markup and the hidden marker; a custom renderer is used as-is', () => {
    const document = buildEvidenceDocument(full(), { title: 'Loop: merged', summary: 'merged', marker: 'loop:merged:42' })
    const plain = fitComment(document, { format: 'plain', maxChars: 32_000 })
    expect(plain.startsWith('LOOP: MERGED')).toBe(true)
    expect(plain).not.toContain('<!--')
    expect(plain).not.toContain('**')
    expect(plain).toContain('Harness verify pnpm typecheck: PASSED')
    const adf = fitComment(document, { format: 'plain', maxChars: 32_000, render: (doc) => JSON.stringify({ version: 1, type: 'doc', content: doc.blocks.map((block) => ({ type: block.kind })) }) })
    expect(JSON.parse(adf)).toMatchObject({ type: 'doc', content: expect.arrayContaining([{ type: 'heading' }, { type: 'table' }]) })
  })

  it('keeps escalation evidence brief: findings and DoD gaps, no CI table or output tails', () => {
    const body = md(full({ review: { ...full().review!, status: 'findings', blocking: 1, findings: [{ severity: 'high', file: 'src/a.ts', line: 9, title: 'Null deref' }] }, dod: [{ id: 'tests', list: 'project', status: 'passed', evidence: 'ok' }, { id: 'O1', list: 'issue', status: 'missing', evidence: '' }] }), true)
    expect(body).toContain('Code review: REQUEST CHANGES')
    expect(body).toContain('| high | src/a.ts:9 | Null deref |')
    expect(body).toContain('| MISSING | issue | O1 |')
    expect(body).not.toContain('| PASSED | project | tests |')
    expect(body).not.toContain('**CI checks**')
    expect(body).not.toContain('**Worker verify (verify.json)**')
  })
})

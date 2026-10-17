import { describe, expect, it } from 'vitest'
import { buildEvidenceDocument, checklistState, extractReproduction, isBugIssue, isTestFile, resolutionVerdict, reviewVerdict, type DeliveryEvidence } from '../src/loop/evidence.js'
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
  dod: [{ id: 'tests', list: 'project', status: 'passed', evidence: 'vitest: 120 passed' }, { id: 'O1', list: 'issue', description: 'Orders can be exported as CSV', status: 'passed', evidence: 'Tests 120 passed' }],
  negativeProofs: [{ id: 'rejects-empty', status: 'passed', evidence: 'POST /x with {} → 400' }],
  recoveryProofs: null,
  checks: [{ name: 'ci', outcome: 'success', required: true }, { name: 'lint', outcome: 'skipped', required: false }],
  checksGating: true,
  fixRounds: { counted: 1, limit: 3, byKind: { review: 1, ci: 0 } },
  handoffs: [],
  elapsedMs: 2 * 60 * 60_000 + 14 * 60_000,
  spend: { totalTokens: 184_220, calls: 3, ceiling: 2_000_000, usageDeltaPercent: 4.5 },
  runId: 'ENG-10-1',
  issueInfo: { bug: false, reproduction: null, checklist: { done: 2, total: 3 } },
  changedFiles: ['src/export.ts', 'test/export.test.ts'],
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
      dod: [{ id: 'e2e', list: 'project', status: 'skipped', evidence: 'no browser in CI' }, { id: 'O1', list: 'issue', description: 'Login works', status: 'blocked', evidence: 'staging down' }, { id: 'O2', list: 'issue', description: 'Logout clears the session', status: 'missing', evidence: '' }],
      checksGating: false,
    }))
    expect(body).toContain('Code review: SKIPPED — review phase off for this flow')
    expect(body).toContain('Harness verify `pnpm typecheck`: SKIPPED')
    expect(body).toContain('Definition of Done: 1 blocked, 1 missing, 1 skipped')
    expect(body).toContain('| SKIPPED | e2e | no browser in CI |')
    expect(body).toContain('| BLOCKED | O1 | Login works | staging down |')
    expect(body).toContain('| UNPROVEN | O2 | Logout clears the session | no evidence recorded |')
    expect(body).toContain('(not gating for this flow)')
    expect(body).not.toMatch(/PASSED \| (e2e|O1 \| Login|O2 \| Logout)/)
    expect(body).toContain('NOT PROVEN — 0 of 2 acceptance criteria proven. Not proven: O1 (BLOCKED), O2 (UNPROVEN).')
  })

  it('says what is missing instead of crashing when nothing was recorded', () => {
    const body = md(full({ pr: null, merge: null, head: null, worker: null, review: null, unresolvedThreads: null, verify: null, harnessVerify: null, dod: null, negativeProofs: null, checks: null, fixRounds: { counted: 0, limit: null, byKind: {} }, elapsedMs: null, spend: null, runId: null, issueInfo: null, changedFiles: null }))
    expect(body).toContain('PR: none recorded')
    expect(body).toContain('Code review: no review recorded')
    expect(body).toContain('Unresolved review threads: unavailable')
    expect(body).toContain('CI: no checks reported — not run or unavailable')
    expect(body).toContain('Worker verify (verify.json): no evidence recorded')
    expect(body).toContain('Definition of Done: no evidence recorded')
    expect(body).toContain('Tokens: not recorded')
    expect(body).toContain('Unavailable or not recorded: pull request, issue details (labels, checklist), code review, review threads, CI checks, verify.json, definition of done, token spend. Absent evidence is not a pass.')
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
      review: { ...full().review!, status: 'incomplete' },
      incompleteReasons: ['auth failed for ops@corp.example.com'],
    }))
    expect(body).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123')
    expect(body).not.toContain('jane.doe@corp.example.com')
    expect(body).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz')
    expect(body).not.toContain('ops@corp.example.com')
    expect(body).toContain('auth failed for [REDACTED:email]')
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
    const body = md(full({ review: { ...full().review!, status: 'findings', blocking: 1, findings: [{ severity: 'high', file: 'src/a.ts', line: 9, title: 'Null deref' }] }, dod: [{ id: 'tests', list: 'project', status: 'passed', evidence: 'ok' }, { id: 'O1', list: 'issue', description: 'Orders can be exported as CSV', status: 'missing', evidence: '' }] }), true)
    expect(body).toContain('Code review: REQUEST CHANGES')
    expect(body).toContain('| high | src/a.ts:9 | Null deref |')
    expect(body).toContain('| UNPROVEN | O1 | Orders can be exported as CSV |')
    expect(body).not.toContain('| PASSED | project | tests |')
    expect(body).not.toContain('**CI checks**')
    expect(body).not.toContain('| ci | SUCCESS |')
    expect(body).not.toContain('# O2 (FAILED)')
    expect(body).not.toContain('**Worker verify (verify.json)**')
  })

  describe('resolution: was the task resolved, and how do we know', () => {
    const criterion = (id: string, status: 'passed' | 'failed' | 'skipped' | 'blocked' | 'missing', description = `criterion ${id}`, evidence = status === 'missing' ? '' : `proof ${id}`) => ({ id, list: 'issue', description, status, evidence })

    it('RESOLVED only when every criterion is proven; PARTIAL lists the rest; NOT PROVEN when none is', () => {
      const resolved = md(full({ dod: [criterion('o1', 'passed'), criterion('o2', 'passed')] }))
      expect(resolved).toContain('**Resolution**\n\nRESOLVED — 2 of 2 acceptance criteria proven by recorded evidence.')
      expect(resolved.indexOf('**Resolution**')).toBeLessThan(resolved.indexOf('PR: #42'))
      const partial = md(full({ dod: [criterion('o1', 'passed'), criterion('o2', 'skipped'), criterion('o3', 'missing'), criterion('o4', 'failed')] }))
      expect(partial).toContain('PARTIAL — 1 of 4 acceptance criteria proven. Not proven: o2 (SKIPPED), o3 (UNPROVEN), o4 (FAILED).')
      expect(partial).not.toContain('RESOLVED —')
      expect(md(full({ dod: [criterion('o1', 'blocked')] }))).toContain('NOT PROVEN — 0 of 1 acceptance criteria proven. Not proven: o1 (BLOCKED).')
    })

    it('never infers RESOLVED from a merge: no recorded criteria says so plainly', () => {
      expect(md(full({ dod: null }))).toContain('NOT PROVEN — No acceptance criteria or contract outcomes were recorded for this issue. Nothing shows the task was resolved. A merge alone is not proof.')
      expect(md(full({ dod: [], issueInfo: null }))).toContain('NOT PROVEN')
      expect(md(full({ dod: null, dodSkipped: 'definition-of-done phase off for this flow' }))).toContain('NOT PROVEN — The definition-of-done phase off for this flow.')
      expect(md(full({ dod: [criterion('o1', 'missing')] }))).toContain('The PR is merged, but a merge does not prove the task was resolved.')
      expect(resolutionVerdict(full({ dod: [criterion('o1', 'passed')], merge: null })).detail).toContain('The PR was not merged.')
      // Project-list items alone are not acceptance criteria.
      expect(resolutionVerdict(full({ dod: [{ id: 'tests', list: 'project', status: 'passed', evidence: 'ok' }] })).verdict).toBe('NOT PROVEN')
    })

    it('maps each criterion id to its text, status and evidence, with the verify command and exit code; unproven ones are listed', () => {
      const body = md(full({ dod: [criterion('o1', 'passed', 'Orders can be exported as CSV', 'Tests 120 passed (120)'), criterion('o2', 'missing', 'Export is rate limited')] }))
      expect(body).toContain('**Acceptance criteria**')
      expect(body).toContain('| status | id | criterion | evidence |')
      expect(body).toContain('| PASSED | o1 | Orders can be exported as CSV | Tests 120 passed (120) |')
      expect(body).toContain('| UNPROVEN | o2 | Export is rate limited | no evidence recorded |')
      const withVerify = md(full({ dod: [criterion('O1', 'passed', 'Orders can be exported as CSV', 'Tests 120 passed')] }))
      expect(withVerify).toContain('| PASSED | O1 | Orders can be exported as CSV | Tests 120 passed [verify `pnpm test` → exit 0] |')
    })

    it('shows links: PR, merged sha, files changed, and the issue checklist state', () => {
      const body = md(full())
      expect(body).toContain('- PR: #42 https://github.com/o/r/pull/42')
      expect(body).toContain('- Merged: `deadbeefcafe` by the loop')
      expect(body).toContain('- Files changed: 2')
      expect(body).toContain('- Issue checklist (as fetched at completion): 2/3 item(s) checked')
      expect(md(full({ changedFiles: null }))).toContain('Files changed: unavailable')
      expect(md(full({ issueInfo: { bug: false, reproduction: null, checklist: null } }))).toContain('Issue checklist: the issue has no checklist items')
    })

    it('adds a bug fix proof block only for a bug: repro steps, regression tests from the PR files, and what is not demonstrated', () => {
      const bug = { bug: true, reproduction: 'Open /orders, click Export, the file is empty.', checklist: null }
      const withTest = md(full({ issueInfo: bug, changedFiles: ['src/export.ts', 'test/export.test.ts'], verify: { command: 'pnpm test', exitCode: 0, ranAt: null, outcomes: [{ id: 'O1', status: 'passed', evidence: ' ✓ exports a non-empty file 12ms\n ✓ keeps the header row' }] } }))
      expect(withTest).toContain('**Bug fix proof**')
      expect(withTest).toContain('Reproduction (from the issue): Open /orders, click Export, the file is empty.')
      expect(withTest).toContain('Regression test(s) in this PR: `test/export.test.ts`; passing tests named in the worker\'s verify output: exports a non-empty file; keeps the header row')
      expect(withTest).toContain('Fails before / passes after: not demonstrated: regression test not verified to fail before the fix.')
      expect(withTest).not.toContain('no regression test in this PR')
      const without = md(full({ issueInfo: bug, changedFiles: ['src/export.ts'] }))
      expect(without).toContain('Regression test(s) in this PR: no regression test in this PR')
      expect(without).toContain('not demonstrated: regression test not verified to fail before the fix')
      expect(md(full({ issueInfo: bug, changedFiles: null }))).toContain('PR file list unavailable — cannot tell whether a regression test was added')
      expect(md(full({ issueInfo: { ...bug, reproduction: null } }))).toContain('Reproduction (from the issue): no reproduction steps found in the issue')
      // A RESOLVED bug verdict still says the regression was not shown to fail first.
      expect(md(full({ issueInfo: bug }))).toContain('RESOLVED — 1 of 1 acceptance criteria proven by recorded evidence. Bug fix: see "Bug fix proof" — the regression test was not shown to fail before the fix.')
      expect(md(full())).not.toContain('Bug fix proof')
    })

    it('redacts secrets in the reproduction steps and the criterion text', () => {
      const body = md(full({ issueInfo: { bug: true, reproduction: extractReproduction('## Steps to reproduce\nlogin as ops@corp.example.com'), checklist: null }, dod: [criterion('o1', 'passed', 'notify ops@corp.example.com')] }))
      expect(body).not.toContain('ops@corp.example.com')
    })

    it('keeps the verdict and the criteria table when the comment is cut to fit; detail goes first', () => {
      const project = Array.from({ length: 40 }, (_, index) => ({ id: `p${index}`, list: 'project', status: 'passed' as const, evidence: 'x'.repeat(250) }))
      const document = buildEvidenceDocument(full({ dod: [...project, criterion('c0', 'passed', 'Orders can be exported as CSV', 'ok'), criterion('c1', 'skipped', 'Export is rate limited', 'needs staging')], verify: { command: 'pnpm test', exitCode: 0, ranAt: null, outcomes: project.map((item) => ({ id: item.id, status: item.status, evidence: `${item.evidence}\n${'y'.repeat(500)}` })) } }), { title: 'Loop: merged', summary: 'merged', marker: 'loop:merged:42' })
      const fitted = fitComment(document, { format: 'markdown', maxChars: 4_000 })
      expect(fitted.length).toBeLessThanOrEqual(4_000)
      expect(fitted).toContain('Truncated to fit')
      expect(fitted).toContain('PARTIAL — 1 of 2 acceptance criteria proven. Not proven: c1 (SKIPPED).')
      expect(fitted).toContain('| SKIPPED | c1 | Export is rate limited | needs staging |')
      expect(fitted.endsWith('<!-- loop:merged:42 -->')).toBe(true)
      // Even a tracker limit smaller than the whole core keeps the verdict, which sits at the top.
      const tiny = fitComment(document, { format: 'markdown', maxChars: 600 })
      expect(tiny.length).toBeLessThanOrEqual(600)
      expect(tiny).toContain('PARTIAL')
    })

    it('parses the issue: reproduction section, bug labels (case-insensitive), checklist, test files', () => {
      expect(extractReproduction('Intro\n\n## Steps to reproduce\n1. open\n2. click\n\n## Expected\nfine')).toBe('1. open 2. click')
      expect(extractReproduction('**Steps to reproduce**\n1. a\n**Expected**\nx')).toBe('1. a')
      expect(extractReproduction(`## Steps to reproduce\n${'z'.repeat(2_000)}`)!.length).toBeLessThanOrEqual(500)
      expect(extractReproduction('no such section')).toBeNull()
      expect(extractReproduction('## Reproduction\n')).toBeNull()
      expect(isBugIssue(['bug'], ['Bug', 'type:bug'])).toBe(true)
      expect(isBugIssue(['Type:Fix'], ['Bug', 'type:fix'])).toBe(true)
      expect(isBugIssue(['feature'], ['Bug'])).toBe(false)
      expect(checklistState('- [x] a\n- [ ] b\n* [X] c')).toEqual({ done: 2, total: 3 })
      expect(checklistState('nothing')).toBeNull()
      expect(['src/a.test.ts', 'test/a.ts', 'pkg/__tests__/a.ts', 'a_test.go', 'tests\\a.py', 'x/test_a.py', 'src/b.spec.tsx'].every(isTestFile)).toBe(true)
      expect(['src/latest.ts', 'src/contest/a.ts', 'docs/testing.md'].some(isTestFile)).toBe(false)
    })
  })

  it('never reports an unlisted CI outcome as passed, and a findings review without its detail as clean', () => {
    const body = md(full({ checks: [{ name: 'ci', outcome: 'success', required: true }, { name: 'e2e', outcome: 'cancelled', required: false }] }))
    expect(body).toContain('2 check(s) — 1 passed, 1 failed')
    expect(reviewVerdict({ ...full().review!, status: 'findings', blocking: 0, findings: null })).toBe('COMMENT')
  })

  it('shortens an oversized headline until the rendered body fits, on code points', () => {
    const fitted = fitComment({ blocks: [{ kind: 'heading', text: 'ß🙂'.repeat(400) }], marker: 'loop:merged:1' }, { format: 'markdown', maxChars: 300 })
    expect(fitted.length).toBeLessThanOrEqual(300)
    expect(fitted).toContain('<!-- loop:merged:1 -->')
    expect(fitted).toContain('ß🙂')
    expect(fitted).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
  })
})

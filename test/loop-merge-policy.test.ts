import { describe, expect, it } from 'vitest'
import { decideMerge, weakestVerdict, type MergeDecision, type MergePolicyInput } from '../src/loop/merge-policy.js'

const ready: MergePolicyInput = {
  verdicts: [{ id: 'o1', verdict: 'unit-verified' }],
  minVerdict: 'unit-verified',
  patch: { verified: 'aaa', current: 'aaa' },
  checks: { gating: true, status: 'green' },
  review: { required: true, status: 'clean', blocking: 0 },
  heldPaths: { protectedFiles: [], protectedApproved: false, secretFiles: [], boundary: null },
  autonomy: 'autonomous',
  autoMerge: true,
  humanApproval: { required: false, given: false },
  vouchedBy: ['CI', 'the review'],
  escalation: { onBlockedVerdict: true },
}

const merge: MergeDecision = { action: 'merge' }
const hold = (reason: string | RegExp) => ({ action: 'hold', reason: expect.stringMatching(reason) })
const escalate = (reason: string | RegExp) => ({ action: 'escalate', reason: expect.stringMatching(reason) })

const cases: readonly { readonly name: string; readonly change: Partial<MergePolicyInput>; readonly expected: unknown }[] = [
  { name: 'everything proven, green and clean merges', change: {}, expected: merge },
  { name: 'a stronger verdict than the minimum merges', change: { verdicts: [{ id: 'o1', verdict: 'live-verified' }] }, expected: merge },
  { name: 'no definition-of-done items is not a verdict problem', change: { verdicts: [], patch: { verified: null, current: null } }, expected: merge },
  { name: 'nit-only findings (nothing blocking) merge', change: { review: { required: true, status: 'findings', blocking: 0 } }, expected: merge },
  { name: 'a review turned off by the flow merges while something else vouches', change: { review: { required: false, status: null, blocking: 0 }, vouchedBy: ['CI'] }, expected: merge },
  { name: 'failing CI that the flow does not gate on merges', change: { checks: { gating: false, status: 'red' } }, expected: merge },
  { name: 'protected paths a person approved for this head merge', change: { heldPaths: { protectedFiles: ['.github/x.yml'], protectedApproved: true, secretFiles: [], boundary: null } }, expected: merge },
  { name: 'human approval required and given merges', change: { humanApproval: { required: true, given: true } }, expected: merge },
  { name: 'unknown current patch-id is not stale', change: { patch: { verified: 'aaa', current: null } }, expected: merge },

  { name: 'a verdict below the minimum holds', change: { verdicts: [{ id: 'o1', verdict: 'type-check-only' }] }, expected: hold('below unit-verified: o1 \\(type-check-only\\)') },
  { name: 'unit-verified is below a live-verified minimum', change: { minVerdict: 'live-verified' }, expected: hold('below live-verified') },
  { name: 'a failed verdict holds', change: { verdicts: [{ id: 'o1', verdict: 'failed' }] }, expected: hold('o1 \\(failed\\)') },
  { name: 'an item with no verdict recorded holds', change: { verdicts: [{ id: 'o1', verdict: null }] }, expected: hold('o1 \\(none recorded\\)') },
  { name: 'the weakest of several items decides', change: { verdicts: [{ id: 'o1', verdict: 'live-verified' }, { id: 'o2', verdict: 'type-check-only' }] }, expected: hold('o2') },
  { name: 'verdicts made on a different patch hold', change: { patch: { verified: 'aaa', current: 'bbb' } }, expected: hold('different patch') },
  { name: 'a blocked verdict escalates', change: { verdicts: [{ id: 'o1', verdict: 'blocked' }] }, expected: escalate('o1') },
  { name: 'a blocked verdict holds when escalation is off (it is below the minimum)', change: { verdicts: [{ id: 'o1', verdict: 'blocked' }], escalation: { onBlockedVerdict: false } }, expected: hold('o1 \\(blocked\\)') },
  { name: 'escalation outranks every hold', change: { verdicts: [{ id: 'o1', verdict: 'blocked' }], autonomy: 'supervised', checks: { gating: true, status: 'red' } }, expected: escalate('blocked') },
  { name: 'protected paths nobody approved hold', change: { heldPaths: { protectedFiles: ['a', 'b'], protectedApproved: false, secretFiles: [], boundary: null } }, expected: hold('protected paths: a, b') },
  { name: 'secret-shaped files hold even when approved', change: { heldPaths: { protectedFiles: [], protectedApproved: true, secretFiles: ['.env'], boundary: null } }, expected: hold('secret-shaped file\\(s\\): \\.env') },
  { name: 'an enforced layer boundary holds', change: { heldPaths: { protectedFiles: [], protectedApproved: false, secretFiles: [], boundary: 'touches packages/b' } }, expected: hold('outside its layer boundary — touches packages/b') },
  { name: 'an incomplete review holds', change: { review: { required: true, status: 'incomplete', blocking: 0 } }, expected: hold('review is not clean') },
  { name: 'a blocking finding holds', change: { review: { required: true, status: 'findings', blocking: 2 } }, expected: hold('2 blocking') },
  { name: 'a required review that never ran holds', change: { review: { required: true, status: null, blocking: 0 } }, expected: hold('no review recorded') },
  { name: 'blocking findings the stop rule moved to leftovers merge', change: { review: { required: true, status: 'findings', blocking: 2, leftovers: '#412', personLabels: [] } }, expected: merge },
  { name: 'leftovers on a loop:risk issue stay for a person', change: { review: { required: true, status: 'findings', blocking: 2, leftovers: '#412', personLabels: ['loop:risk'] } }, expected: hold('ready to merge with leftovers \\(#412\\); loop:risk stays for a person') },
  { name: 'leftovers never wave an incomplete review through', change: { review: { required: true, status: 'incomplete', blocking: 0, leftovers: '#412' } }, expected: hold('review is not clean') },
  { name: 'pending CI the flow gates on holds', change: { checks: { gating: true, status: 'pending' } }, expected: hold('checks pending') },
  { name: 'red CI the flow gates on holds', change: { checks: { gating: true, status: 'red' } }, expected: hold('checks red') },
  { name: 'nothing vouching for the change holds', change: { vouchedBy: [] }, expected: hold('nothing examined this change') },
  { name: 'a supervised project never merges by itself', change: { autonomy: 'supervised' }, expected: hold('supervised') },
  { name: 'a flow with auto-merge off holds', change: { autoMerge: false }, expected: hold('auto-merge disabled') },
  { name: 'human approval required and missing holds', change: { humanApproval: { required: true, given: false } }, expected: hold('requireHumanApproval') },
]

describe('merge policy', () => {
  it.each(cases)('$name', ({ change, expected }) => {
    expect(decideMerge({ ...ready, ...change })).toEqual(expected)
  })

  it('is pure: the same input decides the same way and the input is untouched', () => {
    const input = structuredClone(ready)
    expect(decideMerge(input)).toEqual(decideMerge(input))
    expect(input).toEqual(ready)
  })

  it('names the weakest verdict among items, and treats a missing one as failed', () => {
    expect(weakestVerdict([])).toBeNull()
    expect(weakestVerdict([{ verdict: 'live-verified' }, { verdict: 'type-check-only' }])).toBe('type-check-only')
    expect(weakestVerdict([{ verdict: 'live-verified' }, { verdict: null }])).toBe('failed')
  })
})

import { expect, it } from 'vitest'
import { assessPilot } from '../src/index.js'

const base = { policyHash: 'policy-v1', baselineReference: 'baseline-2026-09-08' }

it('requires ten normal issues and records every exclusion', () => {
  const entries = Array.from({ length: 10 }, (_, index) => ({ issueId: `AGE-${index}`, classification: 'normal' as const, status: 'included' as const }))
  expect(assessPilot({ ...base, entries })).toMatchObject({ decision: 'ready', included: entries.map((entry) => entry.issueId) })
  expect(assessPilot({ ...base, entries: [...entries.slice(0, 9), { issueId: 'AGE-sensitive', classification: 'sensitive', status: 'included' }] })).toMatchObject({ decision: 'blocked' })
  expect(assessPilot({ ...base, entries: [{ issueId: 'AGE-1', classification: 'normal', status: 'excluded' }] })).toMatchObject({ decision: 'blocked', reasons: expect.arrayContaining(['AGE-1 is excluded without an auditable reason.']) })
})

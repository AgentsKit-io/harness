import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseLoopConfigText, renderWorkerBrief } from '../src/index.js'
import type { StoredContract } from '../src/index.js'
import type { StoredPlan } from '../src/loop/plan-vote.js'
import { renderSpec, specDigest } from '../src/loop/spec.js'
import type { TrackerIssueDetail } from '../src/loop/tracker.js'

const contract: StoredContract = {
  schemaVersion: 1, issue: 'ENG-7', issueUpdatedAt: '2026-09-10T00:00:00.000Z', generatedAt: '2026-09-10T00:00:00.000Z', provider: 'claude', model: 'opus', source: 'llm', digest: 'abcdef1234567890',
  assessment: { dispatchable: true, reasons: [] },
  contract: {
    intent: 'Rate-limit the public API',
    scope: { inScope: ['token bucket per key'], outOfScope: ['billing'] },
    outcomes: [
      { id: 'o1', description: 'a burst over the limit gets 429', check: { kind: 'test', command: 'pnpm vitest run test/limit.test.ts' } },
      { id: 'o2', description: 'limits are configurable', check: { kind: 'manual', note: 'documented in README' } },
    ],
    ambiguities: [{ question: 'per key or per IP?', blocking: false }], hitl: [], touchpoints: ['src/limit.ts'], risks: ['clock skew'],
  },
}
const plan: StoredPlan = {
  schemaVersion: 1, issue: 'ENG-7', generatedAt: '2026-09-10T00:00:00.000Z', provider: 'claude', model: 'opus', digest: 'feedface00000000', contractDigest: contract.digest, cycles: 1, votes: [], status: 'approved', unresolved: [],
  plan: { summary: 'Middleware with an in-memory bucket.', steps: [{ id: 's1', description: 'add the middleware', files: ['src/limit.ts'] }], tests: ['burst test'], risks: ['memory growth'] },
}

describe('rendered spec (ADR-0041)', () => {
  it('renders requirements from the contract, with outcome ids as requirement ids and their acceptance checks', () => {
    const spec = renderSpec({ issue: 'ENG-7', url: 'https://linear.app/x/ENG-7', contract, plan })
    expect(spec['requirements.md']).toContain('# Requirements — ENG-7')
    expect(spec['requirements.md']).toContain('### o1\n\na burst over the limit gets 429\n\n**Acceptance:** test — `pnpm vitest run test/limit.test.ts`')
    expect(spec['requirements.md']).toContain('**Acceptance:** manual (documented in README)')
    expect(spec['requirements.md']).toContain('- per key or per IP?')
    expect(spec['requirements.md']).toContain('frozen contract abcdef123456')
  })

  it('renders design and tasks from the approved plan, and a verification table that traces each requirement to its proof', () => {
    const spec = renderSpec({ issue: 'ENG-7', contract, plan })
    expect(spec['design.md']).toContain('Middleware with an in-memory bucket.')
    expect(spec['design.md']).toContain('- clock skew\n- memory growth')
    expect(spec['tasks.md']).toContain('- [ ] **s1** add the middleware\n  - files: `src/limit.ts`')
    expect(spec['tasks.md']).toContain('- [ ] burst test')
    expect(spec['tasks.md']).toContain('| o1 | test — `pnpm vitest run test/limit.test.ts` | `.ak-loop/verify.json` → `o1` |')
  })

  it('ignores a plan approved for another contract, and is deterministic', () => {
    const stale = renderSpec({ issue: 'ENG-7', contract, plan: { ...plan, contractDigest: 'other' } })
    expect(stale['design.md']).toContain('No plan was approved')
    expect(stale['tasks.md']).not.toContain('s1')
    expect(specDigest(renderSpec({ issue: 'ENG-7', contract, plan }))).toBe(specDigest(renderSpec({ issue: 'ENG-7', contract, plan })))
  })

  it('tells the worker to commit the spec unchanged only when spec.enabled', () => {
    const yaml = readFileSync(join(process.cwd(), 'loop.config.example.yaml'), 'utf8')
    const issue: TrackerIssueDetail = { identifier: 'ENG-7', title: 'Rate limit', url: 'https://linear.app/x/ENG-7', description: '', comments: [], labels: [], project: null, priorityLabel: null, updatedAt: '2026-09-10T00:00:00.000Z' } as unknown as TrackerIssueDetail
    const brief = (text: string): string => renderWorkerBrief({ issue, contract, config: parseLoopConfigText(text), branch: 'b', provider: 'claude', model: 'opus' })
    expect(brief(yaml)).not.toContain('## Spec (')
    expect(brief(`${yaml}\nspec:\n  enabled: true\n`)).toContain('## Spec (`specs/ENG-7/`)')
  })
})

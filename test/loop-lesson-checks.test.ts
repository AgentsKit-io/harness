import { describe, expect, it } from 'vitest'
import type { LearningRecord } from '../src/kernel/learning.js'
import { lessonItemId, proposeLessonCheck, proseOnlyLessons, renderLessonChecks } from '../src/loop/lesson-checks.js'
import { learningsReadyToPromote } from '../src/loop/memory.js'

const record = (id: string, text: string, extra: Partial<LearningRecord> = {}): LearningRecord => ({ id, source: 'retro', category: 'adjustment', text, status: 'proposed', recordedAt: '2026-10-20T00:00:00Z', ...extra })
const config = (items: readonly { id: string }[] = []) => ({ dod: { items: items.map((item) => ({ ...item, description: 'd', kind: 'command' as const, paths: [] })), evidenceFile: '.ak-loop/dod.json' } })

describe('proposeLessonCheck', () => {
  it('picks the check kind from what the lesson asks for', () => {
    expect(proposeLessonCheck(record('L-1', 'Never commit .env files'))?.kind).toBe('guard-rule')
    expect(proposeLessonCheck(record('L-2', 'Unused imports slipped through'))?.kind).toBe('lint-rule')
    expect(proposeLessonCheck(record('L-3', 'The retry path regressed twice'))?.kind).toBe('test')
    expect(proposeLessonCheck(record('L-4', 'Always run the typecheck before pushing', { cue: 'before pushing' }))).toMatchObject({ kind: 'dod-item', proposal: expect.stringContaining('id: lesson-L-4') })
  })

  it('proposes nothing for wording with no mechanical reading', () => {
    expect(proposeLessonCheck(record('L-5', 'The team felt good about the week'))).toBeNull()
  })
})

describe('lessons still only in prose', () => {
  const ledger = { records: [record('L-a', 'Always run lint', { check: { kind: 'dod-item', proposal: 'x' } }), record('L-b', 'Felt good'), record('L-c', 'Never push to main', { status: 'rejected' })] }

  it('lists lessons no adopted check enforces, and not rejected ones', () => {
    expect(proseOnlyLessons(ledger, config()).map((item) => item.id)).toEqual(['L-a', 'L-b'])
  })

  it('counts a lesson as enforced once its DoD item exists or the check is marked adopted', () => {
    expect(proseOnlyLessons(ledger, config([{ id: lessonItemId({ id: 'L-a' }) }])).map((item) => item.id)).toEqual(['L-b'])
    const adopted = { records: [record('L-a', 'Always run lint', { check: { kind: 'dod-item', proposal: 'x', adopted: true } })] }
    expect(proseOnlyLessons(adopted, config())).toEqual([])
  })

  it('renders proposed checks before the prose list and says why a lesson is not promotable', () => {
    const text = renderLessonChecks(ledger, config())
    expect(text.indexOf('## Proposed checks')).toBeLessThan(text.indexOf('## Lessons still only in prose'))
    expect(text).toContain('`L-a` → **dod-item**')
    expect(text).toContain('`L-b` (proposed) Felt good — not promotable: missing cue, evidence')
  })

  it('renders nothing when every lesson is enforced', () => {
    expect(renderLessonChecks({ records: [] }, config())).toBe('')
  })
})

describe('promotion offers only structured lessons', () => {
  it('skips a recurring lesson that lacks a cue or evidence', () => {
    const base = { memory: { categories: ['adjustment'], recurrence: { minSightings: 2, maxPerRun: 3 } } } as Parameters<typeof learningsReadyToPromote>[1]
    const ledger = { records: [record('L-bare', 'x', { sightings: 5 }), record('L-ok', 'y', { sightings: 2, cue: 'c', evidence: 'e' })] }
    expect(learningsReadyToPromote(ledger, base).map((item) => item.id)).toEqual(['L-ok'])
  })
})

import type { LearningCheck, LearningRecord } from '../kernel/learning.js'
import { lessonGaps } from '../kernel/learning.js'
import type { LoopConfig } from './config.js'
import type { LearningsLedger } from './memory.js'

const clip = (value: string, max: number): string => value.length > max ? `${value.slice(0, max - 1)}…` : value
const oneLine = (value: string): string => value.replaceAll(/\s+/g, ' ').trim()

/**
 * The concrete check a lesson should become before it is allowed to stay prose (ADR-0047).
 *
 * ponytail: the kind is picked from the lesson's wording, and the proposal is a skeleton a person finishes — the
 * retro cannot know the regex or the command; it can only refuse to leave the lesson as a sentence. Null when the
 * wording suggests nothing mechanical.
 */
export const proposeLessonCheck = (record: LearningRecord): LearningCheck | null => {
  const lesson = oneLine(record.lesson ?? record.text)
  const cue = oneLine(record.cue ?? 'the situation this lesson came from')
  if (/\b(never|must not|do not|don't|forbid|protected|secret|credential)\b/i.test(lesson)) {
    return { kind: 'guard-rule', proposal: `Add a worker-guard / layer rule that refuses: ${clip(lesson, 160)} (applies when: ${clip(cue, 80)}).` }
  }
  if (/\b(lint|format|style|naming|unused|import)\b/i.test(lesson)) {
    return { kind: 'lint-rule', proposal: `Add a lint rule — or a \`pattern-absent\` DoD item — for: ${clip(lesson, 160)} (applies when: ${clip(cue, 80)}).` }
  }
  if (/\b(test|flak|regress|coverage|assert)/i.test(lesson)) {
    return { kind: 'test', proposal: `Add a regression test that fails without this lesson: ${clip(lesson, 160)} (applies when: ${clip(cue, 80)}).` }
  }
  if (/\b(always|before (push|merge|open)|run|verify|check)\b/i.test(lesson)) {
    return { kind: 'dod-item', proposal: `dod.items:\n  - id: ${lessonItemId(record)}\n    description: ${JSON.stringify(clip(lesson, 120))}\n    kind: command   # applies when: ${clip(cue, 80)}\n    command: ["<the command that proves it>"]` }
  }
  return null
}

export const lessonItemId = (record: Pick<LearningRecord, 'id'>): string => `lesson-${record.id}`

/** A lesson is enforced once a person said so or the DoD list already carries its item. */
export const lessonEnforced = (record: LearningRecord, config: Pick<LoopConfig, 'dod'>): boolean =>
  record.check?.adopted === true || config.dod.items.some((item) => item.id === lessonItemId(record))

/** Lessons (proposed or promoted) that are still only a sentence: no adopted check enforces them. */
export const proseOnlyLessons = (ledger: LearningsLedger, config: Pick<LoopConfig, 'dod'>): readonly LearningRecord[] =>
  ledger.records.filter((record) => record.status !== 'rejected' && !lessonEnforced(record, config))

/**
 * The retro section for lessons: checks to add first, then what is still only prose. Lessons the retro could not
 * structure (no cue/evidence) say so, because those cannot be promoted either.
 */
export const renderLessonChecks = (ledger: LearningsLedger, config: Pick<LoopConfig, 'dod'>, limit = 10): string => {
  const open = proseOnlyLessons(ledger, config)
  if (!open.length) return ''
  const proposed = open.filter((record) => record.check)
  const lines: string[] = []
  if (proposed.length) {
    lines.push('## Proposed checks', '', 'Add the check, then the lesson needs no prose. Adopt a `dod-item` by adding the item; mark any other with `check.adopted` in the learnings ledger.', '')
    for (const record of proposed.slice(0, limit)) lines.push(`- \`${record.id}\` → **${record.check?.kind}**: ${record.check?.proposal.includes('\n') ? `\n\n\`\`\`yaml\n${record.check.proposal}\n\`\`\`` : record.check?.proposal}`)
    lines.push('')
  }
  lines.push('## Lessons still only in prose', '')
  for (const record of open.slice(0, limit)) {
    const gaps = lessonGaps(record)
    lines.push(`- \`${record.id}\` (${record.status}) ${clip(oneLine(record.lesson ?? record.text), 140)}${gaps.length ? ` — not promotable: missing ${gaps.join(', ')}` : ''}`)
  }
  if (open.length > limit) lines.push(`- … and ${open.length - limit} more`)
  return `\n\n${lines.join('\n')}`
}

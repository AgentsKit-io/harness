import { fail } from './errors.js'
import { sha256 } from './hash.js'

export const LEARNING_STATUSES = ['proposed', 'promoted', 'rejected'] as const
export type LearningStatus = typeof LEARNING_STATUSES[number]

export interface LearningRecord {
  readonly id: string
  readonly source: string
  readonly category: 'worked' | 'problem' | 'adjustment' | 'other'
  readonly text: string
  readonly status: LearningStatus
  readonly recordedAt: string
  /**
   * How many retros proposed this same lesson. Absent reads as 1.
   *
   * The id is content-derived, so a recurring lesson used to be silently deduplicated and looked exactly
   * like a one-off. Counting is what separates a pattern from an anecdote — and it is the number
   * `memory.recurrence` uses to offer a promotion.
   */
  readonly sightings?: number
  /** When this applies: the situation that should make a future worker or the loop recall the lesson. */
  readonly cue?: string
  /** What to do (or avoid) then. Reads as `text` when a retro bullet carries no separate lesson. */
  readonly lesson?: string
  /** What happened that taught it: the numbers, events or PR the retro saw. Without it a lesson is an opinion. */
  readonly evidence?: string
  /** The concrete check that would enforce the lesson mechanically; prose is the fallback, not the goal. */
  readonly check?: LearningCheck
}

export const LEARNING_CHECK_KINDS = ['lint-rule', 'dod-item', 'test', 'guard-rule'] as const
export interface LearningCheck {
  readonly kind: typeof LEARNING_CHECK_KINDS[number]
  /** A ready-to-paste skeleton (config snippet or rule description) naming the cue and the lesson. */
  readonly proposal: string
  /** Set by a person once the check exists; a DoD item named `lesson-<id>` counts too. */
  readonly adopted?: boolean
}

/** A lesson is structured when it can say when it applies and what taught it, not just what to do. */
export const lessonGaps = (record: LearningRecord): readonly ('cue' | 'lesson' | 'evidence')[] =>
  (['cue', 'lesson', 'evidence'] as const).filter((field) => !(field === 'lesson' ? record.lesson ?? record.text : record[field])?.trim())

const text = (value: unknown, label: string): string => {
  return typeof value === 'string' && value.trim() ? value.trim() : fail(`${label} must be a non-empty string.`, 'INVALID_INPUT')
}

const category = (heading: string): LearningRecord['category'] => {
  const value = heading.toLowerCase()
  if (/went well|success|worked/.test(value)) return 'worked'
  if (/problem|failed|blocker|pain/.test(value)) return 'problem'
  if (/adjust|action|next|improv/.test(value)) return 'adjustment'
  return 'other'
}

export const parseRetro = (markdown: string, source: string, recordedAt = new Date().toISOString()): readonly LearningRecord[] => {
  const input = text(markdown, 'markdown')
  const origin = text(source, 'source')
  if (!Number.isFinite(Date.parse(recordedAt))) fail('recordedAt must be a valid timestamp.', 'INVALID_INPUT')
  const records: LearningRecord[] = []
  let current: LearningRecord['category'] = 'other'
  // Indented `- cue:` / `- lesson:` / `- evidence:` bullets under an item belong to that item, not to the list.
  let last = ''
  for (const line of input.split(/\r?\n/)) {
    const field = line.match(/^\s{2,}[-*]\s+(cue|lesson|evidence):\s*(.+?)\s*$/i)
    if (field && last) {
      const at = records.findIndex((record) => record.id === last)
      if (at >= 0) records[at] = { ...records[at]!, [field[1]!.toLowerCase()]: field[2]! }
      continue
    }
    const heading = line.match(/^#{1,6}\s+(.+)$/)
    if (heading) { current = category(heading[1] ?? ''); continue }
    const item = line.match(/^\s*[-*]\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/)
    if (!item?.[1]?.trim()) continue
    const value = item[1].trim()
    const id = `L-${sha256(`${origin}|${current}|${value}`).slice(0, 12)}`
    last = id
    if (!records.some((record) => record.id === id)) records.push({ id, source: origin, category: current, text: value, status: 'proposed', recordedAt })
  }
  return records
}

/**
 * The automated promoter (ADR-0019, amendment of 2026-09-19). It is a distinct actor on purpose: the attestation
 * stays truthful about who decided, so every automatically promoted lesson can be listed and revoked.
 */
export const LOOP_AUTO_ACTOR = 'loop-auto'
const PROMOTION_ACTORS = new Set(['human', LOOP_AUTO_ACTOR])

export const promoteLearnings = (records: readonly LearningRecord[], input: { readonly actor: string; readonly ids: readonly string[]; readonly status?: 'promoted' | 'rejected' }): readonly LearningRecord[] => {
  // The bounds on automated promotion (recurrence, per-run cap, allowed categories) are the caller's, and the
  // loop applies them in `learningsReadyToPromote`; what belongs here is only who is allowed to decide at all.
  if (!PROMOTION_ACTORS.has(input.actor)) fail(`Learning promotion requires a human or "${LOOP_AUTO_ACTOR}" actor.`, 'HUMAN_APPROVAL_REQUIRED')
  const ids = new Set(input.ids.map((id) => text(id, 'ids[]')))
  const status = input.status ?? 'promoted'
  // Prose does not become a standing instruction: a promoted lesson says when it applies and what taught it.
  if (status === 'promoted') {
    const bare = records.filter((record) => ids.has(record.id) && lessonGaps(record).length).map((record) => `${record.id} (missing ${lessonGaps(record).join(', ')})`)
    if (bare.length) fail(`A promoted learning carries cue, lesson and evidence: ${bare.join('; ')}.`, 'INVALID_INPUT')
  }
  const result = records.map((record) => ids.has(record.id) ? { ...record, status } : record)
  const unknown = [...ids].filter((id) => !records.some((record) => record.id === id))
  if (unknown.length) fail(`Unknown learning IDs: ${unknown.join(', ')}`, 'INVALID_INPUT')
  return result
}

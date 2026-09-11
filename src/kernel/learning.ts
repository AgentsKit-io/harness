import { createHash } from 'node:crypto'
import { fail } from './errors.js'

export const LEARNING_STATUSES = ['proposed', 'promoted', 'rejected'] as const
export type LearningStatus = typeof LEARNING_STATUSES[number]

export interface LearningRecord {
  readonly id: string
  readonly source: string
  readonly category: 'worked' | 'problem' | 'adjustment' | 'other'
  readonly text: string
  readonly status: LearningStatus
  readonly recordedAt: string
}

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
  for (const line of input.split(/\r?\n/)) {
    const heading = line.match(/^#{1,6}\s+(.+)$/)
    if (heading) { current = category(heading[1] ?? ''); continue }
    const item = line.match(/^\s*[-*]\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/)
    if (!item?.[1]?.trim()) continue
    const value = item[1].trim()
    const id = `L-${createHash('sha256').update(`${origin}|${current}|${value}`).digest('hex').slice(0, 12)}`
    if (!records.some((record) => record.id === id)) records.push({ id, source: origin, category: current, text: value, status: 'proposed', recordedAt })
  }
  return records
}

export const promoteLearnings = (records: readonly LearningRecord[], input: { readonly actor: string; readonly ids: readonly string[]; readonly status?: 'promoted' | 'rejected' }): readonly LearningRecord[] => {
  if (input.actor !== 'human') fail('Learning promotion requires a human actor.', 'HUMAN_APPROVAL_REQUIRED')
  const ids = new Set(input.ids.map((id) => text(id, 'ids[]')))
  const status = input.status ?? 'promoted'
  const result = records.map((record) => ids.has(record.id) ? { ...record, status } : record)
  const unknown = [...ids].filter((id) => !records.some((record) => record.id === id))
  if (unknown.length) fail(`Unknown learning IDs: ${unknown.join(', ')}`, 'INVALID_INPUT')
  return result
}

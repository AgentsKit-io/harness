import { expect, it } from 'vitest'
import type { TrackerConnector } from '../src/loop/connectors.js'
import { refillApplies, runRefill } from '../src/loop/refill.js'

const config = (over: { enabled?: boolean; ownership?: string; people?: Record<string, string> } = {}) => ({ linear: { refill: { enabled: over.enabled ?? true, target: 2, skipLabels: [] }, queueOwnership: over.ownership ?? 'person', people: over.people ?? { ann: 'u1' } } }) as never
const tracker = (held: string[], pool: string[], claimed: string[] = []) => ({
  queue: async (q: { ownership: string }) => (q.ownership === 'person' ? held : pool).map((identifier) => ({ identifier })),
  issue: async (identifier: string) => ({ identifier, assignee: undefined }),
  claim: async (identifier: string) => { claimed.push(identifier) },
}) as unknown as TrackerConnector

it('applies only to enabled person queues', () => {
  expect(refillApplies(config())).toBe(true)
  expect(refillApplies(config({ enabled: false }))).toBe(false)
  expect(refillApplies(config({ ownership: 'unassigned' }))).toBe(false)
})

it('returns null when it does not apply and skips a person without a Linear id', async () => {
  expect(await runRefill({ config: config({ enabled: false }), tracker: tracker([], []), person: 'ann', dryRun: false })).toBeNull()
  const out = await runRefill({ config: config({ people: {} }), tracker: tracker([], ['A-1']), person: 'ann', dryRun: false })
  expect(out?.notes[0]).toContain('no Linear user id')
})

it('tops the queue up from the pool; a dry run only plans', async () => {
  const claimed: string[] = []
  const done = await runRefill({ config: config(), tracker: tracker(['H-1'], ['A-1', 'A-2'], claimed), person: 'ann', dryRun: false })
  expect(done).toMatchObject({ held: 1, assigned: ['A-1'], planned: [] })
  expect(claimed).toEqual(['A-1'])
  const dry = await runRefill({ config: config(), tracker: tracker(['H-1'], ['A-1', 'A-2']), person: 'ann', dryRun: true })
  expect(dry).toMatchObject({ assigned: [], planned: ['A-1'] })
})

it('does nothing when the queue is already full', async () => {
  expect(await runRefill({ config: config(), tracker: tracker(['H-1', 'H-2'], ['A-1']), person: 'ann', dryRun: false })).toMatchObject({ held: 2, assigned: [], planned: [] })
})

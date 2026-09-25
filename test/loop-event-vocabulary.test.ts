import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LOOP_EVENT_TYPES, isLoopEventType } from '../src/index.js'

const sourceFiles = (dir: string): readonly string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = join(dir, entry.name)
  return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith('.ts') ? [path] : []
})

/** Every `type: '<dotted>'` literal the loop emits, wherever it emits it. */
const emittedLiterals = (): readonly string[] => {
  const found = new Set<string>()
  for (const path of [...sourceFiles(join(process.cwd(), 'src/loop')), join(process.cwd(), 'src/cli.ts')]) {
    for (const match of readFileSync(path, 'utf8').matchAll(/type: '([a-z][a-z-]*\.[a-z][a-z-]*)'/g)) found.add(match[1]!)
  }
  return [...found].sort()
}

/**
 * The families the loop emits through a template literal, one per member of a union the compiler already checks.
 * Written out here because a name that only ever exists as `worker.${outcome}` is invisible to a reader — which
 * is the whole reason the vocabulary exists.
 */
const DELIVER_OUTCOMES = ['waiting', 'reviewed', 'fix-round', 'nudged', 'handed-off', 'merged', 'held', 'needs-input', 'blocked', 'stuck', 'abandoned', 'failed'] as const
const TEMPLATE_FAMILIES = [
  ...DELIVER_OUTCOMES.map((outcome) => `worker.${outcome}`),
  ...DELIVER_OUTCOMES.map((outcome) => `github-intake.${outcome}`),
  ...['ci', 'review', 'conflict'].map((kind) => `worker.${kind}-round`),
  'human.hitl-answered', 'human.hitl-batch-ready',
  ...['adopted', 'rejected', 'needs-human', 'reverted'].map((status) => `agent.${status}`),
  ...['cost-guard', 'max-duration'].map((kind) => `${kind}.tripped`),
  'tuning.applied', 'tuning.reverted',
]

/**
 * Emitted from `src/ui/api/*`, not `src/loop/*` or `src/cli.ts` — outside the scanned source-file set above.
 * `src/ui/*` is deliberately not scanned: it declares its own `UiAction` union with the same dotted-lowercase
 * `type: '<name>'` shape (e.g. `parseUiAction({ type: 'loop.contract', ... })`), which the plain-text scan cannot
 * tell apart from an actual `appendLoopEvent` call.
 */
const UI_ORIGINATED_EVENTS = ['ui.run-enqueued', 'ui.cleanup-completed', 'ui.cleanup-failed', 'ui.issue-decided']

describe('the loop event vocabulary', () => {
  it('declares exactly the events the loop emits, and nothing it does not', () => {
    const declared = new Set<string>(Object.keys(LOOP_EVENT_TYPES))
    const emitted = new Set<string>([...emittedLiterals(), ...TEMPLATE_FAMILIES, ...UI_ORIGINATED_EVENTS])

    // A new emission that skipped the vocabulary: nobody could subscribe to it on purpose.
    expect([...emitted].filter((type) => !declared.has(type)).sort()).toEqual([])
    // A name declared here that nothing emits: a promise the loop does not keep.
    expect([...declared].filter((type) => !emitted.has(type)).sort()).toEqual([])
  })

  it('says what every event carries, so a subscriber reads a contract and not a name', () => {
    for (const [type, fields] of Object.entries(LOOP_EVENT_TYPES)) {
      expect(fields.length, `${type} declares no fields`).toBeGreaterThan(0)
      expect(new Set(fields).size, `${type} repeats a field`).toBe(fields.length)
    }
  })

  it('recognises a declared event by name, and refuses one it never heard of', () => {
    expect(isLoopEventType('pr.merged')).toBe(true)
    expect(isLoopEventType('pr.invented')).toBe(false)
  })
})

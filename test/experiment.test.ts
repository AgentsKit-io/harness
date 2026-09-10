import { expect, it } from 'vitest'
import { selectRuntime } from '../src/index.js'

const candidate = (runtime: string, overrides: Partial<Parameters<typeof selectRuntime>[0][number]> = {}) => ({ runtime, sourceRevision: 'abc', contractHash: 'contract', provider: 'openai', model: 'model', configurationHash: 'config', hardGatesPassed: true, humanMinutes: 10, durationMs: 100, cost: 1, ...overrides })

it('excludes hard-gate failures and selects the least human effort', () => {
  const result = selectRuntime([candidate('orca'), candidate('emdash', { hardGatesPassed: false, humanMinutes: 0 })])
  expect(result).toMatchObject({ decision: 'selected', selected: { runtime: 'orca' }, eligible: [{ runtime: 'orca' }] })
})

it('uses Orca only as the final deterministic tie-break', () => {
  expect(selectRuntime([candidate('emdash'), candidate('orca')]).selected?.runtime).toBe('orca')
})

it('rejects incomparable candidates and blocks when no hard gate passes', () => {
  expect(() => selectRuntime([candidate('orca'), candidate('emdash', { model: 'other' })])).toThrow(/share model/)
  expect(selectRuntime([candidate('orca', { hardGatesPassed: false }), candidate('emdash', { hardGatesPassed: false })])).toMatchObject({ decision: 'blocked' })
})

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

it('rejects fewer than two candidates', () => {
  expect(() => selectRuntime([candidate('orca')])).toThrow(/At least two runtime candidates/)
  expect(() => selectRuntime([])).toThrow(/At least two runtime candidates/)
})

it('rejects a blank runtime name and duplicate runtime names', () => {
  expect(() => selectRuntime([candidate(''), candidate('emdash')])).toThrow(/candidate.runtime is required/)
  expect(() => selectRuntime([candidate('orca'), candidate('orca')])).toThrow(/must be unique/)
})

it('rejects a blank required identity field', () => {
  expect(() => selectRuntime([candidate('orca', { sourceRevision: '' }), candidate('emdash', { sourceRevision: '' })])).toThrow(/sourceRevision is required/)
})

it('rejects a negative or non-finite humanMinutes/durationMs/cost', () => {
  expect(() => selectRuntime([candidate('orca', { humanMinutes: -1 }), candidate('emdash')])).toThrow(/humanMinutes must be a non-negative number/)
  expect(() => selectRuntime([candidate('orca', { durationMs: Number.NaN }), candidate('emdash')])).toThrow(/durationMs must be a non-negative number/)
  expect(() => selectRuntime([candidate('orca', { cost: -1 }), candidate('emdash')])).toThrow(/cost must be a non-negative number/)
})

it('breaks a tie between two non-Orca runtimes alphabetically', () => {
  expect(selectRuntime([candidate('zeta'), candidate('alpha')]).selected?.runtime).toBe('alpha')
})

it('falls through humanMinutes to durationMs, then to cost, before the Orca tie-break', () => {
  expect(selectRuntime([candidate('emdash', { durationMs: 200 }), candidate('orca', { durationMs: 100 })]).selected?.runtime).toBe('orca')
  expect(selectRuntime([candidate('emdash', { durationMs: 100, cost: 2 }), candidate('orca', { durationMs: 100, cost: 1 })]).selected?.runtime).toBe('orca')
})

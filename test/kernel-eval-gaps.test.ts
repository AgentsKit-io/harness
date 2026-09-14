import { describe, expect, it } from 'vitest'
import { EVAL_COMPONENTS, EVAL_LAYERS, assessAgentEval, createEvalManifest, runAgentEval, validateEvalManifest } from '../src/index.js'
import type { AgentEvalReport } from '../src/index.js'

const hash = 'a'.repeat(64)
const validCase = (overrides: Record<string, unknown> = {}) => ({ id: 'case-core', layer: 'contract', components: ['core'], grader: 'g', input: 'x', ...overrides })
const coveringCases = EVAL_COMPONENTS.map((component, index) => ({ id: `case-${component}`, layer: EVAL_LAYERS[index % EVAL_LAYERS.length]!, components: [component], grader: 'g', input: component }))
const validInput = (overrides: Record<string, unknown> = {}) => ({
  suiteId: 'suite-1', name: 'Suite', cases: coveringCases, graders: ['g'],
  thresholds: { subjectiveQuality: 80, maxRegression: 5 }, repetitions: 1,
  provider: 'p', model: 'm', promptHash: hash, toolHash: hash, evidenceOutputs: ['out.json'],
  ...overrides,
})

describe('createEvalManifest / validateEvalManifest validation', () => {
  it('rejects a blank suiteId, name, provider, model, and case fields', () => {
    expect(() => createEvalManifest(validInput({ suiteId: '  ' }) as never)).toThrow(/suiteId/)
    expect(() => createEvalManifest(validInput({ name: '' }) as never)).toThrow(/name/)
    expect(() => createEvalManifest(validInput({ provider: '' }) as never)).toThrow(/provider/)
    expect(() => createEvalManifest(validInput({ model: '' }) as never)).toThrow(/model/)
  })

  it('rejects an invalid promptHash/toolHash digest', () => {
    expect(() => createEvalManifest(validInput({ promptHash: 'not-a-digest' }) as never)).toThrow(/lowercase SHA-256/)
    expect(() => createEvalManifest(validInput({ toolHash: 'not-a-digest' }) as never)).toThrow(/lowercase SHA-256/)
  })

  it('rejects out-of-range threshold scores', () => {
    expect(() => createEvalManifest(validInput({ thresholds: { subjectiveQuality: 200, maxRegression: 5 } }) as never)).toThrow(/between 0 and 100/)
    expect(() => createEvalManifest(validInput({ thresholds: { subjectiveQuality: 80, maxRegression: -1 } }) as never)).toThrow(/between 0 and 100/)
    expect(() => createEvalManifest(validInput({ thresholds: 'nope' }) as never)).toThrow(/thresholds must be an object/)
    expect(() => createEvalManifest(validInput({ thresholds: [] }) as never)).toThrow(/thresholds must be an object/)
  })

  it('rejects a non-positive-integer repetitions', () => {
    expect(() => createEvalManifest(validInput({ repetitions: 0 }) as never)).toThrow(/repetitions/)
    expect(() => createEvalManifest(validInput({ repetitions: 1.5 }) as never)).toThrow(/repetitions/)
  })

  it('rejects missing/empty evidenceOutputs and blank entries', () => {
    expect(() => createEvalManifest(validInput({ evidenceOutputs: [] }) as never)).toThrow(/evidenceOutputs/)
    expect(() => createEvalManifest(validInput({ evidenceOutputs: undefined }) as never)).toThrow(/evidenceOutputs/)
    expect(() => createEvalManifest(validInput({ evidenceOutputs: [''] }) as never)).toThrow(/evidenceOutputs\[0\]/)
  })

  it('rejects missing/empty cases and duplicate case ids', () => {
    expect(() => createEvalManifest(validInput({ cases: [] }) as never)).toThrow(/cases must be a non-empty array/)
    expect(() => createEvalManifest(validInput({ cases: undefined }) as never)).toThrow(/cases must be a non-empty array/)
    expect(() => createEvalManifest(validInput({ cases: [validCase(), validCase()] }) as never)).toThrow(/case ids must be unique/)
  })

  it('rejects a non-object case', () => {
    expect(() => createEvalManifest(validInput({ cases: [null] }) as never)).toThrow(/cases\[0\] must be an object/)
    expect(() => createEvalManifest(validInput({ cases: [[]] }) as never)).toThrow(/cases\[0\] must be an object/)
  })

  it('rejects an invalid case layer', () => {
    expect(() => createEvalManifest(validInput({ cases: [validCase({ layer: 'not-a-layer' })] }) as never)).toThrow(/layer is invalid/)
    expect(() => createEvalManifest(validInput({ cases: [validCase({ layer: '' })] }) as never)).toThrow(/layer/)
  })

  it('rejects non-array, empty, invalid, and duplicate case components', () => {
    expect(() => createEvalManifest(validInput({ cases: [validCase({ components: 'core' })] }) as never)).toThrow(/components must be a non-empty array/)
    expect(() => createEvalManifest(validInput({ cases: [validCase({ components: [] })] }) as never)).toThrow(/components must be a non-empty array/)
    expect(() => createEvalManifest(validInput({ cases: [validCase({ components: ['not-a-component'] })] }) as never)).toThrow(/components\[0\] is invalid/)
    expect(() => createEvalManifest(validInput({ cases: [validCase({ components: ['core', 'core'] })] }) as never)).toThrow(/components must not contain duplicates/)
  })

  it('rejects a blank case grader and input', () => {
    expect(() => createEvalManifest(validInput({ cases: [validCase({ grader: '' })] }) as never)).toThrow(/grader/)
    expect(() => createEvalManifest(validInput({ cases: [validCase({ input: '' })] }) as never)).toThrow(/input/)
  })

  it('rejects an out-of-range case baselineScore', () => {
    expect(() => createEvalManifest(validInput({ cases: [validCase({ baselineScore: 150 })] }) as never)).toThrow(/baselineScore/)
  })

  it('carries optional critical/subjective/baselineScore through when provided', () => {
    const cases = [{ ...coveringCases[0]!, critical: true, subjective: true, baselineScore: 90 }, ...coveringCases.slice(1)]
    const manifest = createEvalManifest(validInput({ cases }) as never)
    expect(manifest.cases[0]).toMatchObject({ critical: true, subjective: true, baselineScore: 90 })
  })

  it('rejects cases missing layer coverage', () => {
    expect(() => createEvalManifest(validInput({ cases: [validCase()] }) as never)).toThrow(/cases must cover layers/)
  })

  it('rejects cases that cover every layer but not every component', () => {
    const cases = EVAL_LAYERS.map((layer) => ({ id: `case-${layer}`, layer, components: [EVAL_COMPONENTS[0]!], grader: 'g', input: layer }))
    expect(() => createEvalManifest(validInput({ cases }) as never)).toThrow(/cases must cover components/)
  })

  it('rejects missing/empty graders and blank grader entries', () => {
    expect(() => createEvalManifest(validInput({ graders: [] }) as never)).toThrow(/graders must be a non-empty array/)
    expect(() => createEvalManifest(validInput({ graders: undefined }) as never)).toThrow(/graders must be a non-empty array/)
    expect(() => createEvalManifest(validInput({ graders: [''] }) as never)).toThrow(/graders\[0\]/)
  })

  it('rejects a non-object manifest and a mismatched type/schemaVersion/digest', () => {
    expect(() => validateEvalManifest(null)).toThrow(/must be an object/)
    expect(() => validateEvalManifest([])).toThrow(/must be an object/)
    const manifest = createEvalManifest(validInput() as never)
    expect(() => validateEvalManifest({ ...manifest, type: 'wrong' })).toThrow(/type or schemaVersion/)
    expect(() => validateEvalManifest({ ...manifest, schemaVersion: 2 })).toThrow(/type or schemaVersion/)
    expect(() => validateEvalManifest({ ...manifest, digest: 'not-a-digest' })).toThrow(/lowercase SHA-256/)
    expect(() => validateEvalManifest({ ...manifest, digest: hash })).toThrow(/digest is invalid/)
  })
})

describe('assessAgentEval', () => {
  const report = (overrides: Partial<AgentEvalReport> = {}): AgentEvalReport => ({ suite: 's', total: 2, passed: 2, failed: 0, accuracy: 1, failures: [], ...overrides })

  it('rejects an out-of-range minimumAccuracy', () => {
    expect(() => assessAgentEval(report(), -0.1)).toThrow(/minimumAccuracy/)
    expect(() => assessAgentEval(report(), 1.1)).toThrow(/minimumAccuracy/)
    expect(() => assessAgentEval(report(), Number.NaN)).toThrow(/minimumAccuracy/)
  })

  it('rejects an inconsistent report', () => {
    expect(() => assessAgentEval(report({ total: 0 }), 0.5)).toThrow(/inconsistent/)
    expect(() => assessAgentEval(report({ passed: 1, failed: 0, total: 2 }), 0.5)).toThrow(/inconsistent/)
    expect(() => assessAgentEval(report({ accuracy: 0.1 }), 0.5)).toThrow(/inconsistent/)
  })

  it('passes when accuracy meets the minimum and blocks when it does not', () => {
    expect(assessAgentEval(report({ accuracy: 1, passed: 2, failed: 0, total: 2 }), 0.9)).toMatchObject({ status: 'passed' })
    expect(assessAgentEval(report({ accuracy: 0.5, passed: 1, failed: 1, total: 2 }), 0.9)).toMatchObject({ status: 'blocked' })
  })
})

describe('runAgentEval guards and concurrency', () => {
  it('rejects a suite with a blank name or no cases', async () => {
    await expect(runAgentEval({ suite: { name: '', cases: [{ id: 'a', input: 'a', expected: 'a' }] }, agent: async (x) => x })).rejects.toThrow(/name and at least one case/)
    await expect(runAgentEval({ suite: { name: 's', cases: [] }, agent: async (x) => x })).rejects.toThrow(/name and at least one case/)
  })

  it('rejects a non-positive-integer concurrency', () => {
    const suite = { name: 's', cases: [{ id: 'a', input: 'a', expected: 'a' }] }
    return expect(runAgentEval({ suite, agent: async (x) => x, concurrency: 0 })).rejects.toThrow(/concurrency/)
  })

  it('evaluates expectations given as a predicate function', async () => {
    const report = await runAgentEval({
      suite: { name: 's', cases: [{ id: 'a', input: 'ping', expected: (output: string) => output === 'pong' }] },
      agent: async () => 'pong',
    })
    expect(report.accuracy).toBe(1)
  })
})

import { expect, it } from 'vitest'
import { EVAL_COMPONENTS, EVAL_LAYERS, createEvalManifest, runEvalBattery, validateEvalManifest } from '../src/index.js'

const hash = 'a'.repeat(64)
const manifest = createEvalManifest({
  suiteId: 'h047a-fixture', name: 'H-047A deterministic battery',
  cases: EVAL_COMPONENTS.map((component, index) => ({ id: `case-${component}`, layer: EVAL_LAYERS[index % EVAL_LAYERS.length]!, components: [component], grader: 'fixture-grader', input: component, ...(index === 0 ? { critical: true } : {}), ...(index === 1 ? { subjective: true, baselineScore: 90 } : {}) })),
  graders: ['fixture-grader'], thresholds: { subjectiveQuality: 80, maxRegression: 5 }, repetitions: 3,
  provider: 'fixture', model: 'fixed', promptHash: hash, toolHash: hash, evidenceOutputs: ['eval-report.json', 'eval-report.md'],
})

it('validates a versioned manifest with all layers and touched components', () => {
  expect(validateEvalManifest(manifest)).toEqual(manifest)
  expect(manifest.cases).toHaveLength(EVAL_COMPONENTS.length)
})

it('runs deterministic repetitions and reports min/median/max', async () => {
  const report = await runEvalBattery({ manifest, evaluate: async (testCase) => ({ status: 'passed', score: testCase.critical ? 100 : 90, evidence: `evidence:${testCase.id}` }) })
  expect(report.status).toBe('passed')
  expect(report.cases[0]).toMatchObject({ repetitions: 3, min: 100, median: 100, max: 100 })
})

it('blocks unknown evidence and critical, subjective, and regression failures', async () => {
  const report = await runEvalBattery({ manifest, evaluate: async (testCase) => testCase.critical ? { status: 'unknown' } : testCase.subjective ? { status: 'passed', score: 70 } : { status: 'passed', score: 80 } })
  expect(report.status).toBe('blocked')
  expect(report.blockers).toEqual(expect.arrayContaining([
    'case-core: unknown, stale, or unverified evidence',
    'case-core: critical case requires 100/100',
    'case-workflow: subjective score below 80/100',
    'case-workflow: regression exceeds 5 points without a decision',
  ]))
})

import { fail } from './errors.js'
import { hashJson } from './hash.js'

export type EvalExpectation = string | ((output: string) => boolean)

export interface AgentEvalCase {
  readonly id: string
  readonly input: string
  readonly expected: EvalExpectation
}

export interface AgentEvalSuite {
  readonly name: string
  readonly cases: readonly AgentEvalCase[]
}

export interface AgentEvalReport {
  readonly suite: string
  readonly total: number
  readonly passed: number
  readonly failed: number
  readonly accuracy: number
  readonly failures: readonly string[]
}

export const EVAL_MANIFEST_SCHEMA_VERSION = 1 as const
export const EVAL_LAYERS = ['contract', 'deterministic', 'integration', 'quality', 'regression', 'resource'] as const
export const EVAL_COMPONENTS = ['core', 'workflow', 'memory', 'cache', 'doc-bridge', 'agent-model', 'orca-worktree', 'runtime', 'code-review', 'github-linear', 'eval-metrics'] as const
export type EvalLayer = typeof EVAL_LAYERS[number]
export type EvalComponent = typeof EVAL_COMPONENTS[number]
export type EvalObservationStatus = 'passed' | 'failed' | 'unknown' | 'stale' | 'unverified'

export interface EvalCaseDefinition {
  readonly id: string
  readonly layer: EvalLayer
  readonly components: readonly EvalComponent[]
  readonly grader: string
  readonly input: string
  readonly critical?: boolean
  readonly subjective?: boolean
  readonly baselineScore?: number
}

export interface EvalManifest {
  readonly type: 'agentskit-harness-eval-manifest'
  readonly schemaVersion: typeof EVAL_MANIFEST_SCHEMA_VERSION
  readonly suiteId: string
  readonly name: string
  readonly cases: readonly EvalCaseDefinition[]
  readonly graders: readonly string[]
  readonly thresholds: { readonly subjectiveQuality: number; readonly maxRegression: number }
  readonly repetitions: number
  readonly provider: string
  readonly model: string
  readonly promptHash: string
  readonly toolHash: string
  readonly evidenceOutputs: readonly string[]
  readonly digest: string
}

export interface EvalObservation {
  readonly status: EvalObservationStatus
  readonly score?: number
  readonly evidence?: string
  readonly decision?: string
}

export interface EvalCaseReport {
  readonly id: string
  readonly repetitions: number
  readonly min: number | null
  readonly median: number | null
  readonly max: number | null
  readonly statuses: readonly EvalObservationStatus[]
  readonly blockers: readonly string[]
}

export interface EvalBatteryReport {
  readonly suiteId: string
  readonly repetitions: number
  readonly cases: readonly EvalCaseReport[]
  readonly status: 'passed' | 'blocked'
  readonly blockers: readonly string[]
}

const nonEmpty = (value: unknown, label: string): string => {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) fail(`${label} is required.`, 'INVALID_INPUT')
  return text
}

const digest = (value: unknown, label: string): string => {
  const result = nonEmpty(value, label)
  if (!/^[a-f0-9]{64}$/.test(result)) fail(`${label} must be a lowercase SHA-256 digest.`, 'INVALID_INPUT')
  return result
}

const score = (value: unknown, label: string): number => {
  const numeric = typeof value === 'number' ? value : Number.NaN
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 100) fail(`${label} must be a number between 0 and 100.`, 'INVALID_INPUT')
  return numeric
}

const validateCase = (value: unknown, index: number): EvalCaseDefinition => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`cases[${index}] must be an object.`, 'INVALID_INPUT')
  const candidate = value as Record<string, unknown>
  const layer = nonEmpty(candidate['layer'], `cases[${index}].layer`)
  if (!(EVAL_LAYERS as readonly string[]).includes(layer)) fail(`cases[${index}].layer is invalid.`, 'INVALID_INPUT')
  const components = candidate['components']
  if (!Array.isArray(components) || !components.length) fail(`cases[${index}].components must be a non-empty array.`, 'INVALID_INPUT')
  const normalizedComponents = (components as readonly unknown[]).map((item, componentIndex) => {
    const component = nonEmpty(item, `cases[${index}].components[${componentIndex}]`)
    if (!(EVAL_COMPONENTS as readonly string[]).includes(component)) fail(`cases[${index}].components[${componentIndex}] is invalid.`, 'INVALID_INPUT')
    return component as EvalComponent
  })
  if (new Set(normalizedComponents).size !== normalizedComponents.length) fail(`cases[${index}].components must not contain duplicates.`, 'INVALID_INPUT')
  const baselineScore = candidate['baselineScore'] === undefined ? undefined : score(candidate['baselineScore'], `cases[${index}].baselineScore`)
  return {
    id: nonEmpty(candidate['id'], `cases[${index}].id`),
    layer: layer as EvalLayer,
    components: normalizedComponents,
    grader: nonEmpty(candidate['grader'], `cases[${index}].grader`),
    input: nonEmpty(candidate['input'], `cases[${index}].input`),
    ...(candidate['critical'] === undefined ? {} : { critical: candidate['critical'] === true }),
    ...(candidate['subjective'] === undefined ? {} : { subjective: candidate['subjective'] === true }),
    ...(baselineScore === undefined ? {} : { baselineScore }),
  }
}

const manifestBody = (value: Record<string, unknown>): Omit<EvalManifest, 'digest'> => {
  const casesValue = value['cases']
  if (!Array.isArray(casesValue) || !casesValue.length) fail('cases must be a non-empty array.', 'INVALID_INPUT')
  const cases = (casesValue as readonly unknown[]).map(validateCase)
  if (new Set(cases.map((item) => item.id)).size !== cases.length) fail('case ids must be unique.', 'INVALID_INPUT')
  const layers = new Set(cases.map((item) => item.layer))
  const missingLayers = EVAL_LAYERS.filter((layer) => !layers.has(layer))
  if (missingLayers.length) fail(`cases must cover layers: ${missingLayers.join(', ')}.`, 'INVALID_INPUT')
  const coveredComponents = new Set(cases.flatMap((item) => item.components))
  const missingComponents = EVAL_COMPONENTS.filter((component) => !coveredComponents.has(component))
  if (missingComponents.length) fail(`cases must cover components: ${missingComponents.join(', ')}.`, 'INVALID_INPUT')
  const gradersValue = value['graders']
  if (!Array.isArray(gradersValue) || !gradersValue.length) fail('graders must be a non-empty array.', 'INVALID_INPUT')
  const graders = (gradersValue as readonly unknown[]).map((item, index) => nonEmpty(item, `graders[${index}]`))
  const thresholdsValue = value['thresholds']
  if (typeof thresholdsValue !== 'object' || thresholdsValue === null || Array.isArray(thresholdsValue)) fail('thresholds must be an object.', 'INVALID_INPUT')
  const thresholds = thresholdsValue as Record<string, unknown>
  const repetitions = value['repetitions']
  if (!Number.isInteger(repetitions) || (repetitions as number) < 1) fail('repetitions must be a positive integer.', 'INVALID_INPUT')
  return {
    type: 'agentskit-harness-eval-manifest', schemaVersion: EVAL_MANIFEST_SCHEMA_VERSION,
    suiteId: nonEmpty(value['suiteId'], 'suiteId'), name: nonEmpty(value['name'], 'name'), cases, graders,
    thresholds: { subjectiveQuality: score(thresholds['subjectiveQuality'] ?? 80, 'thresholds.subjectiveQuality'), maxRegression: score(thresholds['maxRegression'] ?? 5, 'thresholds.maxRegression') },
    repetitions: repetitions as number, provider: nonEmpty(value['provider'], 'provider'), model: nonEmpty(value['model'], 'model'),
    promptHash: digest(value['promptHash'], 'promptHash'), toolHash: digest(value['toolHash'], 'toolHash'),
    evidenceOutputs: Array.isArray(value['evidenceOutputs']) && value['evidenceOutputs'].length ? (value['evidenceOutputs'] as readonly unknown[]).map((item, index) => nonEmpty(item, `evidenceOutputs[${index}]`)) : fail('evidenceOutputs must be a non-empty array.', 'INVALID_INPUT'),
  }
}

export const createEvalManifest = (input: Omit<EvalManifest, 'type' | 'schemaVersion' | 'digest'>): EvalManifest => {
  const body = manifestBody(input as unknown as Record<string, unknown>)
  return { ...body, digest: hashJson(body) }
}

export const validateEvalManifest = (value: unknown): EvalManifest => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('Eval manifest must be an object.', 'INVALID_INPUT')
  const candidate = value as Record<string, unknown>
  const body = manifestBody(candidate)
  if (candidate['type'] !== body.type || candidate['schemaVersion'] !== body.schemaVersion) fail('Eval manifest type or schemaVersion is invalid.', 'INVALID_INPUT')
  const manifestDigest = digest(candidate['digest'], 'digest')
  if (manifestDigest !== hashJson(body)) fail('Eval manifest digest is invalid.', 'INVALID_INPUT')
  return { ...body, digest: manifestDigest }
}

const median = (values: readonly number[]): number | null => {
  if (!values.length) return null
  const ordered = [...values].sort((left, right) => left - right)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2
}

export const runEvalBattery = async ({ manifest, evaluate }: { readonly manifest: EvalManifest; readonly evaluate: (testCase: EvalCaseDefinition, repetition: number) => Promise<EvalObservation> }): Promise<EvalBatteryReport> => {
  const validated = validateEvalManifest(manifest)
  const reports: EvalCaseReport[] = []
  for (const testCase of validated.cases) {
    const observations: EvalObservation[] = []
    for (let repetition = 1; repetition <= validated.repetitions; repetition += 1) observations.push(await evaluate(testCase, repetition))
    const blockers: string[] = []
    const statuses = observations.map((observation) => observation.status)
    if (statuses.some((status) => status === 'unknown' || status === 'stale' || status === 'unverified')) blockers.push('unknown, stale, or unverified evidence')
    if (statuses.some((status) => status === 'failed')) blockers.push('failed observation')
    const values = observations.map((observation) => observation.score).filter((value): value is number => typeof value === 'number')
    const minimum = values.length ? Math.min(...values) : null
    const baseline = testCase.baselineScore
    if (testCase.critical && (minimum === null || minimum < 100)) blockers.push('critical case requires 100/100')
    if (testCase.subjective && (median(values) ?? 0) < validated.thresholds.subjectiveQuality) blockers.push(`subjective score below ${validated.thresholds.subjectiveQuality}/100`)
    if (baseline !== undefined && minimum !== null && minimum < baseline - validated.thresholds.maxRegression && !observations.every((observation) => observation.decision)) blockers.push(`regression exceeds ${validated.thresholds.maxRegression} points without a decision`)
    reports.push({ id: testCase.id, repetitions: observations.length, min: minimum, median: median(values), max: values.length ? Math.max(...values) : null, statuses, blockers })
  }
  const blockers = reports.flatMap((report) => report.blockers.map((reason) => `${report.id}: ${reason}`))
  return { suiteId: validated.suiteId, repetitions: validated.repetitions, cases: reports, status: blockers.length ? 'blocked' : 'passed', blockers }
}

const pass = (expected: EvalExpectation, output: string): boolean => typeof expected === 'string' ? output === expected : expected(output)

export const runAgentEval = async ({ suite, agent, concurrency = 1 }: { readonly suite: AgentEvalSuite; readonly agent: (input: string) => Promise<string>; readonly concurrency?: number }): Promise<AgentEvalReport> => {
  if (!suite.name.trim() || !suite.cases.length) fail('Eval suite must have a name and at least one case.', 'INVALID_INPUT')
  if (!Number.isInteger(concurrency) || concurrency < 1) fail('Eval concurrency must be a positive integer.', 'INVALID_INPUT')
  const failures: string[] = []
  let passed = 0
  for (let offset = 0; offset < suite.cases.length; offset += concurrency) {
    const batch = suite.cases.slice(offset, offset + concurrency)
    const outputs = await Promise.all(batch.map((testCase) => agent(testCase.input)))
    batch.forEach((testCase, index) => { if (pass(testCase.expected, outputs[index]!)) passed += 1; else failures.push(testCase.id) })
  }
  return { suite: suite.name, total: suite.cases.length, passed, failed: suite.cases.length - passed, accuracy: passed / suite.cases.length, failures }
}

export const assessAgentEval = (report: AgentEvalReport, minimumAccuracy: number): { readonly status: 'passed' | 'blocked'; readonly reason: string; readonly report: AgentEvalReport } => {
  if (!Number.isFinite(minimumAccuracy) || minimumAccuracy < 0 || minimumAccuracy > 1) fail('minimumAccuracy must be between 0 and 1.', 'INVALID_INPUT')
  if (report.total < 1 || report.passed + report.failed !== report.total || report.accuracy !== report.passed / report.total) fail('Eval report is inconsistent.', 'INVALID_INPUT')
  return report.accuracy >= minimumAccuracy ? { status: 'passed', reason: `Accuracy ${report.accuracy.toFixed(4)} meets ${minimumAccuracy.toFixed(4)}.`, report } : { status: 'blocked', reason: `Accuracy ${report.accuracy.toFixed(4)} is below ${minimumAccuracy.toFixed(4)}.`, report }
}

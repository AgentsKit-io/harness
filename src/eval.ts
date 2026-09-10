import { fail } from './errors.js'

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

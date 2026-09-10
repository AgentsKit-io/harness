import { classifyFailure, type FailureClassification } from '../kernel/resilience.js'
import { fail } from '../kernel/errors.js'
import type { AdapterMetadata, AssuranceLevel } from '../kernel/adapter-contract.js'

export interface CodingAgentRequest {
  readonly issueRef: string
  readonly prompt: string
  readonly sourceRevision: string
  readonly contextHash?: string
  readonly signal: AbortSignal
}

export interface AgentUsage {
  readonly status: 'measured' | 'unknown'
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
}

export interface CodingAgentResult {
  readonly status: 'completed' | 'failed' | 'timeout' | 'cancelled'
  readonly output: Readonly<Record<string, unknown>>
  readonly diff: string
  readonly usage: AgentUsage
  readonly durationMs: number
  readonly failure?: FailureClassification
  readonly metadata: AdapterMetadata
}

export interface CodingAgentHandlerResult {
  readonly output: Readonly<Record<string, unknown>>
  readonly diff: string
  readonly usage?: AgentUsage
}

export interface CodingAgentAdapter {
  readonly id: string
  readonly version: string
  readonly assurance: AssuranceLevel
  execute(request: Omit<CodingAgentRequest, 'signal'> & { readonly signal?: AbortSignal }): Promise<CodingAgentResult>
}

const required = (value: string, label: string): string => {
  if (typeof value !== 'string' || !value.trim()) return fail(`${label} is required.`, 'INVALID_INPUT')
  return value.trim()
}
const duration = (value: number): number => Number.isFinite(value) && value >= 0 ? value : fail('Agent durationMs must be non-negative.', 'INVALID_INPUT')
const usage = (value: AgentUsage | undefined): AgentUsage => {
  if (value === undefined) return { status: 'unknown' }
  if (value.status !== 'measured' && value.status !== 'unknown') return fail('Agent usage status is invalid.', 'INVALID_INPUT')
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens'] as const) if (value[key] !== undefined && (!Number.isFinite(value[key]) || value[key]! < 0)) return fail(`Agent usage ${key} must be non-negative.`, 'INVALID_INPUT')
  return value
}

export const createCodingAgentAdapter = ({ id, version, assurance = 'contract-tested', timeoutMs = 120_000, execute }: { readonly id: string; readonly version: string; readonly assurance?: AssuranceLevel; readonly timeoutMs?: number; readonly execute: (request: CodingAgentRequest) => Promise<CodingAgentHandlerResult> | CodingAgentHandlerResult }): CodingAgentAdapter => {
  const adapterId = required(id, 'agent.id')
  const adapterVersion = required(version, 'agent.version')
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) return fail('agent.timeoutMs must be a positive integer.', 'INVALID_INPUT')
  return {
    id: adapterId,
    version: adapterVersion,
    assurance,
    execute: async (request) => {
      const issueRef = required(request.issueRef, 'agent.issueRef')
      const prompt = required(request.prompt, 'agent.prompt')
      const sourceRevision = required(request.sourceRevision, 'agent.sourceRevision')
      const controller = new AbortController()
      const signal = request.signal
      if (signal?.aborted) return { status: 'cancelled', output: {}, diff: '', usage: { status: 'unknown' }, durationMs: 0, failure: { class: 'policy', retryable: false, reason: 'Agent execution was cancelled before start.' }, metadata: { assurance, telemetry: { status: 'measured', durationMs: 0 } } }
      const onAbort = () => controller.abort()
      signal?.addEventListener('abort', onAbort, { once: true })
      const started = Date.now()
      let timer: NodeJS.Timeout | undefined
      let timedOut = false
      try {
        const operation = Promise.resolve(execute({ issueRef, prompt, sourceRevision, ...(request.contextHash ? { contextHash: request.contextHash } : {}), signal: controller.signal }))
        const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new Error('agent execution timed out')) }, timeoutMs) })
        const result = await Promise.race([operation, timeout])
        if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.output !== 'object' || result.output === null || Array.isArray(result.output) || typeof result.diff !== 'string') return fail('Agent result must contain structured output and diff.', 'INVALID_INPUT')
        const measuredUsage = usage(result.usage)
        const durationMs = duration(Date.now() - started)
        return { status: 'completed', output: result.output, diff: result.diff, usage: measuredUsage, durationMs, metadata: { assurance, telemetry: { status: measuredUsage.status, durationMs, ...(measuredUsage.inputTokens === undefined ? {} : { inputTokens: measuredUsage.inputTokens }), ...(measuredUsage.outputTokens === undefined ? {} : { outputTokens: measuredUsage.outputTokens }), ...(measuredUsage.totalTokens === undefined ? {} : { totalTokens: measuredUsage.totalTokens }) } } }
      } catch (error) {
        const failure = timedOut ? { class: 'timeout' as const, retryable: true, reason: 'Agent execution timed out.' } : classifyFailure(error)
        const status = timedOut ? 'timeout' as const : controller.signal.aborted ? 'cancelled' as const : 'failed' as const
        return { status, output: {}, diff: '', usage: { status: 'unknown' }, durationMs: duration(Date.now() - started), failure, metadata: { assurance, telemetry: { status: 'unknown', durationMs: duration(Date.now() - started) } } }
      } finally {
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
    },
  }
}

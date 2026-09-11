import { fail } from './errors.js'

export type FailureClass = 'quota' | 'timeout' | 'policy' | 'validation' | 'external' | 'unknown'

export interface FailureClassification {
  readonly class: FailureClass
  readonly retryable: boolean
  readonly reason: string
}

export interface RecoveryPolicy {
  readonly maxAttempts: number
  readonly baseDelayMs: number
  readonly maxDelayMs: number
  readonly timeoutMs?: number
}

export interface RecoveryObservation {
  readonly attempt: number
  readonly failure: FailureClassification
  readonly delayMs: number
}

export interface RecoveryResult<T> {
  readonly value?: T
  readonly status: 'completed' | 'failed'
  readonly attempts: number
  readonly observations: readonly RecoveryObservation[]
  readonly failure?: FailureClassification
}

const positiveInteger = (value: number, label: string): number => {
  if (!Number.isInteger(value) || value < 1) fail(`${label} must be a positive integer.`, 'INVALID_INPUT')
  return value
}

const nonNegativeInteger = (value: number, label: string): number => {
  if (!Number.isInteger(value) || value < 0) fail(`${label} must be a non-negative integer.`, 'INVALID_INPUT')
  return value
}

export const classifyFailure = (error: unknown): FailureClassification => {
  const value = error as { readonly code?: unknown; readonly message?: unknown }
  const code = typeof value?.code === 'string' ? value.code.toUpperCase() : ''
  const message = typeof value?.message === 'string' ? value.message : String(error)
  const text = `${code} ${message}`.toLowerCase()
  if (/quota|rate.?limit|too many requests|429/.test(text)) return { class: 'quota', retryable: true, reason: message }
  if (/timeout|timed out|deadline/.test(text)) return { class: 'timeout', retryable: true, reason: message }
  if (/policy|forbidden|permission|approval/.test(text)) return { class: 'policy', retryable: false, reason: message }
  if (/invalid|schema|argument|config|validation/.test(text)) return { class: 'validation', retryable: false, reason: message }
  if (/network|connection|econn|503|502|external/.test(text)) return { class: 'external', retryable: true, reason: message }
  return { class: 'unknown', retryable: false, reason: message }
}

export const recoveryDelayMs = (attempt: number, policy: Pick<RecoveryPolicy, 'baseDelayMs' | 'maxDelayMs'>): number => {
  positiveInteger(attempt, 'attempt')
  nonNegativeInteger(policy.baseDelayMs, 'baseDelayMs')
  nonNegativeInteger(policy.maxDelayMs, 'maxDelayMs')
  if (policy.maxDelayMs < policy.baseDelayMs) fail('maxDelayMs must be greater than or equal to baseDelayMs.', 'INVALID_INPUT')
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * (2 ** Math.max(0, attempt - 1)))
}

const wait = (delayMs: number, sleep: (delayMs: number) => Promise<void>): Promise<void> => delayMs > 0 ? sleep(delayMs) : Promise.resolve()

export const runWithRecovery = async <T>(operation: (signal: AbortSignal, attempt: number) => Promise<T>, options: RecoveryPolicy & { readonly sleep?: (delayMs: number) => Promise<void>; readonly onObservation?: (observation: RecoveryObservation) => void }): Promise<RecoveryResult<T>> => {
  const maxAttempts = positiveInteger(options.maxAttempts, 'maxAttempts')
  const baseDelayMs = nonNegativeInteger(options.baseDelayMs, 'baseDelayMs')
  const maxDelayMs = nonNegativeInteger(options.maxDelayMs, 'maxDelayMs')
  if (maxDelayMs < baseDelayMs) fail('maxDelayMs must be greater than or equal to baseDelayMs.', 'INVALID_INPUT')
  if (options.timeoutMs !== undefined) positiveInteger(options.timeoutMs, 'timeoutMs')
  const sleep = options.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)))
  const observations: RecoveryObservation[] = []
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController()
    let timer: NodeJS.Timeout | undefined
    try {
      const operationPromise = operation(controller.signal, attempt)
      const value = options.timeoutMs === undefined ? await operationPromise : await Promise.race([
        operationPromise,
        new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('operation timed out')) }, options.timeoutMs) }),
      ])
      return { status: 'completed', attempts: attempt, observations, value }
    } catch (error) {
      const failure = classifyFailure(error)
      const delayMs = failure.retryable && attempt < maxAttempts ? recoveryDelayMs(attempt, { baseDelayMs, maxDelayMs }) : 0
      const observation = { attempt, failure, delayMs }
      observations.push(observation)
      options.onObservation?.(observation)
      if (!failure.retryable || attempt >= maxAttempts) return { status: 'failed', attempts: attempt, observations, failure }
      await wait(delayMs, sleep)
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  return fail('Recovery loop exhausted unexpectedly.', 'HARNESS_ERROR')
}

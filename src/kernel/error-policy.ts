import { HarnessError, HARNESS_ERROR_CODES } from './errors.js'
import type { HarnessErrorCode } from './errors.js'

export type HarnessErrorDisposition = 'retry' | 'block' | 'escalate'

export interface HarnessErrorClassification {
  readonly code: HarnessErrorCode
  readonly disposition: HarnessErrorDisposition
  readonly retryable: boolean
  readonly message: string
}

type ErrorDescriptor = Readonly<Pick<HarnessErrorClassification, 'disposition' | 'retryable'>>

export const HARNESS_ERROR_CATALOG: Readonly<Record<HarnessErrorCode, ErrorDescriptor>> = {
  HARNESS_ERROR: { disposition: 'escalate', retryable: false },
  INVALID_CONFIG: { disposition: 'block', retryable: false },
  INVALID_INPUT: { disposition: 'block', retryable: false },
  INVALID_STATE: { disposition: 'block', retryable: false },
  POLICY_BLOCKED: { disposition: 'block', retryable: false },
  CLARIFYING: { disposition: 'block', retryable: false },
  STALE: { disposition: 'block', retryable: false },
  WORKTREE_DIRTY: { disposition: 'block', retryable: false },
  ACTIVE_RUN: { disposition: 'retry', retryable: true },
  NO_RUN: { disposition: 'block', retryable: false },
  HUMAN_APPROVAL_REQUIRED: { disposition: 'block', retryable: false },
  GIT_REQUIRED: { disposition: 'block', retryable: false },
}

const nonEmpty = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new HarnessError(`${label} is required.`, 'INVALID_INPUT')
  return value.trim()
}

export const classifyHarnessError = (error: unknown): HarnessErrorClassification => {
  const code = error instanceof HarnessError ? error.code : 'HARNESS_ERROR'
  const descriptor = HARNESS_ERROR_CATALOG[code]
  return { code, ...descriptor, message: error instanceof Error ? error.message : String(error) }
}

export const validateHarnessErrorClassification = (value: unknown): HarnessErrorClassification => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HarnessError('Error classification must be an object.', 'INVALID_INPUT')
  const candidate = value as Record<string, unknown>
  const code = candidate['code']
  if (typeof code !== 'string' || !(HARNESS_ERROR_CODES as readonly string[]).includes(code)) throw new HarnessError('Error classification code is invalid.', 'INVALID_INPUT')
  const expected = HARNESS_ERROR_CATALOG[code as HarnessErrorCode]
  if (candidate['disposition'] !== expected.disposition || candidate['retryable'] !== expected.retryable) throw new HarnessError(`Error classification for ${code} is inconsistent.`, 'INVALID_INPUT')
  return { code: code as HarnessErrorCode, disposition: expected.disposition, retryable: expected.retryable, message: nonEmpty(candidate['message'], 'Error classification message') }
}

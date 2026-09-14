import { describe, expect, it } from 'vitest'
import { HarnessError, classifyHarnessError, validateHarnessErrorClassification } from '../src/index.js'

describe('classifyHarnessError', () => {
  it('reads the message from a non-HarnessError Error, and stringifies a non-Error thrown value', () => {
    expect(classifyHarnessError(new Error('plain failure')).message).toBe('plain failure')
    expect(classifyHarnessError('a string error')).toMatchObject({ code: 'HARNESS_ERROR', message: 'a string error' })
    expect(classifyHarnessError(42)).toMatchObject({ message: '42' })
  })
})

describe('validateHarnessErrorClassification', () => {
  it('rejects a non-object value', () => {
    expect(() => validateHarnessErrorClassification(null)).toThrow(/must be an object/)
    expect(() => validateHarnessErrorClassification([])).toThrow(/must be an object/)
  })

  it('rejects an unrecognised or missing code', () => {
    expect(() => validateHarnessErrorClassification({ code: 'NOT_A_REAL_CODE', disposition: 'block', retryable: false, message: 'x' })).toThrow(/code is invalid/)
    expect(() => validateHarnessErrorClassification({ disposition: 'block', retryable: false, message: 'x' })).toThrow(/code is invalid/)
  })

  it('rejects a blank message', () => {
    expect(() => validateHarnessErrorClassification({ code: 'INVALID_INPUT', disposition: 'block', retryable: false, message: '' })).toThrow(/message is required/)
  })

  it('accepts a valid classification for every catalog entry', () => {
    const classification = classifyHarnessError(new HarnessError('busy', 'ACTIVE_RUN'))
    expect(validateHarnessErrorClassification(classification)).toEqual(classification)
  })
})

import { expect, it } from 'vitest'
import { isRecord } from '../src/record.js'

it('accepts non-null non-array objects without checking their prototype', () => {
  expect(isRecord({})).toBe(true)
  expect(isRecord(Object.create(null))).toBe(true)
  expect(isRecord(new Date())).toBe(true)
  expect(isRecord(null)).toBe(false)
  expect(isRecord([])).toBe(false)
})

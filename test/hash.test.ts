import { expect, it } from 'vitest'
import { hashCanonicalJson, hashJson, hashJsonMatches, sha256 } from '../src/kernel/hash.js'

it('hashes canonical JSON and preserves the JSON round-trip for undefined fields', () => {
  const value = { z: 1, omitted: undefined, nested: { y: 2, x: 3 } }
  const roundTripped = JSON.parse(JSON.stringify(value)) as unknown
  expect(hashCanonicalJson(value)).toBe(hashCanonicalJson(roundTripped))
  expect(hashCanonicalJson({ b: 2, a: 1 })).toBe(hashCanonicalJson({ a: 1, b: 2 }))
})

it('accepts legacy fingerprints and hashes only the bytes in an ArrayBufferView', () => {
  const value = { b: 2, a: 1 }
  expect(hashJsonMatches(value, hashJson(value))).toBe(true)
  expect(hashJsonMatches({ ...value, a: 3 }, hashJson(value))).toBe(false)

  const bytes = new Uint8Array([1, 2, 3])
  expect(sha256(new DataView(bytes.buffer, 1, 1))).toBe(sha256(bytes.subarray(1, 2)))
})

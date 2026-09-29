import { canonicalJson, sha256Hex } from '@agentskit/core/hash'

export const sha256 = (value: string | NodeJS.ArrayBufferView): string => sha256Hex(
  typeof value === 'string' ? value : new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
)

/** Hash JSON with the historic property-order behavior used by persisted Harness identities. */
export const hashJson = (value: unknown): string => {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new TypeError('Cannot hash a value without a JSON representation')
  return sha256(serialized)
}

/** Hash RFC 8785 canonical JSON for versioned data and new fingerprints. */
export const hashCanonicalJson = (value: unknown): string => sha256(canonicalJson(value))

/** Validate fingerprints produced either before or after the canonical hash migration. */
export const hashJsonMatches = (value: unknown, expected: string): boolean =>
  hashCanonicalJson(value) === expected || hashJson(value) === expected

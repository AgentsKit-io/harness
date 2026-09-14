import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createCapabilityManifest, validateCapabilityManifest } from '../src/index.js'
import type { CapabilityDescriptor, CapabilityManifestInput } from '../src/index.js'

const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const capability = (overrides: Partial<CapabilityDescriptor> = {}): CapabilityDescriptor => ({ id: 'kernel', version: '1.0.0', kind: 'kernel', entryPoint: 'src/index.ts', exports: ['assessDiscovery'], ...overrides })
const input = (overrides: Partial<CapabilityManifestInput> = {}): CapabilityManifestInput => ({ package: '@agentskit/harness', packageVersion: '0.4.0', entryPoint: 'src/index.ts', sourceDigest: digest('public surface'), capabilities: [capability()], ...overrides })

describe('createCapabilityManifest', () => {
  it('rejects a blank package/packageVersion/entryPoint', () => {
    expect(() => createCapabilityManifest(input({ package: '' }))).toThrow(/package is required/)
    expect(() => createCapabilityManifest(input({ packageVersion: '' }))).toThrow(/packageVersion is required/)
    expect(() => createCapabilityManifest(input({ entryPoint: '' }))).toThrow(/entryPoint is required/)
  })

  it('rejects a malformed sourceDigest', () => {
    expect(() => createCapabilityManifest(input({ sourceDigest: 'not-hex' }))).toThrow(/sourceDigest must be a lowercase SHA-256 digest/)
    expect(() => createCapabilityManifest(input({ sourceDigest: '' }))).toThrow(/sourceDigest is required/)
  })

  it('rejects a non-array capabilities field', () => {
    expect(() => createCapabilityManifest(input({ capabilities: 'nope' as never }))).toThrow(/capabilities must be an array/)
  })

  it('rejects a malformed capability descriptor', () => {
    expect(() => createCapabilityManifest(input({ capabilities: [null as never] }))).toThrow(/capabilities\[0\] must be an object/)
    expect(() => createCapabilityManifest(input({ capabilities: [capability({ kind: 'not-a-kind' as never })] }))).toThrow(/capabilities\[0\].kind is invalid/)
    expect(() => createCapabilityManifest(input({ capabilities: [capability({ id: '' })] }))).toThrow(/capabilities\[0\].id is required/)
  })

  it('rejects an empty, non-array, or duplicate-containing exports/dependencies list', () => {
    expect(() => createCapabilityManifest(input({ capabilities: [capability({ exports: [] })] }))).toThrow(/exports must be a non-empty string array/)
    expect(() => createCapabilityManifest(input({ capabilities: [capability({ exports: 'nope' as never })] }))).toThrow(/exports must be a non-empty string array/)
    expect(() => createCapabilityManifest(input({ capabilities: [capability({ exports: ['a', 'a'] })] }))).toThrow(/exports must not contain duplicates/)
    expect(() => createCapabilityManifest(input({ capabilities: [capability({ dependencies: ['a', 'a'] })] }))).toThrow(/dependencies must not contain duplicates/)
  })

  it('accepts a capability with an explicit dependencies list', () => {
    const manifest = createCapabilityManifest(input({ capabilities: [capability({ dependencies: ['other'] })] }))
    expect(manifest.capabilities[0]?.dependencies).toEqual(['other'])
  })

  it('rejects duplicate capability ids', () => {
    expect(() => createCapabilityManifest(input({ capabilities: [capability(), capability()] }))).toThrow(/capability ids must be unique/)
  })

  it('rejects an empty capabilities array', () => {
    expect(() => createCapabilityManifest(input({ capabilities: [] }))).toThrow(/capabilities must be non-empty/)
  })
})

describe('validateCapabilityManifest', () => {
  it('rejects a non-object value', () => {
    expect(() => validateCapabilityManifest(null)).toThrow(/must be an object/)
    expect(() => validateCapabilityManifest([])).toThrow(/must be an object/)
  })

  it('rejects a manifest whose capabilities field is not an array', () => {
    const manifest = createCapabilityManifest(input())
    expect(() => validateCapabilityManifest({ ...manifest, capabilities: 'nope' })).toThrow(/capabilities must be an array/)
  })

  it('rejects a manifest with duplicate capability ids', () => {
    const manifest = createCapabilityManifest(input())
    expect(() => validateCapabilityManifest({ ...manifest, capabilities: [...manifest.capabilities, ...manifest.capabilities] })).toThrow(/capability ids must be unique/)
  })

  it('rejects a wrong type/schemaVersion field', () => {
    const manifest = createCapabilityManifest(input())
    expect(() => validateCapabilityManifest({ ...manifest, type: 'something-else' })).toThrow(/type or schemaVersion is invalid/)
    expect(() => validateCapabilityManifest({ ...manifest, schemaVersion: 2 })).toThrow(/type or schemaVersion is invalid/)
  })

  it('rejects a malformed digest field', () => {
    const manifest = createCapabilityManifest(input())
    expect(() => validateCapabilityManifest({ ...manifest, digest: 'not-hex' })).toThrow(/digest must be a lowercase SHA-256 digest/)
  })
})

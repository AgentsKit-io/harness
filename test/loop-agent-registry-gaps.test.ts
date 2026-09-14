import { describe, expect, it } from 'vitest'
import { loadAgentRegistry, parseAgentRegistryText, resolveAgentForRole } from '../src/index.js'

const sample = `
schemaVersion: 1
agents:
  builder-primary:
    role: builder
    provider: codex
roles:
  builder: builder-primary
`

describe('parseAgentRegistryText', () => {
  it('fails closed on malformed YAML', () => {
    expect(() => parseAgentRegistryText(':\n  - not: [valid')).toThrow(/Invalid agents.registry.yaml/)
  })

  it('reports a root-level schema issue without a field path', () => {
    expect(() => parseAgentRegistryText('not-an-object')).toThrow(/\(root\)/)
  })
})

describe('loadAgentRegistry validation', () => {
  it('rejects a blank or non-string path', () => {
    expect(() => loadAgentRegistry('  ')).toThrow(/Agent registry path is required/)
    expect(() => loadAgentRegistry(undefined as never)).toThrow(/Agent registry path is required/)
  })
})

describe('resolveAgentForRole validation', () => {
  it('rejects a non-object registry', () => {
    expect(() => resolveAgentForRole(null as never, 'builder')).toThrow(/Agent registry is required/)
  })

  it('rejects a blank role', () => {
    const registry = parseAgentRegistryText(sample)
    expect(() => resolveAgentForRole(registry, '  ')).toThrow(/Agent role is required/)
    expect(() => resolveAgentForRole(registry, undefined as never)).toThrow(/Agent role is required/)
  })
})

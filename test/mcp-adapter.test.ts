import { expect, it } from 'vitest'
import { createMcpToolBridge, createPolicyGate, hashMcpArgs } from '../src/index.js'

it('blocks tools outside the allowlist without calling the underlying handler', async () => {
  let called = 0
  const bridge = createMcpToolBridge({
    policy: createPolicyGate({ rules: [{ id: 'allow-search', effect: 'allow', toolIds: ['search'], reason: 'read-only search' }] }),
    allowTools: ['search'],
    call: async () => { called += 1; return { hits: 1 } },
  })
  await expect(bridge.invoke({ toolId: 'shell', args: { cmd: 'ls' } })).resolves.toEqual({
    status: 'blocked',
    reason: 'Tool is not in the MCP allowlist: shell.',
  })
  expect(called).toBe(0)
})

it('blocks when the policy gate denies even if the tool is allowlisted', async () => {
  let called = 0
  const bridge = createMcpToolBridge({
    policy: createPolicyGate({ rules: [{ id: 'block-write', effect: 'block', toolIds: ['write'], reason: 'writes disabled' }] }),
    allowTools: ['write'],
    call: async () => { called += 1; return 'ok' },
  })
  await expect(bridge.invoke({ toolId: 'write', args: { path: 'x' } })).resolves.toEqual({
    status: 'blocked',
    reason: 'writes disabled',
  })
  expect(called).toBe(0)
})

it('hashes args when omitted, calls on allow, and accepts a plain evaluate policy', async () => {
  const seen: Array<{ toolId: string; argsHash: string; args: unknown }> = []
  const bridge = createMcpToolBridge({
    policy: {
      evaluate: (request) => ({ decision: 'allow', policyId: 'inline', reason: `allowed ${request.toolId}` }),
    },
    allowTools: ['search'],
    call: async (toolId, argsHash, args) => {
      seen.push({ toolId, argsHash, args })
      return { hits: [{ id: '1' }] }
    },
  })
  const args = { q: 'harness' }
  const result = await bridge.invoke({ toolId: 'search', args })
  expect(result).toEqual({ status: 'ok', result: { hits: [{ id: '1' }] } })
  expect(seen).toEqual([{ toolId: 'search', argsHash: hashMcpArgs(args), args }])

  const explicit = await createMcpToolBridge({
    policy: createPolicyGate({ rules: [{ id: 'allow-search', effect: 'allow', toolIds: ['search'], reason: 'ok' }] }),
    allowTools: ['search'],
    call: async (_toolId, argsHash) => argsHash,
  }).invoke({ toolId: 'search', args: { q: 'x' }, argsHash: 'precomputed' })
  expect(explicit).toEqual({ status: 'ok', result: 'precomputed' })
})

it('treats approve decisions as blocked because 0.6.0 has no MCP approval path', async () => {
  let called = 0
  const bridge = createMcpToolBridge({
    policy: createPolicyGate({ rules: [{ id: 'approve-delete', effect: 'approve', toolIds: ['delete'], reason: 'needs human' }] }),
    allowTools: ['delete'],
    call: async () => { called += 1; return true },
  })
  await expect(bridge.invoke({ toolId: 'delete' })).resolves.toMatchObject({ status: 'blocked', reason: 'needs human' })
  expect(called).toBe(0)
})

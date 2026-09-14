import { expect, it } from 'vitest'
import { HarnessError, createMcpToolBridge, createPolicyGate, hashMcpArgs } from '../src/index.js'

const okPolicy = createPolicyGate({ rules: [{ id: 'allow-search', effect: 'allow', toolIds: ['search'], reason: 'ok' }] })

it('rejects construction with a policy that has no evaluate function', () => {
  // @ts-expect-error — exercising the runtime guard for a malformed policy
  expect(() => createMcpToolBridge({ policy: {}, allowTools: ['search'], call: async () => undefined })).toThrow(HarnessError)
})

it('rejects construction when allowTools is not an array of non-empty strings', () => {
  // @ts-expect-error — exercising the runtime guard for a malformed allowTools
  expect(() => createMcpToolBridge({ policy: okPolicy, allowTools: 'search', call: async () => undefined })).toThrow(HarnessError)
  expect(() => createMcpToolBridge({ policy: okPolicy, allowTools: ['search', ''], call: async () => undefined })).toThrow(HarnessError)
  expect(() => createMcpToolBridge({ policy: okPolicy, allowTools: ['search', '  '], call: async () => undefined })).toThrow(HarnessError)
})

it('rejects construction without a call function', () => {
  // @ts-expect-error — exercising the runtime guard for a missing call function
  expect(() => createMcpToolBridge({ policy: okPolicy, allowTools: ['search'] })).toThrow(HarnessError)
})

it('rejects an invoke input that is not a plain object', async () => {
  const bridge = createMcpToolBridge({ policy: okPolicy, allowTools: ['search'], call: async () => undefined })
  // @ts-expect-error — exercising the runtime guard for a malformed invoke input
  await expect(bridge.invoke(null)).rejects.toThrow(HarnessError)
  // @ts-expect-error — exercising the runtime guard for a malformed invoke input
  await expect(bridge.invoke(['search'])).rejects.toThrow(HarnessError)
})

it('rejects an invoke input with a missing or blank toolId', async () => {
  const bridge = createMcpToolBridge({ policy: okPolicy, allowTools: ['search'], call: async () => undefined })
  // @ts-expect-error — exercising the runtime guard for a missing toolId
  await expect(bridge.invoke({})).rejects.toThrow(HarnessError)
  await expect(bridge.invoke({ toolId: '  ' })).rejects.toThrow(HarnessError)
})

it('rejects a policy decision with an unrecognised decision value', async () => {
  const bridge = createMcpToolBridge({
    policy: { evaluate: () => ({ decision: 'maybe', policyId: 'bad' } as never) },
    allowTools: ['search'],
    call: async () => undefined,
  })
  await expect(bridge.invoke({ toolId: 'search' })).rejects.toThrow(/MCP policy decision is invalid/)
})

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

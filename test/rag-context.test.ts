import { expect, it } from 'vitest'
import { createArgvRagContextProvider, createRagContextProvider, hashContextSnapshot, parseRagQueryOutput } from '../src/index.js'
import type { CommandResult, CommandRunner } from '../src/index.js'

const references = [{ id: 'chunk-1', uri: 'rag://docs/a.md', title: 'A', relevance: 0.9 }] as const

it('wraps an injected query into a ContextProvider with stable snapshot hashes and token telemetry', async () => {
  const provider = createRagContextProvider({
    query: async () => ({ references: [...references], sourceHash: 'b'.repeat(64) }),
  })
  const query = { query: 'harness', scope: ['playbook'] }
  const first = await provider.resolve(query)
  const second = await provider.resolve(query)
  expect(provider.id).toBe('rag')
  expect(first.references.map((item) => item.id)).toEqual(['chunk-1'])
  expect(first.sourceHash).toBe('b'.repeat(64))
  expect(first.snapshotHash).toBe(second.snapshotHash)
  expect(first.snapshotHash).toBe(hashContextSnapshot({ providerId: 'rag', query, references: first.references, sourceHash: first.sourceHash }))
  expect(first.assurance).toBe('contract-tested')
  expect(first.telemetry).toMatchObject({ status: 'measured', contextReferences: 1 })
  expect(first.telemetry?.contextCostTokens).toBe(Math.max(1, Math.ceil(JSON.stringify(first.references).length / 4)))
})

it('parses ContextSnapshot-shaped and partial RAG stdout and fails closed on bad payloads', () => {
  expect(parseRagQueryOutput({ references: [...references], sourceHash: 'hash' })).toEqual({ references: [...references], sourceHash: 'hash' })
  expect(parseRagQueryOutput({ providerId: 'rag', query: { query: 'x' }, references: [...references], sourceHash: 'hash', snapshotHash: 'ignored', resolvedAt: 'now' }).sourceHash).toBe('hash')
  expect(() => parseRagQueryOutput(null)).toThrow(/JSON object/)
  expect(() => parseRagQueryOutput({ references: [{ id: 'x' }], sourceHash: 'hash' })).toThrow(/uri/)
  expect(() => parseRagQueryOutput({ references: [], sourceHash: '' })).toThrow(/sourceHash/)
})

it('runs argv through CommandRunner, substitutes query placeholders, and fails closed on bad exits', async () => {
  const calls: string[][] = []
  const runner: CommandRunner = {
    run: async (argv) => {
      calls.push([...argv])
      return { code: 0, stdout: JSON.stringify({ references: [...references], sourceHash: 'argv-hash' }), stderr: '', timedOut: false, durationMs: 2 }
    },
  }
  const provider = createArgvRagContextProvider({
    runner,
    argv: ['rag-query', '--q', '{query}', '--scope', '{scope}'],
    timeoutMs: 1_000,
  })
  const snapshot = await provider.resolve({ query: 'portable harness', scope: ['docs'] })
  expect(calls[0]).toEqual(['rag-query', '--q', 'portable harness', '--scope', JSON.stringify(['docs'])])
  expect(snapshot).toMatchObject({ providerId: 'rag', sourceHash: 'argv-hash', references: [{ id: 'chunk-1' }], telemetry: { status: 'measured', contextReferences: 1 } })

  const failing: CommandRunner = {
    run: async (): Promise<CommandResult> => ({ code: 2, stdout: '', stderr: 'boom', timedOut: false, durationMs: 1 }),
  }
  await expect(createArgvRagContextProvider({ runner: failing, argv: ['rag-query'] }).resolve({ query: 'x' })).rejects.toThrow(/exited with code 2/)

  const badJson: CommandRunner = {
    run: async () => ({ code: 0, stdout: 'not-json', stderr: '', timedOut: false, durationMs: 1 }),
  }
  await expect(createArgvRagContextProvider({ runner: badJson, argv: ['rag-query'] }).resolve({ query: 'x' })).rejects.toThrow(/valid JSON/)
})

it('rejects a reference relevance outside 0-1, and reads optional title/version/contentHash when present', () => {
  expect(() => parseRagQueryOutput({ references: [{ id: 'x', uri: 'u', relevance: 1.1 }], sourceHash: 'h' })).toThrow(/relevance must be between 0 and 1/)
  expect(() => parseRagQueryOutput({ references: [{ id: 'x', uri: 'u', relevance: -0.1 }], sourceHash: 'h' })).toThrow(/relevance must be between 0 and 1/)
  const full = parseRagQueryOutput({ references: [{ id: 'x', uri: 'u', title: 't', version: 'v1', contentHash: 'c' }], sourceHash: 'h' })
  expect(full.references[0]).toMatchObject({ title: 't', version: 'v1', contentHash: 'c' })
})

it('rejects a non-object RAG query output and a non-array references field', () => {
  expect(() => parseRagQueryOutput('nope')).toThrow(/must be a JSON object/)
  expect(() => parseRagQueryOutput({ references: 'nope', sourceHash: 'h' })).toThrow(/references must be an array/)
})

it('createRagContextProvider rejects a missing or non-function query, and an invalid result shape from it', async () => {
  expect(() => createRagContextProvider({ query: undefined as never })).toThrow(/requires a query function/)
  const badShape = createRagContextProvider({ query: async () => ({ references: 'nope', sourceHash: 'h' }) as never })
  await expect(badShape.resolve({ query: 'x' })).rejects.toThrow(/returned an invalid result/)
  const noSourceHash = createRagContextProvider({ query: async () => ({ references: [], sourceHash: '' }) })
  await expect(noSourceHash.resolve({ query: 'x' })).rejects.toThrow(/returned an invalid result/)
})

it('createArgvRagContextProvider rejects a missing runner, an empty/malformed argv, and an invalid timeoutMs', () => {
  expect(() => createArgvRagContextProvider({ runner: undefined as never, argv: ['x'] })).toThrow(/requires a CommandRunner/)
  expect(() => createArgvRagContextProvider({ runner: { run: async () => ({}) as never }, argv: [] })).toThrow(/non-empty argv/)
  expect(() => createArgvRagContextProvider({ runner: { run: async () => ({}) as never }, argv: [''] })).toThrow(/non-empty argv/)
  expect(() => createArgvRagContextProvider({ runner: { run: async () => ({}) as never }, argv: ['x'], timeoutMs: 0 })).toThrow(/timeoutMs must be a positive number/)
})

it('createArgvRagContextProvider fails closed on a timeout, and passes cwd through when provided', async () => {
  const timedOutRunner: CommandRunner = { run: async () => ({ code: null, stdout: '', stderr: '', timedOut: true, durationMs: 1 }) }
  await expect(createArgvRagContextProvider({ runner: timedOutRunner, argv: ['rag-query'] }).resolve({ query: 'x' })).rejects.toThrow(/timed out after/)

  const calls: unknown[] = []
  const trackingRunner: CommandRunner = { run: async (_argv, options) => { calls.push(options); return { code: 0, stdout: JSON.stringify({ references: [], sourceHash: 'h' }), stderr: '', timedOut: false, durationMs: 1 } } }
  await createArgvRagContextProvider({ runner: trackingRunner, argv: ['rag-query'], cwd: '/work' }).resolve({ query: 'x' })
  expect(calls[0]).toMatchObject({ cwd: '/work' })
})

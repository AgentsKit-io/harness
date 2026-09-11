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

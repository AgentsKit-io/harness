import { describe, expect, it } from 'vitest'
import { createCodingAgentAdapter } from '../src/index.js'

const baseRequest = { issueRef: 'ENG-1', prompt: 'build', sourceRevision: 'rev' } as const

describe('createCodingAgentAdapter: constructor guards', () => {
  it('rejects a blank id or version', () => {
    expect(() => createCodingAgentAdapter({ id: '', version: '1', execute: async () => ({ output: {}, diff: '' }) })).toThrow(/agent.id is required/)
    expect(() => createCodingAgentAdapter({ id: 'a', version: '', execute: async () => ({ output: {}, diff: '' }) })).toThrow(/agent.version is required/)
  })

  it('rejects a non-positive or non-integer timeoutMs', () => {
    expect(() => createCodingAgentAdapter({ id: 'a', version: '1', timeoutMs: 0, execute: async () => ({ output: {}, diff: '' }) })).toThrow(/timeoutMs must be a positive integer/)
    expect(() => createCodingAgentAdapter({ id: 'a', version: '1', timeoutMs: 1.5, execute: async () => ({ output: {}, diff: '' }) })).toThrow(/timeoutMs must be a positive integer/)
  })
})

describe('createCodingAgentAdapter: request validation', () => {
  it('rejects a blank issueRef, prompt, or sourceRevision', async () => {
    const adapter = createCodingAgentAdapter({ id: 'a', version: '1', execute: async () => ({ output: {}, diff: '' }) })
    await expect(adapter.execute({ ...baseRequest, issueRef: '' })).rejects.toThrow(/issueRef is required/)
    await expect(adapter.execute({ ...baseRequest, prompt: '' })).rejects.toThrow(/prompt is required/)
    await expect(adapter.execute({ ...baseRequest, sourceRevision: '' })).rejects.toThrow(/sourceRevision is required/)
  })

  it('passes contextHash through to the handler only when provided', async () => {
    const seen: unknown[] = []
    const adapter = createCodingAgentAdapter({ id: 'a', version: '1', execute: async (request) => { seen.push(request.contextHash); return { output: {}, diff: '' } } })
    await adapter.execute({ ...baseRequest, contextHash: 'ctx-hash' })
    await adapter.execute(baseRequest)
    expect(seen).toEqual(['ctx-hash', undefined])
  })
})

describe('createCodingAgentAdapter: result validation', () => {
  it('rejects a handler result missing structured output or a string diff', async () => {
    const missingOutput = createCodingAgentAdapter({ id: 'a', version: '1', execute: async () => ({ diff: 'x' } as never) })
    await expect(missingOutput.execute(baseRequest)).resolves.toMatchObject({ status: 'failed' })
    const arrayOutput = createCodingAgentAdapter({ id: 'a', version: '1', execute: async () => ({ output: [] as never, diff: 'x' }) })
    await expect(arrayOutput.execute(baseRequest)).resolves.toMatchObject({ status: 'failed' })
    const nonStringDiff = createCodingAgentAdapter({ id: 'a', version: '1', execute: async () => ({ output: {}, diff: 1 as never }) })
    await expect(nonStringDiff.execute(baseRequest)).resolves.toMatchObject({ status: 'failed' })
  })

  it('rejects an invalid usage status or a negative usage token count', async () => {
    const badStatus = createCodingAgentAdapter({ id: 'a', version: '1', execute: async () => ({ output: {}, diff: '', usage: { status: 'guessing' as never } }) })
    await expect(badStatus.execute(baseRequest)).resolves.toMatchObject({ status: 'failed' })
    const negativeTokens = createCodingAgentAdapter({ id: 'a', version: '1', execute: async () => ({ output: {}, diff: '', usage: { status: 'measured', inputTokens: -1 } }) })
    await expect(negativeTokens.execute(baseRequest)).resolves.toMatchObject({ status: 'failed' })
  })

  it('defaults usage to unknown when the handler omits it', async () => {
    const adapter = createCodingAgentAdapter({ id: 'a', version: '1', execute: async () => ({ output: {}, diff: '' }) })
    await expect(adapter.execute(baseRequest)).resolves.toMatchObject({ usage: { status: 'unknown' } })
  })
})

describe('createCodingAgentAdapter: mid-execution cancellation', () => {
  it('reports cancelled (not failed) when the caller aborts while the handler is still running', async () => {
    let sawAbort = false
    const adapter = createCodingAgentAdapter({
      id: 'a', version: '1',
      execute: (request) => new Promise((_resolve, reject) => {
        request.signal.addEventListener('abort', () => { sawAbort = true; reject(new Error('aborted')) })
      }),
    })
    const controller = new AbortController()
    const pending = adapter.execute({ ...baseRequest, signal: controller.signal })
    controller.abort()
    await expect(pending).resolves.toMatchObject({ status: 'cancelled' })
    expect(sawAbort).toBe(true)
  })
})

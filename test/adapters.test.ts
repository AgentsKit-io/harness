import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createCodingAgentAdapter, createDocBridgeContextProvider, createInMemoryMemoryAdapter, createLlmCache, createOrcaLifecycleProjection, createProcessToolRuntime, createDockerToolRuntime, createTrackingAdapter, createTrackingTransition, validateAdapterMetadata } from '../src/index.js'

it('returns structured coding-agent output, usage, timeout, cancellation, and classified failure', async () => {
  const adapter = createCodingAgentAdapter({ id: 'fake-agent', version: '1', timeoutMs: 10, execute: async ({ prompt }) => ({ output: { prompt }, diff: 'diff --git', usage: { status: 'measured', inputTokens: 2, outputTokens: 3, totalTokens: 5 } }) })
  await expect(adapter.execute({ issueRef: 'ENG-1', prompt: 'build', sourceRevision: 'rev' })).resolves.toMatchObject({ status: 'completed', diff: 'diff --git', usage: { totalTokens: 5 }, metadata: { assurance: 'contract-tested', telemetry: { status: 'measured', totalTokens: 5 } } })
  const timeout = createCodingAgentAdapter({ id: 'slow-agent', version: '1', timeoutMs: 5, execute: async () => new Promise(() => {}) })
  await expect(timeout.execute({ issueRef: 'ENG-1', prompt: 'build', sourceRevision: 'rev' })).resolves.toMatchObject({ status: 'timeout', failure: { class: 'timeout', retryable: true } })
  const controller = new AbortController(); controller.abort()
  await expect(adapter.execute({ issueRef: 'ENG-1', prompt: 'build', sourceRevision: 'rev', signal: controller.signal })).resolves.toMatchObject({ status: 'cancelled' })
  const failed = createCodingAgentAdapter({ id: 'failing-agent', version: '1', execute: async () => { throw new Error('rate limit exceeded') } })
  await expect(failed.execute({ issueRef: 'ENG-1', prompt: 'build', sourceRevision: 'rev' })).resolves.toMatchObject({ status: 'failed', failure: { class: 'quota', retryable: true } })
})

it('projects Orca lease/worktree/lock/resume and remote SHA cleanup gates', () => {
  expect(createOrcaLifecycleProjection({ issueRef: 'ENG-1', repository: 'org/repo', worktree: 'eng-1', branch: 'codex/eng-1', leaseState: 'acquired', issueLock: 'held' })).toMatchObject({ status: 'ready', cleanupAllowed: false, remoteShaConfirmed: false })
  expect(createOrcaLifecycleProjection({ issueRef: 'ENG-1', repository: 'org/repo', worktree: 'eng-1', branch: 'codex/eng-1', leaseState: 'resumed', issueLock: 'held' })).toMatchObject({ status: 'resume' })
  expect(createOrcaLifecycleProjection({ issueRef: 'ENG-1', repository: 'org/repo', worktree: 'eng-1', branch: 'codex/eng-1', leaseState: 'conflict', issueLock: 'held' })).toMatchObject({ status: 'blocked' })
  expect(createOrcaLifecycleProjection({ issueRef: 'ENG-1', repository: 'org/repo', worktree: 'eng-1', branch: 'codex/eng-1', leaseState: 'released', issueLock: 'held', expectedRemoteSha: 'abc', observedRemoteSha: 'abc', cleanupRequested: true })).toMatchObject({ status: 'ready', remoteShaConfirmed: true, cleanupAllowed: true })
  expect(createOrcaLifecycleProjection({ issueRef: 'ENG-1', repository: 'org/repo', worktree: 'eng-1', branch: 'codex/eng-1', leaseState: 'released', issueLock: 'held', expectedRemoteSha: 'abc', observedRemoteSha: 'def', cleanupRequested: true })).toMatchObject({ status: 'escalated', cleanupAllowed: false })
})

it('reports Doc Bridge context cost/relevance and memory/cache telemetry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentskit-harness-adapter-test-')); mkdirSync(join(root, '.doc-bridge'))
  writeFileSync(join(root, '.doc-bridge/index.json'), JSON.stringify({ contentHash: 'a'.repeat(64), knowledge: [{ id: 'doc', path: 'doc.md', title: 'Harness', body: 'deterministic harness' }] }))
  const context = await createDocBridgeContextProvider({ root }).resolve({ query: 'harness' })
  expect(context).toMatchObject({ assurance: 'contract-tested', telemetry: { status: 'measured', contextReferences: 1 } })
  expect(context.references[0]?.relevance).toBe(1)
  const memory = createInMemoryMemoryAdapter(); await memory.remember({ id: 'm', scope: 'global', summary: 'decision', source: 'ENG-1', sourceRevision: 'rev', contentHash: 'hash', approved: true }); await memory.recall({ query: 'decision', sourceRevision: 'rev' })
  expect(memory.telemetry?.()).toMatchObject({ status: 'measured', memoryReads: 1, memoryWrites: 1, memoryRelevantHits: 1 })
  const cache = createLlmCache<string>(); await cache.getOrCompute('k', async () => 'v'); await cache.getOrCompute('k', async () => 'unused')
  expect(cache.telemetry?.()).toMatchObject({ status: 'measured', cacheHits: 1, cacheMisses: 1 })
  expect(validateAdapterMetadata({ assurance: 'contract-tested', telemetry: { status: 'unknown' } })).toMatchObject({ assurance: 'contract-tested' })
})

it('keeps tracking effects idempotent and dry-run side-effect free while runtimes declare isolation', async () => {
  let calls = 0
  const adapter = createTrackingAdapter('github', () => { calls += 1 })
  await adapter.transition({ tracker: 'github', issue: 'ENG-1', to: 'qa', reason: 'validated' }); await adapter.transition({ tracker: 'github', issue: 'ENG-1', to: 'qa', reason: 'validated' })
  expect(calls).toBe(1); expect(adapter.telemetry?.()).toMatchObject({ externalMutations: 1 })
  const dry = createTrackingAdapter('linear', () => { calls += 1 }, { dryRun: true }); await dry.transition({ tracker: 'linear', issue: 'ENG-1', to: 'qa', reason: 'validated' }); expect(calls).toBe(1); expect(dry.telemetry?.()).toMatchObject({ externalMutations: 0 })
  expect(createProcessToolRuntime({ tools: [] })).toMatchObject({ assurance: 'contract-tested', isolation: 'none' })
  expect(createDockerToolRuntime({ tools: [] })).toMatchObject({ assurance: 'runtime-attested', isolation: 'sandboxed' })
  expect(createTrackingTransition({ tracker: 'linear', issue: 'ENG-1', to: 'qa', reason: 'validated' }).idempotencyKey).toHaveLength(64)
})

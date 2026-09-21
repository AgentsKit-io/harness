import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createPolicyGate, createSessionRecorder, createToolRuntime, FileEventStore, loadConfig, planRun, startRun } from '../src/index.js'
import { initializeGitRepository } from './git.js'

const fixture = async (): Promise<{ readonly root: string; readonly run: Awaited<ReturnType<typeof startRun>> }> => {
  const root = mkdtempSync(join(tmpdir(), 'agentskit-harness-agent-gaps-test-'))
  initializeGitRepository(root)
  mkdirSync(join(root, '.ak-harness'), { recursive: true })
  const configPath = join(root, '.ak-harness', 'verification.json')
  const fs = await import('node:fs')
  fs.writeFileSync(configPath, JSON.stringify({
    schemaVersion: 1, project: 'agent-gaps-fixture', root: '..', profile: 'strict',
    contract: { intent: 'Capture an agent session.', scope: { inScope: ['fixture'], outOfScope: ['production'] }, ambiguities: [], outcomes: [{ id: 'outcome', statement: 'The fixture is valid.', checks: ['logic'] }] },
    surfaces: { logic: true, endpoint: false, database: false, cli: false, mcp: false, ui: false, docs: false },
    checks: [{ id: 'logic', category: 'logic', command: 'true', evidence: 'structured' }], tracking: { required: false, reason: 'fixture' },
  }, null, 2))
  await planRun({ configPath, decision: 'approved' })
  return { root, run: startRun(loadConfig(configPath)) }
}

const adapter = { id: 'fixture-agent', version: '1.0.0', capabilities: ['tool-calls'] } as const
const policy = createPolicyGate({ rules: [{ id: 'allow-shell', effect: 'allow', toolIds: ['shell'], reason: 'fixture allows shell' }] })
const runtime = createToolRuntime({ tools: [{ toolId: 'shell', execute: async ({ arguments: input }) => ({ echoed: input }) }] })

describe('createSessionRecorder: constructor guards', () => {
  it('rejects a policy without an evaluate function, and a runtime without an execute function', async () => {
    const { root, run } = await fixture()
    const stateDir = join(root, '.ak-harness', 'verification')
    expect(() => createSessionRecorder({ stateDir, run, adapter, policy: {} as never, runtime })).toThrow(/policy.evaluate is required/)
    expect(() => createSessionRecorder({ stateDir, run, adapter, policy, runtime: {} as never })).toThrow(/runtime.execute is required/)
  })

  it('rejects a blank sessionId', async () => {
    const { root, run } = await fixture()
    expect(() => createSessionRecorder({ stateDir: join(root, '.ak-harness', 'verification'), run, adapter, policy, runtime, sessionId: '  ' })).toThrow(/sessionId is required/)
  })
})

describe('createSessionRecorder: resume guards', () => {
  it('rejects resuming a session that never started', async () => {
    const { root, run } = await fixture()
    expect(() => createSessionRecorder({ stateDir: join(root, '.ak-harness', 'verification'), run, adapter, policy, runtime, sessionId: 'never-started', resume: true })).toThrow(/Session does not exist/)
  })

  it('rejects resuming a session that already ended', async () => {
    const { root, run } = await fixture()
    const stateDir = join(root, '.ak-harness', 'verification')
    const recorder = createSessionRecorder({ stateDir, run, adapter, policy, runtime, sessionId: 'already-ended' })
    recorder.end('completed')
    expect(() => createSessionRecorder({ stateDir, run, adapter, policy, runtime, sessionId: 'already-ended', resume: true })).toThrow(/already ended/)
  })

  it('replays a rejected approval and a completed action out of the pending/approval sets on resume', async () => {
    const { root, run } = await fixture()
    const stateDir = join(root, '.ak-harness', 'verification')
    const mixedPolicy = createPolicyGate({ rules: [{ id: 'allow-shell', effect: 'allow', toolIds: ['shell'], reason: 'fixture allows shell' }, { id: 'approve-sensitive', effect: 'approve', toolIds: ['sensitive'], reason: 'needs review' }] })
    const inProgress = createSessionRecorder({ stateDir, run, adapter, policy: mixedPolicy, runtime, sessionId: 'resume-in-progress' })
    inProgress.startTurn('input', 'turn')
    inProgress.requestTool({ turnId: 'turn', actionId: 'to-reject', toolId: 'sensitive', argumentsHash: 'hash' })
    inProgress.approveTool({ actionId: 'to-reject', decision: 'rejected' })
    inProgress.startTurn('input-2', 'turn-2')
    inProgress.requestTool({ turnId: 'turn-2', actionId: 'to-complete', toolId: 'shell', argumentsHash: 'hash-2' })
    await inProgress.executeTool({ actionId: 'to-complete', arguments: {} })

    const resumed = createSessionRecorder({ stateDir, run, adapter, policy: mixedPolicy, runtime, sessionId: 'resume-in-progress', resume: true })
    expect(() => resumed.approveTool({ actionId: 'to-reject', decision: 'approved' })).toThrow(/not awaiting human approval/)
    expect(() => resumed.completeTool({ actionId: 'to-complete', resultHash: 'x', durationMs: 0 })).toThrow(/not pending/)
    resumed.end('completed')
  })

  it('auto-releases an approved action into pending on resume when the tool.requested append never landed', async () => {
    const { root, run } = await fixture()
    const stateDir = join(root, '.ak-harness', 'verification')
    const approvalPolicy = createPolicyGate({ rules: [{ id: 'approve-sensitive', effect: 'approve', toolIds: ['sensitive'], reason: 'needs review' }] })
    const store = new FileEventStore(stateDir)
    const interrupted = createSessionRecorder({ stateDir, run, adapter, policy: approvalPolicy, runtime, sessionId: 'crash-after-approval' })
    const turn = interrupted.startTurn('input', 'turn')
    interrupted.requestTool({ turnId: turn.payload.turnId, actionId: 'approved-but-not-requeued', toolId: 'sensitive', argumentsHash: 'hash' })
    // simulate a crash between "tool.approval.recorded" and the "tool.requested" append that approveTool()
    // would normally do in the same call, by appending only the approval-recorded event directly.
    store.append({ runId: run.runId, sourceRevision: run.sourceRevision, configHash: run.configHash, sessionId: 'crash-after-approval', type: 'tool.approval.recorded', payload: { turnId: turn.payload.turnId, actionId: 'approved-but-not-requeued', toolId: 'sensitive', argumentsHash: 'hash', decision: 'approved', actor: 'human', policyId: 'approve-sensitive', reason: 'needs review' } })

    const resumed = createSessionRecorder({ stateDir, run, adapter, policy: approvalPolicy, runtime: createToolRuntime({ tools: [{ toolId: 'sensitive', execute: async () => 'recovered-after-crash' }] }), sessionId: 'crash-after-approval', resume: true })
    await expect(resumed.executeTool({ actionId: 'approved-but-not-requeued', arguments: {} })).resolves.toMatchObject({ status: 'completed' })
    resumed.end('completed')
  })
})

describe('createSessionRecorder: remaining validation branches', () => {
  it('rejects a negative durationMs on completeTool/failTool', async () => {
    const { root, run } = await fixture()
    const recorder = createSessionRecorder({ stateDir: join(root, '.ak-harness', 'verification'), run, adapter, policy, runtime })
    recorder.startTurn('input', 'turn')
    recorder.requestTool({ turnId: 'turn', actionId: 'action', toolId: 'shell', argumentsHash: 'hash' })
    expect(() => recorder.completeTool({ actionId: 'action', resultHash: 'x', durationMs: -1 })).toThrow(/non-negative number/)
  })

  it('rejects a non-boolean retryable on failTool', async () => {
    const { root, run } = await fixture()
    const recorder = createSessionRecorder({ stateDir: join(root, '.ak-harness', 'verification'), run, adapter, policy, runtime })
    recorder.startTurn('input', 'turn')
    recorder.requestTool({ turnId: 'turn', actionId: 'action', toolId: 'shell', argumentsHash: 'hash' })
    expect(() => recorder.failTool({ actionId: 'action', errorCode: 'E', retryable: 'yes' as never, durationMs: 0 })).toThrow(/retryable must be boolean/)
  })

  it('rejects starting the same turn id twice', async () => {
    const { root, run } = await fixture()
    const recorder = createSessionRecorder({ stateDir: join(root, '.ak-harness', 'verification'), run, adapter, policy, runtime })
    recorder.startTurn('input', 'turn')
    expect(() => recorder.startTurn('input-2', 'turn')).toThrow(/Turn already exists/)
  })

  it('rejects a malformed policy decision shape from requestTool', async () => {
    const { root, run } = await fixture()
    const brokenPolicy = { evaluate: () => ({ decision: 'maybe' } as never) }
    const recorder = createSessionRecorder({ stateDir: join(root, '.ak-harness', 'verification'), run, adapter, policy: brokenPolicy, runtime })
    recorder.startTurn('input', 'turn')
    expect(() => recorder.requestTool({ turnId: 'turn', actionId: 'action', toolId: 'shell', argumentsHash: 'hash' })).toThrow(/Policy decision is invalid/)
  })

  it('rejects approveTool with a non-human actor or an invalid decision value', async () => {
    const { root, run } = await fixture()
    const approvalPolicy = createPolicyGate({ rules: [{ id: 'approve-sensitive', effect: 'approve', toolIds: ['sensitive'], reason: 'needs review' }] })
    const recorder = createSessionRecorder({ stateDir: join(root, '.ak-harness', 'verification'), run, adapter, policy: approvalPolicy, runtime })
    recorder.startTurn('input', 'turn')
    recorder.requestTool({ turnId: 'turn', actionId: 'action', toolId: 'sensitive', argumentsHash: 'hash' })
    expect(() => recorder.approveTool({ actionId: 'action', decision: 'approved', actor: 'agent' as never })).toThrow(/requires a human actor/)
    expect(() => recorder.approveTool({ actionId: 'action', decision: 'maybe' as never })).toThrow(/decision is invalid/)
  })

  it('rejects recoverTool for an action that never started execution, a non-human actor, and an invalid decision', async () => {
    const { root, run } = await fixture()
    const recorder = createSessionRecorder({ stateDir: join(root, '.ak-harness', 'verification'), run, adapter, policy, runtime })
    recorder.startTurn('input', 'turn')
    recorder.requestTool({ turnId: 'turn', actionId: 'action', toolId: 'shell', argumentsHash: 'hash' })
    expect(() => recorder.recoverTool({ actionId: 'action', decision: 'retry' })).toThrow(/does not require recovery/)

    const second = await fixture()
    const stateDir2 = join(second.root, '.ak-harness', 'verification')
    const run2 = second.run
    const recorder2 = createSessionRecorder({ stateDir: stateDir2, run: run2, adapter, policy, runtime })
    const turn2 = recorder2.startTurn('input', 'turn')
    recorder2.requestTool({ turnId: turn2.payload.turnId, actionId: 'started', toolId: 'shell', argumentsHash: 'hash' })
    new FileEventStore(stateDir2).append({ runId: run2.runId, sourceRevision: run2.sourceRevision, configHash: run2.configHash, sessionId: recorder2.sessionId, type: 'tool.execution.started', payload: { turnId: turn2.payload.turnId, actionId: 'started', toolId: 'shell', attempt: 1 } })
    // recoverTool operates on the in-memory `pending` map, which this same recorder instance already has
    // marked executionStarted via its own executeTool — simulate that directly instead of a second resume.
    const resumedForRecovery = createSessionRecorder({ stateDir: stateDir2, run: run2, adapter, policy, runtime, sessionId: recorder2.sessionId, resume: true })
    expect(() => resumedForRecovery.recoverTool({ actionId: 'started', decision: 'retry', actor: 'agent' as never })).toThrow(/requires a human actor/)
    expect(() => resumedForRecovery.recoverTool({ actionId: 'started', decision: 'maybe' as never, actor: 'human' })).toThrow(/decision is invalid/)
  })

  it('rejects a concurrent call for an action already executing (as a recovery-required state, not a separate concurrency error) and an invalid runtime result shape', async () => {
    const { root, run } = await fixture()
    const stateDir = join(root, '.ak-harness', 'verification')
    let resolveExecution: (() => void) | undefined
    const slowRuntime = createToolRuntime({ tools: [{ toolId: 'shell', execute: () => new Promise((resolve) => { resolveExecution = () => resolve({ status: 'completed', resultHash: 'r', durationMs: 1 }) }) }] })
    const recorder = createSessionRecorder({ stateDir, run, adapter, policy, runtime: slowRuntime })
    recorder.startTurn('input', 'turn')
    recorder.requestTool({ turnId: 'turn', actionId: 'action', toolId: 'shell', argumentsHash: 'hash' })
    const inFlight = recorder.executeTool({ actionId: 'action', arguments: {} })
    // executeTool marks the action executionStarted synchronously before awaiting the runtime, so a second
    // concurrent call for the same action always lands on the same guard a resumed-but-interrupted action
    // would hit — there is no separate "already executing" state to distinguish it from that case.
    await expect(recorder.executeTool({ actionId: 'action', arguments: {} })).rejects.toThrow(/requires human recovery decision/)
    resolveExecution?.()
    await inFlight

    // createToolRuntime always normalizes its tool's return value into {status: 'completed'} or {status:
    // 'failed'}, so producing an out-of-contract status requires a raw ToolRuntime, bypassing that factory.
    const invalidRuntime = { execute: async () => ({ status: 'pending' } as never) }
    const recorder2 = createSessionRecorder({ stateDir, run, adapter, policy, runtime: invalidRuntime, sessionId: 'invalid-result' })
    recorder2.startTurn('input', 'turn')
    recorder2.requestTool({ turnId: 'turn', actionId: 'action-2', toolId: 'shell', argumentsHash: 'hash' })
    await expect(recorder2.executeTool({ actionId: 'action-2', arguments: {} })).rejects.toThrow(/invalid execution result/)
  })

  it('rejects an invalid end() status', async () => {
    const { root, run } = await fixture()
    const recorder = createSessionRecorder({ stateDir: join(root, '.ak-harness', 'verification'), run, adapter, policy, runtime })
    expect(() => recorder.end('done' as never)).toThrow(/status is invalid/)
  })
})

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createCodingAgentAdapter,
  createDocBridgeContextProvider,
  createPhaseProfile,
  createTrackingAdapter,
  executePhaseProfile,
  runAdversarialReview,
} from '../dist/index.js'

const root = mkdtempSync(join(tmpdir(), 'agentskit-harness-example-'))
try {
  writeFileSync(join(root, '.doc-bridge.json'), JSON.stringify({ contentHash: 'example', knowledge: [{ id: 'guide', title: 'Guide', path: 'guide.md', body: 'approved workflow' }] }))
  const profile = createPhaseProfile({ id: 'minimum', mode: 'yolo', phases: [{ id: 'implement', effect: 'write', outputs: ['result'] }], maxConcurrency: 1 })
  const agent = createCodingAgentAdapter({ id: 'fake-agent', version: '1.0.0', execute: () => ({ output: { ok: true }, diff: '', usage: { status: 'measured', inputTokens: 1, outputTokens: 1, totalTokens: 2 } }) })
  const tracking = createTrackingAdapter('fake-tracker', () => undefined, { dryRun: true })
  const docs = createDocBridgeContextProvider({ root, indexPath: '.doc-bridge.json' })
  const review = await runAdversarialReview({ lenses: [{ id: 'contract' }], binding: { candidateRevision: 'example', contractHash: 'contract', configHash: 'config' }, reviewer: () => ({ status: 'pass', evidence: 'example-review' }) })
  const transition = await tracking.transition({ tracker: 'fake', issue: 'EXAMPLE-1', to: 'qa', reason: 'example' })
  const context = await docs.resolve({ query: 'approved' })
  const execution = await executePhaseProfile(profile, { preflight: () => ({ decision: 'pass' }), handlers: { implement: () => ({ decision: 'pass', outputs: { result: 'ok' } }) } })
  console.log(JSON.stringify({ status: 'passed', profile: execution.status, agent: agent.id, review: review.decision, tracking: transition.to, contextReferences: context.references.length }))
} finally {
  rmSync(root, { recursive: true, force: true })
}

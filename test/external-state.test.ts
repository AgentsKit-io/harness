import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { loadConfig } from '../src/index.js'

it('allows evidence state outside the project root', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentskit-harness-external-state-'))
  const stateDir = mkdtempSync(join(tmpdir(), 'agentskit-harness-state-'))
  mkdirSync(join(root, '.codex'), { recursive: true })
  writeFileSync(join(root, '.codex', 'verification.json'), JSON.stringify({
    schemaVersion: 1,
    project: 'external-state-fixture',
    root: '..',
    stateDir,
    contract: { intent: 'Test external state.', scope: { inScope: ['fixture'], outOfScope: ['production'] }, ambiguities: [], outcomes: [{ id: 'logic-outcome', statement: 'The fixture passes.', checks: ['logic'] }] },
    checks: [{ id: 'logic', category: 'logic', command: 'true', evidence: 'structured' }],
    surfaces: { logic: true, endpoint: { required: false, reason: 'fixture' }, database: { required: false, reason: 'fixture' }, cli: { required: false, reason: 'fixture' }, mcp: { required: false, reason: 'fixture' }, ui: { required: false, reason: 'fixture' }, docs: { required: false, reason: 'fixture' } },
    tracking: { required: false, reason: 'fixture' },
  }))
  expect(loadConfig(join(root, '.codex', 'verification.json')).stateDir).toBe(stateDir)
  writeFileSync(join(root, '.codex', 'verification.json'), JSON.stringify({
    schemaVersion: 1,
    project: 'external-state-fixture',
    root: '..',
    stateDir: root,
    contract: { intent: 'Reject project-root state.', scope: { inScope: ['fixture'], outOfScope: ['production'] }, ambiguities: [], outcomes: [{ id: 'logic-outcome', statement: 'The fixture passes.', checks: ['logic'] }] },
    checks: [{ id: 'logic', category: 'logic', command: 'true', evidence: 'structured' }],
    surfaces: { logic: true, endpoint: { required: false, reason: 'fixture' }, database: { required: false, reason: 'fixture' }, cli: { required: false, reason: 'fixture' }, mcp: { required: false, reason: 'fixture' }, ui: { required: false, reason: 'fixture' }, docs: { required: false, reason: 'fixture' } },
    tracking: { required: false, reason: 'fixture' },
  }))
  expect(() => loadConfig(join(root, '.codex', 'verification.json'))).toThrow(/separate from the project root/)
})

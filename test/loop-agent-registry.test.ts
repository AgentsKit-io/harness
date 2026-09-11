import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { HarnessError, loadAgentRegistry, parseAgentRegistryText, resolveAgentForRole } from '../src/index.js'

const sample = `
schemaVersion: 1
agents:
  builder-primary:
    role: builder
    provider: codex
    model: gpt-5.6-luna
    tui: "codex -m {model} --full-auto"
    headless: [codex, exec, -m, "{model}", "{prompt}"]
  reviewer-primary:
    provider: claude
    model: opus
    tui: "claude --model {model}"
roles:
  reviewer: reviewer-primary
  orchestrator: builder-primary
`

it('loads a valid agents.registry.yaml and resolves roles via map or entry.role', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentskit-agent-registry-'))
  const path = join(dir, 'agents.registry.yaml')
  writeFileSync(path, sample)
  const registry = loadAgentRegistry(path)
  expect(registry.schemaVersion).toBe(1)
  expect(resolveAgentForRole(registry, 'reviewer')).toMatchObject({
    agentId: 'reviewer-primary',
    role: 'reviewer',
    entry: { provider: 'claude', model: 'opus' },
  })
  expect(resolveAgentForRole(registry, 'builder')).toMatchObject({
    agentId: 'builder-primary',
    role: 'builder',
    entry: { provider: 'codex', model: 'gpt-5.6-luna' },
  })
  expect(resolveAgentForRole(registry, 'orchestrator').agentId).toBe('builder-primary')
})

it('fails closed on missing files, schema drift, and unknown roles', () => {
  const missing = (() => { try { loadAgentRegistry(join(tmpdir(), 'missing-agents.registry.yaml')); throw new Error('expected failure') } catch (error) { return error as HarnessError } })()
  expect(missing).toMatchObject({ code: 'INVALID_CONFIG' })
  expect(missing.message).toMatch(/not found/)

  expect(() => parseAgentRegistryText('schemaVersion: 2\nagents: {}')).toThrow(/schemaVersion/)
  expect(() => parseAgentRegistryText('schemaVersion: 1\nagents:\n  x:\n    model: only\n')).toThrow(/provider/)

  const registry = parseAgentRegistryText(sample)
  const unknown = (() => { try { resolveAgentForRole(registry, 'watcher'); throw new Error('expected failure') } catch (error) { return error as HarnessError } })()
  expect(unknown).toMatchObject({ code: 'INVALID_CONFIG' })
  expect(unknown.message).toMatch(/No agent registry entry for role: watcher/)

  const dangling = parseAgentRegistryText(`
schemaVersion: 1
agents:
  only:
    provider: codex
roles:
  builder: missing-agent
`)
  expect(() => resolveAgentForRole(dangling, 'builder')).toThrow(/unknown agent "missing-agent"/)
})

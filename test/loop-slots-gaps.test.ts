import { afterEach, describe, expect, it, vi } from 'vitest'
import { assessSlots, availableMemoryBytes, validateLoopConfig } from '../src/index.js'

const fsState = vi.hoisted(() => ({ existsSync: undefined as ((...args: unknown[]) => boolean) | undefined, readFileSync: undefined as ((...args: unknown[]) => string) | undefined }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  fsState.existsSync = actual.existsSync
  fsState.readFileSync = actual.readFileSync as (...args: unknown[]) => string
  return { ...actual, existsSync: (...args: unknown[]) => fsState.existsSync!(...(args as [string])), readFileSync: (...args: unknown[]) => fsState.readFileSync!(...(args as [string, string])) }
})
const defaultExistsSync = fsState.existsSync
const defaultReadFileSync = fsState.readFileSync
afterEach(() => { fsState.existsSync = defaultExistsSync; fsState.readFileSync = defaultReadFileSync })

describe('availableMemoryBytes', () => {
  it('reads real memory on darwin, and falls back to freemem elsewhere', () => {
    expect(availableMemoryBytes('darwin')).toBeGreaterThan(0)
    expect(availableMemoryBytes('win32')).toBeGreaterThan(0)
  })

  it('falls back to freemem on linux when /proc/meminfo is absent', () => {
    fsState.existsSync = () => false
    expect(availableMemoryBytes('linux')).toBeGreaterThan(0)
  })

  it('parses /proc/meminfo on linux when it is present', () => {
    fsState.existsSync = () => true
    fsState.readFileSync = () => 'MemTotal:       32000000 kB\nMemAvailable:    9000000 kB\n'
    expect(availableMemoryBytes('linux')).toBe(9000000 * 1024)
  })
})

describe('assessSlots defaults', () => {
  const machine = validateLoopConfig({
    project: { name: 'demo', repo: 'org/demo' },
    linear: { workspaceId: 'ws-1', teamKey: 'ENG', person: 'person' },
    models: {
      orchestrator: [['codex/gpt-5.6-sol']],
      reviewer: [['codex/gpt-5.6-sol']],
      builder: [['codex/gpt-5.6-sol']],
      watcher: [['codex/gpt-5.6-sol']],
      providers: { codex: { bin: 'codex', auth: 'subscription', tui: 'codex -m {model} --full-auto' } },
    },
    delivery: { verifyCommand: 'pnpm test' },
  }).machine

  it('falls back to a live sample and real available memory when neither is supplied', () => {
    const result = assessSlots({ machine, running: 0 })
    expect(result.sample.cpus).toBeGreaterThan(0)
    expect(result.freeRamGb).toBeGreaterThan(0)
  })

  it('adds a "total memory unknown" reason when totalBytes is falsy', () => {
    const result = assessSlots({ machine, running: 0, sample: { at: '2026-01-01T00:00:00.000Z', cpus: 4, load1: 1, load1PerCpuPercent: 10, memoryUsedPercent: 40, rssBytes: 1 }, freeBytes: 1024 ** 3, totalBytes: 0 })
    expect(result.reasons).toContain('total memory unknown')
  })
})

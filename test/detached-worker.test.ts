import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnDetachedWorker } from '../src/loop/detached-worker.js'

const calls = vi.hoisted(() => [] as { readonly command: string; readonly args: readonly string[]; readonly options: Record<string, unknown> }[])
const state = vi.hoisted(() => ({ unrefed: false, pid: 4242 as number | undefined }))
const fakeSpawn = vi.hoisted(() => vi.fn((command: string, args: readonly string[], options: Record<string, unknown>) => {
  calls.push({ command, args, options })
  return Object.assign(new EventEmitter(), { pid: state.pid, unref: () => { state.unrefed = true } })
}))
vi.mock('cross-spawn', () => ({ default: fakeSpawn }))

const cleanups: string[] = []
afterEach(() => { calls.length = 0; state.unrefed = false; state.pid = 4242; for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('spawnDetachedWorker', () => {
  it('spawns detached and unref\'d, with stdio redirected to the log file and shell disabled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentskit-detached-worker-')); cleanups.push(dir)
    const logPath = join(dir, 'nested', 'tick-worker.log')
    const result = spawnDetachedWorker({ command: 'ak-harness', args: ['loop', 'tick-worker', '-f', 'loop.config.yaml'], cwd: dir, logPath })
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.command).toBe('ak-harness')
    expect(call.args).toEqual(['loop', 'tick-worker', '-f', 'loop.config.yaml'])
    expect(call.options).toMatchObject({ cwd: dir, shell: false, detached: true, windowsHide: true })
    // stdio must not be 'ignore'/'pipe' for stdout/stderr — a real fd, so the child's own output survives this
    // process exiting instead of being silently dropped or filling an undrained pipe buffer.
    const stdio = call.options['stdio'] as readonly unknown[]
    expect(stdio[0]).toBe('ignore')
    expect(typeof stdio[1]).toBe('number')
    expect(stdio[1]).toBe(stdio[2])
    expect(state.unrefed).toBe(true)
    expect(result).toEqual({ pid: 4242, logPath })
  })

  it('creates the log file\'s parent directory when it does not exist yet', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentskit-detached-worker-')); cleanups.push(dir)
    const logPath = join(dir, 'does', 'not', 'exist', 'yet', 'tick-worker.log')
    spawnDetachedWorker({ command: 'ak-harness', args: [], cwd: dir, logPath })
    expect(() => readFileSync(logPath)).not.toThrow()
  })

  it('defaults the child env to this process\'s own when none is given, and honours an explicit override', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentskit-detached-worker-')); cleanups.push(dir)
    spawnDetachedWorker({ command: 'ak-harness', args: [], cwd: dir, logPath: join(dir, 'a.log') })
    expect(calls[0]!.options['env']).toBe(process.env)
    const customEnv = { CUSTOM: '1' }
    spawnDetachedWorker({ command: 'ak-harness', args: [], cwd: dir, logPath: join(dir, 'b.log'), env: customEnv })
    expect(calls[1]!.options['env']).toBe(customEnv)
  })

  it('returns pid: null when the child has no pid (never throws)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentskit-detached-worker-')); cleanups.push(dir)
    state.pid = undefined
    const result = spawnDetachedWorker({ command: 'ak-harness', args: [], cwd: dir, logPath: join(dir, 'a.log') })
    expect(result.pid).toBeNull()
  })
})

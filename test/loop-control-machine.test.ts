import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CommandRunner } from '../src/index.js'
import { controlMachineBusy, createControlMachineGate, parseSwapUsage, sampleControlMachine, userStateDir, type ControlPressure } from '../src/loop/control-machine.js'

const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const GiB = 1024 ** 3
const quiet: ControlPressure = { swapBytes: 0.5 * GiB, loadPerCore: 0.3 }
const noRunner: CommandRunner = { run: async () => { throw new Error('not called') } }
const lockDir = (): string => { const dir = mkdtempSync(join(tmpdir(), 'agentskit-control-')); cleanups.push(dir); return dir }

describe('control machine: local verifies are serialised and wait for a quiet machine', () => {
  it('is busy at 2 GiB of swap or a load of 1 per core; an unmeasured signal is not pressure', () => {
    expect(controlMachineBusy(quiet)).toBeNull()
    expect(controlMachineBusy({ swapBytes: 12 * GiB, loadPerCore: 0.2 })).toBe('swap 12.0 GiB ≥ 2 GiB')
    expect(controlMachineBusy({ swapBytes: 0, loadPerCore: 45 / 10 })).toBe('load 4.50/core ≥ 1')
    expect(controlMachineBusy({ swapBytes: 2 * GiB, loadPerCore: 1 })).toBe('swap 2.0 GiB ≥ 2 GiB, load 1.00/core ≥ 1')
    expect(controlMachineBusy({ swapBytes: null, loadPerCore: null })).toBeNull()
  })

  it('reads macOS swap from sysctl vm.swapusage', async () => {
    expect(parseSwapUsage('total = 13312.00M  used = 12288.50M  free = 1023.50M  (encrypted)')).toBe(Math.round(12288.5 * 1024 ** 2))
    expect(parseSwapUsage('total = 0.00M  used = 0.00M  free = 0.00M')).toBe(0)
    expect(parseSwapUsage('garbage')).toBeNull()
    const runner: CommandRunner = { run: async (argv) => ({ code: 0, stdout: argv.join(' ') === 'sysctl -n vm.swapusage' ? 'total = 4096.00M  used = 3072.00M  free = 1024.00M' : '', stderr: '', timedOut: false, durationMs: 1 }) }
    expect((await sampleControlMachine(runner, 'darwin')).swapBytes).toBe(3 * GiB)
  })

  it('a busy machine waits: the work does not run and nothing fails', async () => {
    let ran = false
    const gate = createControlMachineGate({ runner: noRunner, lockDir: lockDir(), sample: async () => ({ swapBytes: 12 * GiB, loadPerCore: 4.5 }) })
    const result = await gate(async () => { ran = true; return 0 })
    expect(result).toEqual({ ran: false, detail: 'waiting: control machine busy (swap 12.0 GiB ≥ 2 GiB, load 4.50/core ≥ 1)' })
    expect(ran).toBe(false)
  })

  it('two conveyors never verify locally at once: the second waits on the lock, and runs once it is released', async () => {
    const dir = lockDir()
    const first = createControlMachineGate({ runner: noRunner, lockDir: dir, sample: async () => quiet })
    const second = createControlMachineGate({ runner: noRunner, lockDir: dir, sample: async () => quiet })
    let release: () => void = () => undefined
    const holding = first(() => new Promise<string>((resolve) => { release = () => resolve('first done') }))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(await second(async () => 'second ran')).toEqual({ ran: false, detail: 'waiting: control machine busy (another loop is verifying on it)' })
    release()
    expect(await holding).toEqual({ ran: true, value: 'first done' })
    expect(await second(async () => 'second ran')).toEqual({ ran: true, value: 'second ran' })
  })

  it('releases the lock when the work throws', async () => {
    const dir = lockDir()
    const gate = createControlMachineGate({ runner: noRunner, lockDir: dir, sample: async () => quiet })
    await expect(gate(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(await gate(async () => 1)).toEqual({ ran: true, value: 1 })
  })

  it('locks under the user state dir, shared by every loop', () => {
    expect(userStateDir({ AK_HARNESS_HOME: '/srv/ak' })).toBe('/srv/ak')
    expect(userStateDir({ AK_HARNESS_HOME: '/srv/ak', AK_HARNESS_CONFIG: '/elsewhere/harness.yaml' })).toBe('/srv/ak')
    expect(userStateDir({ HOME: '/home/x' })).toMatch(/\.agentskit$/)
  })
})

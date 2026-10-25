import { existsSync, readFileSync } from 'node:fs'
import { cpus, loadavg } from 'node:os'
import { dirname } from 'node:path'
import type { CommandRunner } from '../adapters/command.js'
import { globalConfigPath } from './config.js'
import { acquireStageLock } from './stage-lock.js'

/**
 * Work the harness itself runs on the control machine (a verify the fleet cannot run: secrets, homolog, Docker on
 * the Mac). Every conveyor on the machine shares it, so a local verify runs one at a time across all of them (a lock
 * under the user state dir) and only while the machine is quiet — the fleet's own pressure gate: swap under 2 GiB
 * and load under 1 per core. Otherwise it waits; a busy machine is never a failed verify.
 */

export const CONTROL_SWAP_LIMIT_BYTES = 2 * 1024 ** 3
export const CONTROL_LOAD_PER_CORE_LIMIT = 1

export interface ControlPressure {
  /** Swap in use; null when the platform does not say. */
  readonly swapBytes: number | null
  /** 1-minute load average per core; null where there is none (Windows). */
  readonly loadPerCore: number | null
}

const UNIT: Readonly<Record<string, number>> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }

/** `used` out of `sysctl -n vm.swapusage` (`total = 4096.00M  used = 3164.25M  free = …`), in bytes. */
export const parseSwapUsage = (text: string): number | null => {
  const match = /used\s*=\s*([\d.]+)([KMGT])?/i.exec(text)
  return match ? Math.round(Number(match[1]) * (UNIT[(match[2] ?? 'M').toUpperCase()] ?? 1)) : null
}

const linuxSwapBytes = (): number | null => {
  if (!existsSync('/proc/meminfo')) return null
  const kb = (key: string): number | null => { const match = new RegExp(`^${key}:\\s+(\\d+)\\s+kB$`, 'm').exec(readFileSync('/proc/meminfo', 'utf8')); return match ? Number(match[1]) : null }
  const total = kb('SwapTotal'); const free = kb('SwapFree')
  return total === null || free === null ? null : (total - free) * 1024
}

export const sampleControlMachine = async (runner: CommandRunner, platform: NodeJS.Platform = process.platform): Promise<ControlPressure> => {
  let swapBytes: number | null = null
  if (platform === 'darwin') { const swap = await runner.run(['sysctl', '-n', 'vm.swapusage'], { timeoutMs: 10_000 }).catch(() => null); swapBytes = swap && swap.code === 0 ? parseSwapUsage(swap.stdout) : null }
  else if (platform === 'linux') { try { swapBytes = linuxSwapBytes() } catch { swapBytes = null } }
  return { swapBytes, loadPerCore: platform === 'win32' ? null : (loadavg()[0] ?? 0) / Math.max(1, cpus().length) }
}

/** Why the machine is too busy for a local verify, or null when it is quiet. An unmeasured signal is not pressure. */
export const controlMachineBusy = (pressure: ControlPressure): string | null => {
  const reasons: string[] = []
  if (pressure.swapBytes !== null && pressure.swapBytes >= CONTROL_SWAP_LIMIT_BYTES) reasons.push(`swap ${(pressure.swapBytes / 1024 ** 3).toFixed(1)} GiB ≥ 2 GiB`)
  if (pressure.loadPerCore !== null && pressure.loadPerCore >= CONTROL_LOAD_PER_CORE_LIMIT) reasons.push(`load ${pressure.loadPerCore.toFixed(2)}/core ≥ ${CONTROL_LOAD_PER_CORE_LIMIT}`)
  return reasons.length ? reasons.join(', ') : null
}

/** The user state dir (`$AK_HARNESS_HOME`, else `~/.agentskit`): one per person, shared by every loop on the machine. */
export const userStateDir = (env: NodeJS.ProcessEnv = process.env): string => dirname(globalConfigPath({ ...env, AK_HARNESS_CONFIG: '' }))

export type ControlRun<T> = { readonly ran: true; readonly value: T } | { readonly ran: false; readonly detail: string }

/** Runs `work` on the control machine when it may, else answers why it waits. */
export type ControlMachineGate = <T>(work: () => Promise<T>) => Promise<ControlRun<T>>

export const CONTROL_LOCK = 'control-verify'

export const createControlMachineGate = (input: { readonly runner: CommandRunner; readonly lockDir: string; readonly sample?: () => Promise<ControlPressure> }): ControlMachineGate => async (work) => {
  const busy = controlMachineBusy(await (input.sample ?? (() => sampleControlMachine(input.runner)))())
  if (busy) return { ran: false, detail: `waiting: control machine busy (${busy})` }
  // The stage lock's dead-owner recovery covers a deliver that was killed mid-verify.
  // ponytail: the stage lock also treats a 30-min-old lock as stale; a local-only run longer than that can be joined by a second one.
  const release = acquireStageLock(input.lockDir, CONTROL_LOCK)
  if (!release) return { ran: false, detail: 'waiting: control machine busy (another loop is verifying on it)' }
  try { return { ran: true, value: await work() } } finally { release() }
}

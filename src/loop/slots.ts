import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { freemem, release, totalmem } from 'node:os'
import { adaptiveConcurrency, sampleMachine } from '../execution/machine.js'
import type { MachineSample } from '../kernel/types.js'
import type { LoopConfig } from './config.js'

export interface SlotAssessment {
  readonly sample: MachineSample
  readonly platform: string
  readonly wsl: boolean
  readonly freeRamGb: number
  readonly ceiling: number
  readonly adaptive: number
  readonly ramBound: number
  readonly maxAgents: number
  readonly running: number
  readonly free: number
  readonly reasons: readonly string[]
}

export interface SlotInput {
  readonly machine: LoopConfig['machine']
  readonly running: number
  readonly sample?: MachineSample
  readonly platform?: NodeJS.Platform
  readonly osRelease?: string
  readonly freeBytes?: number
  readonly totalBytes?: number
}

/** Parse `vm_stat` (macOS): reclaimable = free + inactive + speculative + purgeable pages. */
export const parseVmStat = (output: string): number | null => {
  const pageSize = Number(output.match(/page size of (\d+) bytes/)?.[1] ?? 4096)
  const pages = (label: string): number => Number(output.match(new RegExp(`${label}:\\s+(\\d+)`))?.[1] ?? 0)
  const total = pages('Pages free') + pages('Pages inactive') + pages('Pages speculative') + pages('Pages purgeable')
  return total > 0 ? total * pageSize : null
}

/** Parse `/proc/meminfo` (Linux): MemAvailable already accounts for reclaimable cache. */
export const parseMemInfo = (text: string): number | null => {
  const match = text.match(/^MemAvailable:\s+(\d+)\s+kB$/m)
  return match ? Number(match[1]) * 1024 : null
}

/** Bytes the OS can hand to a new process now — not just "free" pages, which macOS keeps near zero on purpose. */
export const availableMemoryBytes = (platform: NodeJS.Platform = process.platform): number => {
  try {
    if (platform === 'darwin') return parseVmStat(execFileSync('vm_stat', [], { encoding: 'utf8', timeout: 2_000 })) ?? freemem()
    if (platform === 'linux' && existsSync('/proc/meminfo')) return parseMemInfo(readFileSync('/proc/meminfo', 'utf8')) ?? freemem()
  } catch { /* fall through to the conservative number */ }
  return freemem()
}

export const isWsl = (platform: NodeJS.Platform = process.platform, osRelease: string = release(), env: NodeJS.ProcessEnv = process.env): boolean => platform === 'linux' && (/microsoft|wsl/i.test(osRelease) || Boolean(env['WSL_DISTRO_NAME']) || Boolean(env['WSL_INTEROP']))

/** How many coding agents this machine can host right now: floor ≤ min(adaptive, RAM-bound, WSL cap) and never below the floor. */
export const assessSlots = (input: SlotInput): SlotAssessment => {
  const platform = input.platform ?? process.platform
  const wsl = isWsl(platform, input.osRelease)
  const freeBytes = input.freeBytes ?? availableMemoryBytes(platform)
  const totalBytes = input.totalBytes ?? totalmem()
  // The kernel sampler reports bare free pages; re-express memory pressure against reclaimable memory so macOS is not permanently "critical".
  const sample = input.sample ?? { ...sampleMachine(), memoryUsedPercent: Number(Math.max(0, Math.min(100, (1 - freeBytes / Math.max(1, totalBytes)) * 100)).toFixed(2)) }
  const freeRamGb = Number((freeBytes / 1024 ** 3).toFixed(2))
  const reasons: string[] = []
  const ceiling = input.machine.ceiling ?? Math.max(input.machine.floor, Math.floor(sample.cpus / 2))
  const adaptive = adaptiveConcurrency(ceiling, sample, { warningPercent: input.machine.warningPercent, criticalPercent: input.machine.criticalPercent })
  if (adaptive < ceiling) reasons.push(`machine pressure capped concurrency at ${adaptive} (load ${sample.load1PerCpuPercent}%, memory ${sample.memoryUsedPercent}%)`)
  const reservedBytes = input.machine.minFreeRamGb * 1024 ** 3
  const perAgentBytes = input.machine.agentRssMb * 1024 ** 2
  const ramBound = Math.max(0, Math.floor((freeBytes - reservedBytes) / perAgentBytes)) + input.running
  if (ramBound < adaptive) reasons.push(`free RAM ${freeRamGb} GB minus ${input.machine.minFreeRamGb} GB reserve fits ${Math.max(0, ramBound - input.running)} more agent(s) at ${input.machine.agentRssMb} MB each`)
  let maxAgents = Math.min(adaptive, ramBound)
  if (wsl && maxAgents > input.machine.wslCap) { maxAgents = input.machine.wslCap; reasons.push(`WSL cap ${input.machine.wslCap}: host Defender load is invisible from the distro`) }
  maxAgents = Math.max(input.machine.floor, maxAgents)
  const free = Math.max(0, maxAgents - input.running)
  return { sample, platform, wsl, freeRamGb, ceiling, adaptive, ramBound, maxAgents, running: input.running, free, reasons: [...reasons, ...(totalBytes ? [] : ['total memory unknown'])] }
}

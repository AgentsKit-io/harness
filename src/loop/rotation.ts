import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { z } from 'zod'
import { dirname, join } from 'node:path'
import type { LoadedLoopConfig } from './config.js'
import type { DispatchLease } from '../execution/coordination.js'
import { readJsonFile } from '../kernel/json-file.js'

interface RotationState { readonly owner: string; readonly advancedAt: string }

export const rotationStatePath = (stateDir: string): string => join(stateDir, 'queue-owner.json')

/**
 * A lease protects the issue identity, but delivery work must not stop the
 * queue from moving on to independent work. Only leases with no delivery
 * state yet represent an implementation worker that should hold rotation.
 * Missing or invalid state stays fail-closed and remains blocking.
 */
export const countRotationBlockingLeases = (loaded: LoadedLoopConfig, leases: readonly DispatchLease[]): number => leases.filter((lease) => {
  const path = join(loaded.stateDir, 'issues', lease.issue, 'delivery.json')
  if (!existsSync(path)) return true
  try {
    const delivery = JSON.parse(readFileSync(path, 'utf8')) as { readonly prNumber?: number | null; readonly heldFor?: string | null; readonly finalOutcome?: string | null }
    return delivery.prNumber == null && !delivery.heldFor && !delivery.finalOutcome
  } catch { return true }
}).length

/** Effective owner for this machine; without rotation the versioned config remains authoritative. */
export const queueOwner = (loaded: LoadedLoopConfig): string => {
  const { rotation } = loaded.config.linear
  if (!rotation.enabled || !rotation.owners.length) return loaded.config.linear.person
  const path = rotationStatePath(loaded.stateDir)
  if (!existsSync(path)) return loaded.config.linear.person
  const state = readJsonFile(path, z.object({ owner: z.string() }).loose())
  return state && rotation.owners.includes(state.owner) ? state.owner : loaded.config.linear.person
}

/** Advance once, only after the current owner has no dispatchable work and no active implementation lease. */
export const advanceQueueOwner = (loaded: LoadedLoopConfig, input: { readonly queueEmpty: boolean; readonly activeLeases: number; readonly now?: Date }): { readonly owner: string; readonly advanced: boolean } => {
  const { rotation } = loaded.config.linear
  const owner = queueOwner(loaded)
  if (!rotation.enabled || !rotation.advanceWhenEmpty || !rotation.owners.length || !input.queueEmpty || input.activeLeases > 0) return { owner, advanced: false }
  const index = rotation.owners.indexOf(owner)
  const next = index >= 0 ? rotation.owners[index + 1] : undefined
  if (!next) return { owner, advanced: false }
  const path = rotationStatePath(loaded.stateDir)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ owner: next, advancedAt: (input.now ?? new Date()).toISOString() }, null, 2)}\n`, 'utf8')
  return { owner: next, advanced: true }
}

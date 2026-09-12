import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { LoadedLoopConfig } from './config.js'

interface RotationState { readonly owner: string; readonly advancedAt: string }

export const rotationStatePath = (stateDir: string): string => join(stateDir, 'queue-owner.json')

/** Effective owner for this machine; without rotation the versioned config remains authoritative. */
export const queueOwner = (loaded: LoadedLoopConfig): string => {
  const { rotation } = loaded.config.linear
  if (!rotation.enabled || !rotation.owners.length) return loaded.config.linear.person
  const path = rotationStatePath(loaded.stateDir)
  if (!existsSync(path)) return loaded.config.linear.person
  try {
    const state = JSON.parse(readFileSync(path, 'utf8')) as Partial<RotationState>
    return typeof state.owner === 'string' && rotation.owners.includes(state.owner) ? state.owner : loaded.config.linear.person
  } catch { return loaded.config.linear.person }
}

/** Advance once, only after the current owner has no dispatchable work and no active lease. */
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

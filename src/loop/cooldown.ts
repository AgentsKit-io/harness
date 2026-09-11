import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { cooldownUntil } from '../adapters/providers.js'

export interface CooldownEntry { readonly attempts: number; readonly until: string; readonly reason: string; readonly markedAt: string }
export type CooldownState = Readonly<Record<string, CooldownEntry>>

export const cooldownPath = (stateDir: string): string => join(stateDir, 'provider-cooldowns.json')

export const readCooldowns = (stateDir: string): CooldownState => {
  const path = cooldownPath(stateDir)
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as CooldownState : {}
  } catch { return {} }
}

const writeCooldowns = (stateDir: string, state: CooldownState): void => {
  const path = cooldownPath(stateDir)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

/** Active cooldowns as provider → ISO until, dropping expired entries. */
export const activeCooldowns = (state: CooldownState, now: Date = new Date()): Readonly<Record<string, string>> => Object.fromEntries(Object.entries(state).filter(([, entry]) => Date.parse(entry.until) > now.getTime()).map(([id, entry]) => [id, entry.until]))

export const markProviderExhausted = (stateDir: string, provider: string, options: { readonly initialMin: number; readonly maxMin: number; readonly reason: string; readonly resetsAt?: string | null; readonly now?: Date }): CooldownEntry => {
  const now = options.now ?? new Date()
  const state = readCooldowns(stateDir)
  const previous = state[provider]
  const attempts = previous && Date.parse(previous.until) > now.getTime() - options.maxMin * 60_000 ? previous.attempts + 1 : 0
  const entry: CooldownEntry = { attempts, until: cooldownUntil(attempts, options.initialMin, options.maxMin, now, options.resetsAt ?? null), reason: options.reason, markedAt: now.toISOString() }
  writeCooldowns(stateDir, { ...state, [provider]: entry })
  return entry
}

export const clearProviderCooldown = (stateDir: string, provider: string): void => {
  const state = readCooldowns(stateDir)
  if (!(provider in state)) return
  const { [provider]: _removed, ...rest } = state
  writeCooldowns(stateDir, rest)
}

import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { stringify as toYaml } from 'yaml'
import type { CommandRunner } from '../adapters/command.js'
import { orcaJson } from '../adapters/orca-cli.js'
import { LOOP_LOCAL_CONFIG_FILE, loadLoopConfig, type LoadedLoopConfig } from './config.js'

export interface TeamMember { readonly id: string; readonly displayName: string }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

export const parseTeamMembers = (result: unknown): readonly TeamMember[] => {
  const list = isRecord(result) ? (Array.isArray(result['members']) ? result['members'] : Array.isArray(result['users']) ? result['users'] : []) : Array.isArray(result) ? result : []
  return list.filter(isRecord).map((item) => ({ id: typeof item['id'] === 'string' ? item['id'] : '', displayName: typeof item['displayName'] === 'string' ? item['displayName'] : typeof item['name'] === 'string' ? item['name'] : '' })).filter((member) => member.displayName)
}

export const fetchTeamMembers = async (runner: CommandRunner, loaded: LoadedLoopConfig): Promise<readonly TeamMember[]> => parseTeamMembers(await orcaJson(runner, ['linear', 'team', 'members', '--team', loaded.config.linear.teamKey, '--workspace', loaded.config.linear.workspaceId], { bin: loaded.config.orca.bin, timeoutMs: loaded.config.orca.timeoutMs }))

export interface LocalConfigAnswers {
  readonly person: string
  readonly minFreeRamGb?: number
  readonly ceiling?: number
}

/** Serialise the per-machine overlay: only the keys the person answered, with a header explaining what it is. */
export const renderLocalConfig = (answers: LocalConfigAnswers, versionedPath: string): string => {
  const body: Record<string, unknown> = { linear: { person: answers.person } }
  const machine: Record<string, number> = {}
  if (answers.minFreeRamGb !== undefined) machine['minFreeRamGb'] = answers.minFreeRamGb
  if (answers.ceiling !== undefined) machine['ceiling'] = answers.ceiling
  if (Object.keys(machine).length) body['machine'] = machine
  return `# Per-machine overlay for the keep-pushing loop (gitignored). Merged over ${versionedPath.split(/[\\/]/).pop() ?? 'loop.config.yaml'}.\n# Everything not set here comes from the versioned config shared by the team.\n${toYaml(body)}`
}

export const localConfigPath = (loaded: LoadedLoopConfig): string => join(dirname(loaded.path), LOOP_LOCAL_CONFIG_FILE)

export const writeLocalConfig = (loaded: LoadedLoopConfig, answers: LocalConfigAnswers): { readonly path: string; readonly loaded: LoadedLoopConfig } => {
  const path = localConfigPath(loaded)
  writeFileSync(path, renderLocalConfig(answers, loaded.path), 'utf8')
  return { path, loaded: loadLoopConfig(loaded.path) }
}

export const hasLocalConfig = (loaded: LoadedLoopConfig): boolean => existsSync(localConfigPath(loaded))

export interface LocalConfigPrompter {
  readonly select: (question: string, options: readonly { readonly value: string; readonly label: string; readonly hint?: string }[], initial?: number) => Promise<string | null>
  readonly text: (question: string, fallback: string, validate?: (value: string) => string | null) => Promise<string | null>
  readonly confirm: (question: string, fallback: boolean) => Promise<boolean>
  readonly write: (line: string) => void
}

const positiveNumber = (label: string) => (value: string): string | null => Number.isFinite(Number(value)) && Number(value) > 0 ? null : `${label} must be a positive number`

/** Ask who this machine works for (from the Linear team) and how much of the machine the loop may take; returns null when cancelled. */
export const promptLocalConfig = async (runner: CommandRunner, loaded: LoadedLoopConfig, io: LocalConfigPrompter, options: { readonly currentUserHint?: string } = {}): Promise<LocalConfigAnswers | null> => {
  const { config } = loaded
  let members: readonly TeamMember[] = []
  try { members = await fetchTeamMembers(runner, loaded) } catch (error) { io.write(`  △ could not list team members from Orca (${error instanceof Error ? error.message.split('\n')[0] : String(error)}); type the Linear display name instead`) }
  const known = Object.keys(config.linear.people)
  const names = [...new Set([...members.map((member) => member.displayName), ...known])].sort()
  let person: string | null
  if (names.length) {
    const initial = Math.max(0, names.indexOf(options.currentUserHint ?? config.linear.person))
    person = await io.select(`Whose Linear queue does this machine drain? (team ${config.linear.teamKey})`, [...names.map((name) => ({ value: name, label: name, hint: name === config.linear.person ? 'default in loop.config.yaml' : known.includes(name) ? 'listed in loop.config.yaml' : undefined })), { value: '__other__', label: 'someone else…' }], initial)
    if (person === '__other__') person = await io.text('Linear display name', config.linear.person, (value) => value.trim() ? null : 'a display name is required')
  } else person = await io.text('Linear display name of the queue owner', config.linear.person, (value) => value.trim() ? null : 'a display name is required')
  if (!person) return null
  const tune = await io.confirm(`Tune how much of this machine the loop may use? (defaults: keep ${config.machine.minFreeRamGb} GB free, ceiling ${config.machine.ceiling ?? 'cpus/2'})`, false)
  if (!tune) return { person }
  const ram = await io.text('GB of RAM to always keep free', String(config.machine.minFreeRamGb), positiveNumber('RAM reserve'))
  if (ram === null) return null
  const ceiling = await io.text('Maximum concurrent workers (blank = cpus/2)', config.machine.ceiling ? String(config.machine.ceiling) : '', (value) => value === '' ? null : positiveNumber('ceiling')(value))
  if (ceiling === null) return null
  return { person, minFreeRamGb: Number(ram), ...(ceiling === '' ? {} : { ceiling: Math.floor(Number(ceiling)) }) }
}

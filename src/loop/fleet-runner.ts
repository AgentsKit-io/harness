import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { fail } from '../kernel/errors.js'
import { readJsonFile } from '../kernel/json-file.js'
import { writeJsonAtomic } from './fs-atomic.js'
import type { RunnerConnector, RunnerInput, WorkspaceObservation } from './runner-connector.js'

/** A workspace the harness opened but the fleet may not know yet: `queueId` is null until the first `send` submits. */
const FleetRecordSchema = z.object({ id: z.string(), branch: z.string(), base: z.string(), queueId: z.string().nullable() })
type FleetRecord = Readonly<z.infer<typeof FleetRecordSchema>>

type FleetState = NonNullable<WorkspaceObservation['state']>

const TERMINAL: readonly FleetState[] = ['done', 'failed', 'cancelled']

/** `fleet queue --json` states, folded to the few the harness reasons about. Unknown words stay `unknown` — never `done`. */
const foldState = (raw: unknown): FleetState => {
  switch (typeof raw === 'string' ? raw.toLowerCase() : '') {
    case 'queued': case 'pending': case 'waiting': return 'queued'
    case 'running': case 'dispatched': case 'started': case 'in_progress': return 'running'
    case 'done': case 'succeeded': case 'success': case 'completed': return 'done'
    case 'failed': case 'error': case 'timed_out': return 'failed'
    case 'cancelled': case 'canceled': return 'cancelled'
    default: return 'unknown'
  }
}

const text = (value: unknown): string | null => typeof value === 'string' && value.length > 0 ? value : null

/** Accepts a bare array or `{ tasks: [...] }`; rows without an id are dropped. */
const parseQueue = (stdout: string): readonly { readonly id: string; readonly state: FleetState }[] => {
  let parsed: unknown
  try { parsed = JSON.parse(stdout) } catch { fail('fleet queue --json did not print JSON.', 'HARNESS_ERROR') }
  const rows = Array.isArray(parsed) ? parsed : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { tasks?: unknown }).tasks) ? (parsed as { tasks: unknown[] }).tasks : fail('fleet queue --json: expected an array of tasks.', 'HARNESS_ERROR')
  return rows.flatMap((row): { id: string; state: FleetState }[] => {
    const record = typeof row === 'object' && row !== null ? row as Record<string, unknown> : {}
    const id = text(record['id']) ?? text(record['queueId'])
    return id ? [{ id, state: foldState(record['state']) }] : []
  })
}

/** `github:owner/repo` from an `origin` URL (https or ssh); null when it is not a GitHub remote. */
const projectFromRemote = (url: string): string | null => {
  const match = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim())
  return match ? `github:${match[1]}/${match[2]}` : null
}

/**
 * Dispatch through the fleet coordinator's queue (docs/ADR-0045). Fleet tasks are not interactive and have no local
 * worktree: the harness keeps one small record per workspace (`fleet-workspaces.json` in the state dir) so a later
 * process can still observe, tail and cancel what an earlier one submitted. The prompt text only ever travels
 * through a temp file; it is never put in argv or in an error message.
 */
export const createFleetRunner = ({ loaded, runner }: RunnerInput): RunnerConnector => {
  const { config } = loaded
  const fleet = config.connectors.fleet
  const store = join(loaded.stateDir, 'fleet-workspaces.json')
  // A missing or unreadable store reads as empty: the queue itself is the source of truth for what was submitted.
  const read = (): FleetRecord[] => readJsonFile(store, z.array(FleetRecordSchema)) ?? []
  const write = (records: readonly FleetRecord[]): void => { mkdirSync(loaded.stateDir, { recursive: true }); writeJsonAtomic(store, records) }
  const update = (id: string, patch: Partial<FleetRecord>): void => write(read().map((record) => record.id === id ? { ...record, ...patch } : record))
  const run = (args: readonly string[]) => runner.run([fleet.bin, ...args], { timeoutMs: fleet.timeoutMs, cwd: loaded.root })
  const queue = async () => {
    const result = await run(['queue', '--json'])
    if (result.code !== 0) fail(`fleet queue failed: ${result.stderr.trim() || `exit ${result.code ?? 'null'}`}`, 'HARNESS_ERROR')
    return parseQueue(result.stdout)
  }
  const project = async (): Promise<string> => {
    if (fleet.project) return fleet.project.startsWith('github:') ? fleet.project : `github:${fleet.project}`
    const remote = await runner.run(['git', '-C', loaded.root, 'remote', 'get-url', 'origin'], { timeoutMs: 15_000 })
    return (remote.code === 0 ? projectFromRemote(remote.stdout) : null) ?? fail('connectors.fleet.project is unset and the origin remote is not a GitHub repository.', 'INVALID_CONFIG')
  }
  const record = (id: string): FleetRecord => read().find((entry) => entry.id === id) ?? fail(`Unknown fleet workspace "${id}".`, 'HARNESS_ERROR')

  return {
    id: 'fleet',
    // Nothing to contact yet: the fleet learns about the work at the first `send`.
    createWorkspace: async ({ name, branch, baseBranch }) => {
      const id = `fleet-${name.replaceAll(/[^A-Za-z0-9_-]/g, '-')}-${randomUUID().slice(0, 8)}`
      write([...read(), { id, branch, base: baseBranch, queueId: null }])
      return { id, path: '', branch, terminal: null }
    },
    removeWorkspace: async ({ id }) => {
      const { queueId } = record(id)
      if (queueId) {
        const task = (await queue()).find((row) => row.id === queueId)
        if (task && !TERMINAL.includes(task.state)) {
          const cancelled = await run(['cancel', queueId])
          if (cancelled.code !== 0) fail(`fleet cancel ${queueId} failed: ${cancelled.stderr.trim() || `exit ${cancelled.code ?? 'null'}`}`, 'HARNESS_ERROR')
        }
      }
      write(read().filter((entry) => entry.id !== id))
    },
    // The handle is the workspace id; `command` (an interactive agent CLI line) means nothing to a queue.
    launchAgent: async ({ workspace }) => { record(workspace.id); return workspace.id },
    send: async ({ terminal, text: prompt }) => {
      const entry = record(terminal)
      if (entry.queueId) return { delivered: false, detail: `fleet task ${entry.queueId} is already submitted; fleet tasks are not interactive, so a later message cannot reach it.` }
      const dir = mkdtempSync(join(loaded.stateDir, 'fleet-prompt-'))
      try {
        const file = join(dir, 'prompt.md')
        writeFileSync(file, prompt, { encoding: 'utf8', mode: 0o600 })
        const result = await run(['submit', '--project', await project(), '--base', entry.base, '--model', fleet.model, ...(fleet.fallbackModels.length > 0 ? ['--fallback-models', fleet.fallbackModels.join(',')] : []), '--priority', String(fleet.priority), '--prompt-file', file])
        const queueId = /\bsubmitted\s+(q-[\w-]+)/.exec(result.stdout)?.[1]
        if (result.code !== 0 || !queueId) return { delivered: false, detail: result.stderr.trim() || (result.code === 0 ? 'fleet submit printed no queue id' : `fleet submit exited ${result.code ?? 'null'}`) }
        update(entry.id, { queueId })
        return { delivered: true, detail: `submitted ${queueId}` }
      } finally { rmSync(dir, { recursive: true, force: true }) }
    },
    readScreen: async ({ terminal, lines }) => {
      const { queueId } = record(terminal)
      if (!queueId) return ''
      const result = await run(['tail', queueId])
      if (result.code !== 0) return ''
      return lines ? result.stdout.split(/\r?\n/).slice(-lines).join('\n') : result.stdout
    },
    schedule: async () => ['the fleet coordinator owns scheduling'],
    // ponytail: a pull request is the SCM's to report, so `pullRequest` is always null; only the task state is the fleet's.
    observeWorkspaces: async () => {
      const records = read().filter((entry) => entry.queueId)
      if (records.length === 0) return []
      const rows = new Map((await queue()).map((row) => [row.id, row.state]))
      return records.map((entry) => ({ id: entry.id, pullRequest: null, state: rows.get(entry.queueId ?? '') ?? 'unknown' }))
    },
  }
}

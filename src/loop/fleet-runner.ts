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

interface QueueRow { readonly id: string; readonly state: FleetState; /** The id `fleet collect` takes, when the row carries one distinct from the queue id. */ readonly hostTaskId: string | null }

/** Accepts a bare array or `{ tasks: [...] }`; rows without an id are dropped. */
const parseQueue = (stdout: string): readonly QueueRow[] => {
  let parsed: unknown
  try { parsed = JSON.parse(stdout) } catch { fail('fleet queue --json did not print JSON.', 'HARNESS_ERROR') }
  const rows = Array.isArray(parsed) ? parsed : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { tasks?: unknown }).tasks) ? (parsed as { tasks: unknown[] }).tasks : fail('fleet queue --json: expected an array of tasks.', 'HARNESS_ERROR')
  return rows.flatMap((row): QueueRow[] => {
    const record = typeof row === 'object' && row !== null ? row as Record<string, unknown> : {}
    const id = text(record['id']) ?? text(record['queueId'])
    const hostTaskId = text(record['hostTaskId']) ?? text(record['host_task_id']) ?? text(record['taskId']) ?? text(record['task_id'])
    return id ? [{ id, state: foldState(record['state']), hostTaskId }] : []
  })
}

/** `fleet submit` argv as a dry run reports it: the same shape the real submit uses, with the prompt file named by a placeholder. */
export const fleetSubmitPreview = (config: RunnerInput['loaded']['config'], base: string): readonly string[] => {
  const fleet = config.connectors.fleet
  const project = fleet.project ? fleet.project.startsWith('github:') ? fleet.project : `github:${fleet.project}` : 'github:<origin remote>'
  return [fleet.bin, 'submit', '--project', project, '--base', base, '--model', fleet.model, ...(fleet.fallbackModels.length > 0 ? ['--fallback-models', fleet.fallbackModels.join(',')] : []), '--priority', String(fleet.priority), '--prompt-file', '<prompt file>']
}

export interface FleetProbe { readonly id: string; readonly status: 'passed' | 'warning' | 'failed'; readonly detail: string }

/** What `loop doctor` asks of the fleet: `fleet doctor --json` summarised, and `fleet queue --json` reachable. Never throws. */
export const probeFleet = async (input: RunnerInput): Promise<readonly FleetProbe[]> => {
  const { bin, timeoutMs } = input.loaded.config.connectors.fleet
  const call = async (args: readonly string[]) => {
    try { return await input.runner.run([bin, ...args], { timeoutMs, cwd: input.loaded.root }) } catch (error) { return { code: null, stdout: '', stderr: error instanceof Error ? error.message : String(error), timedOut: false, durationMs: 0 } }
  }
  const probes: FleetProbe[] = []
  const doctor = await call(['doctor', '--json'])
  if (doctor.timedOut || doctor.code !== 0) probes.push({ id: 'fleet.doctor', status: 'failed', detail: `"${bin} doctor --json" ${doctor.timedOut ? 'timed out' : `exited ${doctor.code ?? 'null'}`}${doctor.stderr.trim() ? `: ${doctor.stderr.trim().slice(0, 200)}` : ''}` })
  else {
    let parsed: unknown = null
    try { parsed = JSON.parse(doctor.stdout) } catch { /* reported below */ }
    const record = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
    if (!record) probes.push({ id: 'fleet.doctor', status: 'warning', detail: `"${bin} doctor --json" exited 0 but printed no JSON summary` })
    else {
      const checks = Array.isArray(record['checks']) ? record['checks'].filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null) : []
      const failing = checks.filter((item) => ['failed', 'fail', 'error'].includes(String(item['status']).toLowerCase()) || item['ok'] === false)
      const overall = typeof record['status'] === 'string' ? record['status'].toLowerCase() : null
      const bad = record['ok'] === false || (overall !== null && ['failed', 'fail', 'error'].includes(overall)) || failing.length > 0
      const names = failing.map((item) => text(item['id']) ?? text(item['name']) ?? 'check').slice(0, 5).join(', ')
      probes.push({ id: 'fleet.doctor', status: bad ? 'failed' : 'passed', detail: `${checks.length ? `${checks.length - failing.length}/${checks.length} checks ok` : (overall ?? 'ok')}${failing.length ? `; failing: ${names}` : ''}` })
    }
  }
  const queue = await call(['queue', '--json'])
  if (queue.timedOut || queue.code !== 0) probes.push({ id: 'fleet.queue', status: 'failed', detail: `"${bin} queue --json" ${queue.timedOut ? 'timed out' : `exited ${queue.code ?? 'null'}`}${queue.stderr.trim() ? `: ${queue.stderr.trim().slice(0, 200)}` : ''}` })
  else {
    try { probes.push({ id: 'fleet.queue', status: 'passed', detail: `reachable · ${parseQueue(queue.stdout).length} task(s)` }) } catch (error) { probes.push({ id: 'fleet.queue', status: 'failed', detail: error instanceof Error ? error.message : String(error) }) }
  }
  return probes
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
    // `fleet collect` brings the task's branch into the local clone and never pushes; pushing and opening the PR stay
    // the harness's job. The branch is the one the output names, else the one the workspace was created with — and it
    // must exist locally afterwards, or the collect did not deliver what deliver is about to push.
    collect: async ({ id }) => {
      const entry = record(id)
      const queueId = entry.queueId ?? fail(`Fleet workspace "${id}" was never submitted; there is nothing to collect.`, 'HARNESS_ERROR')
      const row = (await queue()).find((item) => item.id === queueId)
      const taskId = row?.hostTaskId ?? queueId
      const result = await run(['collect', taskId])
      if (result.code !== 0) fail(`fleet collect ${taskId} failed: ${result.stderr.trim() || `exit ${result.code ?? 'null'}`}`, 'HARNESS_ERROR')
      const branch = /\bbranch[:=\s]+'?([\w./-]+)'?/i.exec(result.stdout)?.[1] ?? entry.branch
      const present = await runner.run(['git', '-C', loaded.root, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { timeoutMs: 15_000 })
      if (present.code !== 0) fail(`fleet collect ${taskId} succeeded but branch "${branch}" is not in the local clone.`, 'HARNESS_ERROR')
      return { branch, detail: `collected ${taskId} → ${branch}` }
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

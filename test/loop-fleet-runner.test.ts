import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRunnerConnector, loadLoopConfig } from '../src/index.js'
import type { CommandResult, CommandRunner, LoadedLoopConfig } from '../src/index.js'

const exampleYaml = readFileSync(join(process.cwd(), 'loop.config.example.yaml'), 'utf8').replace('person: my-linear-display-name', 'person: person').replace('my-linear-display-name: <linear-user-id>', 'person: user-id-1')
const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '', timedOut: false, durationMs: 1 })
const setup = (overlay = 'connectors:\n  runner: fleet\n'): LoadedLoopConfig => {
  const dir = mkdtempSync(join(tmpdir(), 'agentskit-fleet-')); cleanups.push(dir)
  writeFileSync(join(dir, 'loop.config.yaml'), exampleYaml)
  writeFileSync(join(dir, 'loop.config.local.yaml'), overlay)
  const loaded = loadLoopConfig(join(dir, 'loop.config.yaml'), { AK_HARNESS_NO_GLOBAL: '1' })
  mkdirSync(loaded.stateDir, { recursive: true })
  return loaded
}

/** Answers like the fleet CLI: `submitted q-…`, queue JSON, tail text. Records the prompt file's content at submit time. */
const fakeFleet = (state = 'running') => {
  const calls: string[][] = []
  const prompts: string[] = []
  const files: string[] = []
  const runner: CommandRunner = {
    run: async (argv) => {
      calls.push([...argv])
      const [bin, verb] = argv
      if (bin === 'git') return ok('git@github.com:acme/widgets.git\n')
      if (verb === 'submit') { const file = argv[argv.indexOf('--prompt-file') + 1] ?? ''; files.push(file); prompts.push(readFileSync(file, 'utf8')); return ok('submitted q-0001\n') }
      if (verb === 'queue') return ok(JSON.stringify([{ id: 'q-0001', state, host: 'h1' }, { id: 'q-9', state: 'done' }]))
      if (verb === 'tail') return ok('line1\nline2\nline3\n')
      return ok()
    },
  }
  return { runner, calls, prompts, files }
}

describe('the fleet runner', () => {
  it('is selected by connectors.runner: fleet, with defaults', () => {
    const loaded = setup()
    expect(loaded.config.connectors.fleet).toMatchObject({ bin: 'fleet', model: 'sonnet', fallbackModels: [], priority: 0 })
    expect(createRunnerConnector({ loaded, runner: fakeFleet().runner }).id).toBe('fleet')
  })

  it('rejects an unknown model, a bad project and a negative priority', () => {
    expect(() => setup('connectors:\n  runner: fleet\n  fleet:\n    model: gpt\n')).toThrow()
    expect(() => setup('connectors:\n  runner: fleet\n  fleet:\n    fallbackModels: [nope]\n')).toThrow()
    expect(() => setup('connectors:\n  runner: fleet\n  fleet:\n    project: not-a-repo\n')).toThrow()
    expect(() => setup('connectors:\n  runner: fleet\n  fleet:\n    priority: -1\n')).toThrow()
  })

  it('creates and launches without contacting the fleet, then submits once on the first send', async () => {
    const loaded = setup('connectors:\n  runner: fleet\n  fleet:\n    model: opus\n    fallbackModels: [sonnet, haiku]\n    priority: 3\n')
    const { runner, calls, prompts, files } = fakeFleet()
    const fleet = createRunnerConnector({ loaded, runner })
    const workspace = await fleet.createWorkspace({ name: 'eng-1', branch: 'person/eng-1', baseBranch: 'develop' })
    const handle = await fleet.launchAgent({ workspace, command: 'claude' })
    expect(calls).toEqual([])

    const first = await fleet.send({ terminal: handle, text: 'secret prompt text' })
    expect(first).toEqual({ delivered: true, detail: 'submitted q-0001' })
    const submit = calls.find((argv) => argv[1] === 'submit') ?? []
    expect(submit.slice(0, 11)).toEqual(['fleet', 'submit', '--project', 'github:acme/widgets', '--base', 'develop', '--model', 'opus', '--fallback-models', 'sonnet,haiku', '--priority'])
    expect(submit.slice(11, 13)).toEqual(['3', '--prompt-file'])
    expect(submit.join(' ')).not.toContain('secret prompt text')
    expect(prompts).toEqual(['secret prompt text'])
    expect(existsSync(files[0] ?? '')).toBe(false)

    const second = await fleet.send({ terminal: handle, text: 'more' })
    expect(second.delivered).toBe(false)
    expect(second.detail).toMatch(/not interactive/)
    expect(calls.filter((argv) => argv[1] === 'submit')).toHaveLength(1)
    expect(readdirSync(loaded.stateDir).filter((name) => name.startsWith('fleet-prompt-'))).toEqual([])
  })

  it('uses the configured project instead of the remote', async () => {
    const loaded = setup('connectors:\n  runner: fleet\n  fleet:\n    project: org/repo\n')
    const { runner, calls } = fakeFleet()
    const fleet = createRunnerConnector({ loaded, runner })
    const workspace = await fleet.createWorkspace({ name: 'a', branch: 'b', baseBranch: 'main' })
    await fleet.send({ terminal: await fleet.launchAgent({ workspace, command: '' }), text: 'x' })
    expect(calls.some((argv) => argv[0] === 'git')).toBe(false)
    expect(calls.find((argv) => argv[1] === 'submit')).toContain('github:org/repo')
  })

  it('reports a failed submit as not delivered and allows a retry', async () => {
    const loaded = setup()
    const runner: CommandRunner = { run: async (argv) => argv[0] === 'git' ? ok('https://github.com/acme/widgets\n') : { code: 1, stdout: '', stderr: 'coordinator down', timedOut: false, durationMs: 1 } }
    const fleet = createRunnerConnector({ loaded, runner })
    const workspace = await fleet.createWorkspace({ name: 'a', branch: 'b', baseBranch: 'main' })
    expect(await fleet.send({ terminal: workspace.id, text: 'x' })).toEqual({ delivered: false, detail: 'coordinator down' })
  })

  it('reads the tail, keeping the last N lines', async () => {
    const loaded = setup()
    const { runner } = fakeFleet()
    const fleet = createRunnerConnector({ loaded, runner })
    const workspace = await fleet.createWorkspace({ name: 'a', branch: 'b', baseBranch: 'main' })
    expect(await fleet.readScreen({ terminal: workspace.id })).toBe('')
    await fleet.send({ terminal: workspace.id, text: 'x' })
    expect(await fleet.readScreen({ terminal: workspace.id, lines: 2 })).toBe('line3\n')
    expect(await fleet.readScreen({ terminal: workspace.id })).toBe('line1\nline2\nline3\n')
  })

  it('maps queue states to observations, never to a pull request', async () => {
    const loaded = setup()
    for (const [raw, folded] of [['queued', 'queued'], ['running', 'running'], ['done', 'done'], ['failed', 'failed'], ['cancelled', 'cancelled'], ['weird', 'unknown']] as const) {
      const fleet = createRunnerConnector({ loaded, runner: fakeFleet(raw).runner })
      const workspace = await fleet.createWorkspace({ name: 'a', branch: 'b', baseBranch: 'main' })
      expect(await fleet.observeWorkspaces()).toEqual([])
      await fleet.send({ terminal: workspace.id, text: 'x' })
      expect(await fleet.observeWorkspaces()).toEqual([{ id: workspace.id, pullRequest: null, state: folded }])
      await fleet.removeWorkspace({ id: workspace.id })
    }
  })

  it('cancels a running task on remove, skips a finished one, and forgets the record', async () => {
    const loaded = setup()
    const live = fakeFleet('running')
    const fleet = createRunnerConnector({ loaded, runner: live.runner })
    const workspace = await fleet.createWorkspace({ name: 'a', branch: 'b', baseBranch: 'main' })
    await fleet.send({ terminal: workspace.id, text: 'x' })
    await fleet.removeWorkspace({ id: workspace.id })
    expect(live.calls.at(-1)).toEqual(['fleet', 'cancel', 'q-0001'])
    expect(await fleet.observeWorkspaces()).toEqual([])
    await expect(fleet.readScreen({ terminal: workspace.id })).rejects.toThrow(/Unknown fleet workspace/)

    const finished = fakeFleet('done')
    const other = createRunnerConnector({ loaded, runner: finished.runner })
    const second = await other.createWorkspace({ name: 'b', branch: 'b', baseBranch: 'main' })
    await other.send({ terminal: second.id, text: 'x' })
    await other.removeWorkspace({ id: second.id })
    expect(finished.calls.some((argv) => argv[1] === 'cancel')).toBe(false)
  })

  it('collects a submitted task by its host task id and refuses a branch that did not arrive', async () => {
    const loaded = setup()
    const calls: string[][] = []
    let branchPresent = true
    const runner: CommandRunner = { run: async (argv) => {
      calls.push([...argv])
      if (argv[0] === 'git' && argv[3] === 'rev-parse') return { ...ok(), code: branchPresent ? 0 : 1 }
      if (argv[0] === 'git') return ok('git@github.com:acme/widgets.git\n')
      if (argv[1] === 'submit') return ok('submitted q-0001\n')
      if (argv[1] === 'queue') return ok(JSON.stringify([{ id: 'q-0001', state: 'done', hostTaskId: 'ht-9' }]))
      return ok('collected\n')
    } }
    const fleet = createRunnerConnector({ loaded, runner })
    const workspace = await fleet.createWorkspace({ name: 'a', branch: 'person/a', baseBranch: 'main' })
    await expect(fleet.collect?.({ id: workspace.id })).rejects.toThrow(/never submitted/)
    await fleet.send({ terminal: workspace.id, text: 'x' })
    expect(await fleet.collect?.({ id: workspace.id })).toEqual({ branch: 'person/a', detail: 'collected ht-9 → person/a' })
    expect(calls).toContainEqual(['fleet', 'collect', 'ht-9'])
    branchPresent = false
    await expect(fleet.collect?.({ id: workspace.id })).rejects.toThrow(/not in the local clone/)
  })

  it('says the coordinator owns scheduling', async () => {
    const fleet = createRunnerConnector({ loaded: setup(), runner: fakeFleet().runner })
    expect(await fleet.schedule([])).toEqual(['the fleet coordinator owns scheduling'])
  })
})

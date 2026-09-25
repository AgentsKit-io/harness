import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BRIEF_POINTER_PROMPT, launchWorkerTerminal, loadLoopConfig } from '../src/index.js'
import type { CommandResult, CommandRunner } from '../src/index.js'

const ok = (result: unknown): CommandResult => ({ code: 0, stdout: JSON.stringify({ ok: true, result }), stderr: '', timedOut: false, durationMs: 1 })
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const config = () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentskit-launch-worker-')); dirs.push(dir)
  const yaml = readFileSync(join(process.cwd(), 'loop.config.example.yaml'), 'utf8').replace('person: my-linear-display-name', 'person: person')
  writeFileSync(join(dir, 'loop.config.yaml'), yaml)
  return loadLoopConfig(join(dir, 'loop.config.yaml')).config
}

/** An Orca that answers `tui-idle` with the given sequence, one entry per wait. */
const orca = (idle: readonly boolean[]): CommandRunner & { readonly calls: string[][] } => {
  const calls: string[][] = []
  let waits = 0
  return {
    calls,
    run: async (argv) => {
      calls.push([...argv])
      if (argv.includes('create')) return ok({ terminal: { handle: 'term-1' } })
      if (argv.includes('wait')) return ok({ wait: { satisfied: idle[waits++] ?? false } })
      if (argv.includes('send')) return ok({ accepted: true })
      return ok({})
    },
  }
}
const sends = (runner: { readonly calls: string[][] }) => runner.calls.filter((argv) => argv.includes('send')).length

describe('launchWorkerTerminal', () => {
  it('waits a second window when the TUI was not idle yet, then sends the brief', async () => {
    const runner = orca([false, true])
    const launched = await launchWorkerTerminal({ runner, config: config(), worktreeId: 'repo::/wt', command: 'opencode', title: 't', brief: 'do it' })
    expect(launched).toMatchObject({ terminal: 'term-1', accepted: true, idle: true })
    expect(sends(runner)).toBe(1)
  })

  it('never types into a pane that did not become idle — the prompt would be lost', async () => {
    const runner = orca([false, false])
    await expect(launchWorkerTerminal({ runner, config: config(), worktreeId: 'repo::/wt', command: 'opencode', title: 't', brief: 'do it', idleTimeoutMs: 1000 })).rejects.toThrow(/did not become tui-idle/)
    expect(sends(runner)).toBe(0)
  })

  it('hands a long brief over as a file in the worktree and types only a short pointer', async () => {
    const runner = orca([true])
    const worktree = mkdtempSync(join(tmpdir(), 'agentskit-launch-wt-')); dirs.push(worktree)
    const brief = '# Loop worker\n' + 'check: command → `pnpm -r --filter \'./packages/*\' build`\n'.repeat(500)
    await launchWorkerTerminal({ runner, config: config(), worktreeId: 'repo::/wt', worktreePath: worktree, command: 'claude', title: 't', brief })
    expect(readFileSync(join(worktree, '.ak-loop', 'brief.md'), 'utf8')).toBe(brief)
    const send = runner.calls.find((argv) => argv.includes('send')) ?? []
    expect(send[send.indexOf('--text') + 1]).toBe(BRIEF_POINTER_PROMPT)
    // Without a path there is nowhere to put the file: the brief is typed as before.
    const inline = orca([true])
    await launchWorkerTerminal({ runner: inline, config: config(), worktreeId: 'repo::/wt', command: 'claude', title: 't', brief: 'short' })
    const typed = inline.calls.find((argv) => argv.includes('send')) ?? []
    expect(typed[typed.indexOf('--text') + 1]).toBe('short')
    expect(existsSync(join(tmpdir(), '.ak-loop', 'brief.md'))).toBe(false)
  })

  it('does not count a typed-but-unsubmitted brief as delivered: it observes, presses Enter, and observes again', async () => {
    const calls: string[][] = []
    const sendReplies = [
      { send: { accepted: true, prompt: { requestId: 'r-1', stages: ['input_accepted'] } } },
      { send: { accepted: true, prompt: { requestId: 'r-1', stages: ['input_accepted'] } } },
      { send: { accepted: true } },
      { send: { accepted: true, prompt: { requestId: 'r-1', stages: ['input_accepted', 'turn_started'] } } },
    ]
    const runner = { run: async (argv: readonly string[]) => {
      calls.push([...argv])
      if (argv.includes('create')) return ok({ terminal: { handle: 'term-1' } })
      if (argv.includes('wait')) return ok({ wait: { satisfied: true } })
      return ok(sendReplies.shift() ?? {})
    } }
    const launched = await launchWorkerTerminal({ runner, config: config(), worktreeId: 'repo::/wt', command: 'claude', title: 't', brief: 'short' })
    expect(launched.accepted).toBe(true)
    const sends = calls.filter((argv) => argv.includes('send'))
    expect(sends).toHaveLength(4)
    expect(sends[1]).toEqual(expect.arrayContaining(['--retry-request', 'r-1']))
    // The bare Enter carries no text: it submits what is already typed, or does nothing.
    expect(sends[2]).not.toContain('--text')
    expect(sends[3]).toEqual(expect.arrayContaining(['--retry-request', 'r-1']))
  })

  it('confirms an unobservable agent by its screen, and sends again when the keystrokes were dropped', async () => {
    const calls: string[][] = []
    // Orca cannot see this agent's turns; the first send lands on a splash screen and is lost.
    const screens = ['Ask anything…', 'Your full task brief is in .ak-loop/brief.md at the root']
    const runner = { run: async (argv: readonly string[]) => {
      calls.push([...argv])
      if (argv.includes('create')) return ok({ terminal: { handle: 'term-1' } })
      if (argv.includes('wait')) return ok({ wait: { satisfied: true } })
      // Once the resent brief is on screen it stays there: the turn started.
      if (argv.includes('read')) return ok({ terminal: { tail: [screens.length > 1 ? screens.shift() : screens[0]] } })
      return ok({ send: { accepted: true, prompt: { requestId: 'r', stages: ['input_accepted'], observation: 'unsupported' } } })
    } }
    const worktree = mkdtempSync(join(tmpdir(), 'agentskit-launch-wt-')); dirs.push(worktree)
    const launched = await launchWorkerTerminal({ runner, config: config(), worktreeId: 'repo::/wt', worktreePath: worktree, command: 'opencode', title: 't', brief: 'long brief', screenCheckDelayMs: 0 })
    expect(launched.accepted).toBe(true)
    expect(calls.filter((argv) => argv.includes('send'))).toHaveLength(2)
    // No bare Enter and no retry-by-id: those need turn observation this agent does not have.
    expect(calls.some((argv) => argv.includes('--retry-request'))).toBe(false)
  })

  it('sends again when the brief shows up and then vanishes without a turn starting', async () => {
    const calls: string[][] = []
    // Observed on opencode: the pointer prompt appeared, then the TUI dropped it and sat on an empty input.
    const screens = ['Your full task brief is in .ak-loop/brief.md at the root', 'Ask anything…', 'Your full task brief is in .ak-loop/brief.md at the root']
    const runner = { run: async (argv: readonly string[]) => {
      calls.push([...argv])
      if (argv.includes('create')) return ok({ terminal: { handle: 'term-1' } })
      if (argv.includes('wait')) return ok({ wait: { satisfied: true } })
      if (argv.includes('read')) return ok({ terminal: { tail: [screens.length > 1 ? screens.shift() : screens[0]] } })
      return ok({ send: { accepted: true, prompt: { requestId: 'r', stages: ['input_accepted'], observation: 'unsupported' } } })
    } }
    const worktree = mkdtempSync(join(tmpdir(), 'agentskit-launch-wt-')); dirs.push(worktree)
    const launched = await launchWorkerTerminal({ runner, config: config(), worktreeId: 'repo::/wt', worktreePath: worktree, command: 'opencode', title: 't', brief: 'long brief', screenCheckDelayMs: 0 })
    expect(launched.accepted).toBe(true)
    expect(calls.filter((argv) => argv.includes('send'))).toHaveLength(2)
  })

  it('reports the brief as not accepted when it never stays on screen', async () => {
    const runner = { run: async (argv: readonly string[]) => {
      if (argv.includes('create')) return ok({ terminal: { handle: 'term-1' } })
      if (argv.includes('wait')) return ok({ wait: { satisfied: true } })
      if (argv.includes('read')) return ok({ terminal: { tail: ['Ask anything…'] } })
      return ok({ send: { accepted: true, prompt: { requestId: 'r', stages: ['input_accepted'], observation: 'unsupported' } } })
    } }
    const worktree = mkdtempSync(join(tmpdir(), 'agentskit-launch-wt-')); dirs.push(worktree)
    expect((await launchWorkerTerminal({ runner, config: config(), worktreeId: 'repo::/wt', worktreePath: worktree, command: 'opencode', title: 't', brief: 'long brief', screenCheckDelayMs: 0 })).accepted).toBe(false)
  })
})

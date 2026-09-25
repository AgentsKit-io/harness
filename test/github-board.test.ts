import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createIssueBoardCache, createIssueBoardReader, githubOpenIssues, parseGitHubIssue, resolveConnectors, validateLoopConfig,
  type CommandResult, type CommandRunner, type LoadedLoopConfig,
} from '../src/index.js'

const cleanups: string[] = []
afterEach(() => { for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true }) })

const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: '', timedOut: false, durationMs: 1 })
const issue = (number: number, updatedAt: string, title = `Issue ${number}`): Record<string, unknown> => ({
  number, url: `https://github.com/acme/app/issues/${number}`, title, state: 'OPEN',
  labels: [{ name: 'bug' }], assignees: [{ login: 'alice' }], createdAt: '2026-09-20T00:00:00Z', updatedAt,
})
const runnerFor = (payload: unknown): CommandRunner & { readonly calls: readonly (readonly string[])[] } => {
  const calls: (readonly string[])[] = []
  return { calls, run: async (argv) => { calls.push(argv); return ok(JSON.stringify(payload)) } }
}

const githubConfig = () => validateLoopConfig({
  project: { name: 'GitHub board', repo: 'acme/app' },
  connectors: { tracker: 'github' },
  models: {
    orchestrator: [['codex/model']], reviewer: [['codex/model']], builder: [['codex/model']], watcher: [['codex/model']],
    providers: { codex: { bin: 'codex', tui: 'codex' } },
  },
  delivery: { verifyCommand: 'pnpm test' },
})

const loadedFor = (root: string, config = githubConfig()): LoadedLoopConfig => {
  const stateDir = join(root, '.ak-loop')
  mkdirSync(stateDir, { recursive: true })
  return { path: join(root, 'loop.config.yaml'), root, stateDir, config, configHash: 'hash', unknownKeys: [] }
}

describe('GitHub Issues board adapter', () => {
  it('reads open issues through gh with a bounded, updated-first query', async () => {
    const runner = runnerFor([issue(1, '2026-09-22T00:00:00Z'), issue(2, '2026-09-23T00:00:00Z')])
    const result = await githubOpenIssues(runner, { repo: 'acme/app', limit: 3 })
    expect(result.map((item) => item.identifier)).toEqual(['acme/app#2', 'acme/app#1'])
    expect(runner.calls[0]).toEqual(['gh', 'issue', 'list', '--repo', 'acme/app', '--state', 'open', '--limit', '3', '--search', 'sort:updated-desc', '--json', 'number,url,title,state,labels,assignees,createdAt,updatedAt'])
  })

  it('fails closed on malformed issue payloads', () => {
    expect(() => parseGitHubIssue({ number: 0 }, 'acme/app')).toThrow(/positive numeric number/)
    expect(() => parseGitHubIssue({ number: 1, state: 'UNKNOWN', title: 'x', url: 'u', createdAt: 'x', updatedAt: 'x' }, 'acme/app')).toThrow(/incomplete/)
  })
})

describe('provider-selected board cache', () => {
  it('selects GitHub without constructing or calling Linear, caches within TTL, and marks a failed refresh stale', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentskit-github-board-')); cleanups.push(root)
    const loaded = loadedFor(root)
    let current = new Date('2026-09-23T12:00:00Z')
    const runner = runnerFor([issue(7, '2026-09-23T11:59:00Z')])
    const reader = createIssueBoardReader({ loaded, runner })
    const cache = createIssueBoardCache({ loaded, reader, now: () => current, path: join(root, 'ui', 'github-issues.json') })
    await expect(cache.read()).resolves.toMatchObject({ provider: 'github', status: 'fresh', issues: [{ identifier: 'acme/app#7', lane: 'unclassified' }] })
    expect(runner.calls).toHaveLength(1)
    await cache.read()
    expect(runner.calls).toHaveLength(1)
    current = new Date('2026-09-23T12:02:00Z')
    const failing: CommandRunner = { run: async () => ({ code: 1, stdout: '', stderr: 'not logged in', timedOut: false, durationMs: 1 }) }
    const stale = createIssueBoardCache({ loaded, reader: createIssueBoardReader({ loaded, runner: failing }), now: () => current, path: join(root, 'ui', 'github-issues.json') })
    await expect(stale.read()).resolves.toMatchObject({ provider: 'github', status: 'stale', issues: [{ identifier: 'acme/app#7' }], error: 'gh issue list exited 1: not logged in' })
    expect(readFileSync(join(root, 'ui', 'github-issues.json'), 'utf8')).toContain('acme/app#7')
  })

  it('returns unavailable when no snapshot exists and the GitHub CLI is not authenticated', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentskit-github-board-')); cleanups.push(root)
    const loaded = loadedFor(root)
    const runner: CommandRunner = { run: async () => ({ code: 1, stdout: '', stderr: 'auth required', timedOut: false, durationMs: 1 }) }
    const cache = createIssueBoardCache({ loaded, reader: createIssueBoardReader({ loaded, runner }), path: join(root, 'ui', 'github-issues.json') })
    await expect(cache.read()).resolves.toMatchObject({ status: 'unavailable', issues: [], error: 'gh issue list exited 1: auth required' })
  })

  it('retains the configured ceiling and reports an extra row as truncated', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentskit-github-board-')); cleanups.push(root)
    const config = validateLoopConfig({ ...githubConfig(), github: { ...githubConfig().github, issues: { state: 'open', maxIssues: 1, refreshSeconds: 60 } } })
    const loaded = loadedFor(root, config)
    const reader = createIssueBoardReader({ loaded, runner: runnerFor([issue(1, '2026-09-22T00:00:00Z'), issue(2, '2026-09-23T00:00:00Z')]) })
    await expect(reader.read()).resolves.toMatchObject({ truncated: true, issues: [{ identifier: 'acme/app#2' }] })
  })

  it('accepts a GitHub config without Linear credentials while preserving Linear defaults', async () => {
    const config = githubConfig()
    expect(config.connectors.tracker).toBe('github')
    expect(config.github.issues).toMatchObject({ state: 'open', maxIssues: 500, refreshSeconds: 60, labels: { todo: 'loop:todo', done: 'loop:done' } })
    expect(config.linear.workspaceId).toBe('github')
    expect(() => validateLoopConfig({ ...config, connectors: { ...config.connectors, tracker: 'linear' }, linear: undefined })).toThrow(/linear is required/)
    expect(resolveConnectors({ runner: runnerFor([]), config }).tracker.id).toBe('github')
  })
})

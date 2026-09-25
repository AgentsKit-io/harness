import { describe, expect, it } from 'vitest'
import { createGitHubTracker, validateLoopConfig, type CommandResult, type CommandRunner } from '../src/index.js'

const config = () => validateLoopConfig({
  project: { name: 'GitHub', repo: 'acme/app' },
  connectors: { tracker: 'github' },
  delivery: { verifyCommand: 'pnpm test' },
  models: { orchestrator: [['codex/model']], reviewer: [['codex/model']], builder: [['codex/model']], watcher: [['codex/model']], providers: { codex: { bin: 'codex', tui: 'codex' } } },
})

const detail = (labels = [{ name: 'loop:todo' }]) => ({ number: 7, url: 'https://github.com/acme/app/issues/7', title: 'Fix queue', state: 'OPEN', body: 'description', labels, assignees: [{ login: 'alice' }], createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-23T00:00:00Z', comments: [] })

describe('GitHub tracker adapter', () => {
  it('rejects a return state that cannot be mapped to a configured lifecycle label', () => {
    const base = config()
    expect(() => validateLoopConfig({ ...base, delivery: { ...base.delivery, returnState: 'ai-done' } })).toThrow(/returnState.*GitHub lifecycle label/)
  })

  it('uses the authenticated user, normalizes the queue and applies exclusive lifecycle labels', async () => {
    const calls: string[][] = []
    const runner: CommandRunner = { run: async (argv): Promise<CommandResult> => {
      calls.push([...argv])
      if (argv.includes('user')) return { code: 0, stdout: JSON.stringify({ login: 'alice' }), stderr: '', timedOut: false, durationMs: 1 }
      if (argv.includes('issue') && argv.includes('list')) return { code: 0, stdout: JSON.stringify([detail()]), stderr: '', timedOut: false, durationMs: 1 }
      if (argv.includes('issue') && argv.includes('view')) return { code: 0, stdout: JSON.stringify(detail()), stderr: '', timedOut: false, durationMs: 1 }
      return { code: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 }
    } }
    const tracker = createGitHubTracker({ runner, config: config() })
    await expect(tracker.queue({ assignee: 'ignored-by-github-adapter' })).resolves.toMatchObject([{ identifier: 'acme/app#7', state: 'Todo', assignee: 'alice' }])
    await tracker.setState({ issue: 'acme/app#7', to: 'In Progress', reason: 'started' })
    const edit = calls.find((argv) => argv.includes('issue') && argv.includes('edit'))
    expect(edit).toEqual(expect.arrayContaining(['--remove-label', 'loop:todo', '--add-label', 'loop:in-progress']))
    expect(edit).not.toContain('loop:review')
    expect(edit).not.toContain('loop:done')
    expect(edit).not.toContain('loop:blocked')
  })

  it('does not fail a state transition because an absent lifecycle label cannot be removed', async () => {
    const calls: string[][] = []
    const runner: CommandRunner = { run: async (argv): Promise<CommandResult> => {
      calls.push([...argv])
      if (argv.includes('issue') && argv.includes('view')) return { code: 0, stdout: JSON.stringify(detail([{ name: 'ai-working' }])), stderr: '', timedOut: false, durationMs: 1 }
      return { code: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 }
    } }
    const github = validateLoopConfig({ ...config(), github: { ...config().github, issues: { ...config().github.issues, labels: { todo: 'ai-ready', inProgress: 'ai-working', review: 'ai-pr', done: 'ai-done', blocked: 'ai-blocked' } } } })
    await expect(createGitHubTracker({ runner, config: github }).setState({ issue: 'acme/app#7', to: 'Todo' })).resolves.toBeUndefined()
    const edit = calls.find((argv) => argv.includes('issue') && argv.includes('edit'))
    expect(edit).toEqual(expect.arrayContaining(['--remove-label', 'ai-working', '--add-label', 'ai-ready']))
    expect(edit).not.toContain('ai-done')
  })

  it('deduplicates comments and fails preflight without write permission', async () => {
    const calls: string[][] = []
    let commentPosted = false
    const runner: CommandRunner = { run: async (argv): Promise<CommandResult> => {
      calls.push([...argv])
      if (argv[1] === 'auth') return { code: 0, stdout: 'logged in', stderr: '', timedOut: false, durationMs: 1 }
      if (argv[1] === 'repo') return { code: 0, stdout: JSON.stringify({ viewerPermission: 'READ' }), stderr: '', timedOut: false, durationMs: 1 }
      if (argv[1] === 'api' && argv[2] === 'user') return { code: 0, stdout: JSON.stringify({ login: 'alice' }), stderr: '', timedOut: false, durationMs: 1 }
      if (argv[1] === 'api' && argv[2] === '--paginate') return { code: 0, stdout: JSON.stringify(commentPosted ? ['<!-- harness:comment-1 -->'] : []), stderr: '', timedOut: false, durationMs: 1 }
      if (argv[1] === 'issue' && argv[2] === 'comment') commentPosted = true
      return { code: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 }
    } }
    const tracker = createGitHubTracker({ runner, config: config() })
    await tracker.comment({ issue: 'acme/app#7', body: 'hello', dedupeKey: 'comment-1' })
    await tracker.comment({ issue: 'acme/app#7', body: 'hello', dedupeKey: 'comment-1' })
    expect(calls.filter((argv) => argv.includes('issue') && argv.includes('comment'))).toHaveLength(1)
    await expect(tracker.preflight?.()).rejects.toThrow(/write access/)
  })

  it('fails closed when configured lifecycle labels are missing', async () => {
    const runner: CommandRunner = { run: async (argv): Promise<CommandResult> => {
      if (argv[1] === 'repo') return { code: 0, stdout: JSON.stringify({ viewerPermission: 'WRITE' }), stderr: '', timedOut: false, durationMs: 1 }
      if (argv[1] === 'api' && argv[2] === 'user') return { code: 0, stdout: JSON.stringify({ login: 'alice' }), stderr: '', timedOut: false, durationMs: 1 }
      if (argv[1] === 'label') return { code: 0, stdout: JSON.stringify([{ name: 'loop:todo' }]), stderr: '', timedOut: false, durationMs: 1 }
      return { code: 0, stdout: 'logged in', stderr: '', timedOut: false, durationMs: 1 }
    } }
    await expect(createGitHubTracker({ runner, config: config() }).preflight?.()).rejects.toThrow(/lifecycle labels are missing/)
  })

  it('keeps planned backlog issues unclassified until a human moves them into the queue', async () => {
    const calls: string[][] = []
    const runner: CommandRunner = { run: async (argv): Promise<CommandResult> => {
      calls.push([...argv])
      if (argv[1] === 'api' && argv[2] === 'user') return { code: 0, stdout: JSON.stringify({ login: 'alice' }), stderr: '', timedOut: false, durationMs: 1 }
      if (argv[1] === 'issue' && argv[2] === 'create') return { code: 0, stdout: 'https://github.com/acme/app/issues/8\n', stderr: '', timedOut: false, durationMs: 1 }
      return { code: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 }
    } }
    const result = await createGitHubTracker({ runner, config: config() }).createIssue({ title: 'Planned', description: 'human gate', state: 'Backlog' })
    expect(result.identifier).toBe('acme/app#8')
    expect(calls.find((argv) => argv[1] === 'issue' && argv[2] === 'create')).not.toContain('loop:todo')
  })
})

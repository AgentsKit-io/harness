import { describe, expect, it } from 'vitest'
import { createGitHubTracker, validateLoopConfig, type CommandResult, type CommandRunner } from '../src/index.js'

const config = () => validateLoopConfig({
  project: { name: 'GitHub', repo: 'acme/app' },
  connectors: { tracker: 'github' },
  delivery: { verifyCommand: 'pnpm test' },
  models: { orchestrator: [['codex/model']], reviewer: [['codex/model']], builder: [['codex/model']], watcher: [['codex/model']], providers: { codex: { bin: 'codex', tui: 'codex' } } },
})

const PRESENT_LABELS = ['loop:todo', 'loop:in-progress', 'loop:review', 'loop:done', 'loop:blocked', 'ai-ready', 'ai-working', 'ai-pr', 'ai-done', 'ai-blocked'].map((name) => ({ name }))
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
      if (argv.includes('label') && argv.includes('list')) return { code: 0, stdout: JSON.stringify(PRESENT_LABELS), stderr: '', timedOut: false, durationMs: 1 }
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

  it('queueOwnership both keeps unassigned and own issues, person only own, unassigned only unassigned', async () => {
    const issue = (number: number, assignees: { login: string }[]) => ({ ...detail(), number, url: `https://github.com/acme/app/issues/${number}`, assignees })
    const issues = [issue(1, []), issue(2, [{ login: 'alice' }]), issue(3, [{ login: 'bob' }])]
    const runner: CommandRunner = { run: async (argv): Promise<CommandResult> => {
      const stdout = argv.includes('user') ? JSON.stringify({ login: 'alice' }) : argv.includes('issue') && argv.includes('list') ? JSON.stringify(issues) : ''
      return { code: 0, stdout, stderr: '', timedOut: false, durationMs: 1 }
    } }
    const queueFor = async (queueOwnership: 'person' | 'unassigned' | 'both') => (await createGitHubTracker({ runner, config: { ...config(), linear: { ...config().linear, queueOwnership } } }).queue({ assignee: 'ignored-by-github-adapter' })).map((entry) => entry.identifier).sort()
    expect(await queueFor('person')).toEqual(['acme/app#2'])
    expect(await queueFor('unassigned')).toEqual(['acme/app#1'])
    expect(await queueFor('both')).toEqual(['acme/app#1', 'acme/app#2'])
  })

  it('does not fail a state transition because an absent lifecycle label cannot be removed', async () => {
    const calls: string[][] = []
    const runner: CommandRunner = { run: async (argv): Promise<CommandResult> => {
      calls.push([...argv])
      if (argv.includes('label') && argv.includes('list')) return { code: 0, stdout: JSON.stringify(PRESENT_LABELS), stderr: '', timedOut: false, durationMs: 1 }
      if (argv.includes('issue') && argv.includes('view')) return { code: 0, stdout: JSON.stringify(detail([{ name: 'ai-working' }])), stderr: '', timedOut: false, durationMs: 1 }
      return { code: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 }
    } }
    const github = validateLoopConfig({ ...config(), github: { ...config().github, issues: { ...config().github.issues, labels: { todo: 'ai-ready', inProgress: 'ai-working', review: 'ai-pr', done: 'ai-done', blocked: 'ai-blocked' } } } })
    await expect(createGitHubTracker({ runner, config: github }).setState({ issue: 'acme/app#7', to: 'Todo' })).resolves.toBeUndefined()
    const edit = calls.find((argv) => argv.includes('issue') && argv.includes('edit'))
    expect(edit).toEqual(expect.arrayContaining(['--remove-label', 'ai-working', '--add-label', 'ai-ready']))
    expect(edit).not.toContain('ai-done')
  })

  it('creates a missing lifecycle label before applying it, instead of failing the transition', async () => {
    // Live: `ai-done` did not exist, so every completion after a merge failed with "'ai-done' not found".
    const calls: string[][] = []
    const runner: CommandRunner = { run: async (argv): Promise<CommandResult> => {
      calls.push([...argv])
      if (argv.includes('label') && argv.includes('list')) return { code: 0, stdout: JSON.stringify(['ai-ready', 'ai-working', 'ai-pr', 'ai-blocked'].map((name) => ({ name }))), stderr: '', timedOut: false, durationMs: 1 }
      if (argv.includes('label') && argv.includes('create')) return { code: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 }
      if (argv.includes('issue') && argv.includes('view')) return { code: 0, stdout: JSON.stringify(detail([{ name: 'ai-pr' }])), stderr: '', timedOut: false, durationMs: 1 }
      return { code: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 }
    } }
    const github = validateLoopConfig({ ...config(), github: { ...config().github, issues: { ...config().github.issues, labels: { todo: 'ai-ready', inProgress: 'ai-working', review: 'ai-pr', done: 'ai-done', blocked: 'ai-blocked' } } } })
    const tracker = createGitHubTracker({ runner, config: github })
    await tracker.setState({ issue: 'acme/app#7', to: 'Done' })
    const created = calls.filter((argv) => argv.includes('label') && argv.includes('create'))
    expect(created.map((argv) => argv[argv.indexOf('create') + 1])).toEqual(['ai-done'])
    expect(calls.indexOf(created[0]!)).toBeLessThan(calls.findIndex((argv) => argv.includes('issue') && argv.includes('edit')))
    // Cached per connector: a second transition does not list or create labels again.
    await tracker.setState({ issue: 'acme/app#8', to: 'Done' })
    expect(calls.filter((argv) => argv.includes('label') && argv.includes('list'))).toHaveLength(1)
  })

  it('treats a label another machine created in the meantime as present', async () => {
    const runner: CommandRunner = { run: async (argv): Promise<CommandResult> => {
      if (argv.includes('label') && argv.includes('list')) return { code: 0, stdout: '[]', stderr: '', timedOut: false, durationMs: 1 }
      if (argv.includes('label') && argv.includes('create')) return { code: 1, stdout: '', stderr: 'label with name "ai-done" already exists; use `--force` to update its color and description', timedOut: false, durationMs: 1 }
      if (argv.includes('issue') && argv.includes('view')) return { code: 0, stdout: JSON.stringify(detail([{ name: 'ai-pr' }])), stderr: '', timedOut: false, durationMs: 1 }
      return { code: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 }
    } }
    const github = validateLoopConfig({ ...config(), github: { ...config().github, issues: { ...config().github.issues, labels: { todo: 'ai-ready', inProgress: 'ai-working', review: 'ai-pr', done: 'ai-done', blocked: 'ai-blocked' } } } })
    await expect(createGitHubTracker({ runner, config: github }).setState({ issue: 'acme/app#7', to: 'Done' })).resolves.toBeUndefined()
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

  it('reports missing lifecycle labels instead of failing — the tracker creates them on first use', async () => {
    const runner: CommandRunner = { run: async (argv): Promise<CommandResult> => {
      if (argv[1] === 'repo') return { code: 0, stdout: JSON.stringify({ viewerPermission: 'WRITE' }), stderr: '', timedOut: false, durationMs: 1 }
      if (argv[1] === 'api' && argv[2] === 'user') return { code: 0, stdout: JSON.stringify({ login: 'alice' }), stderr: '', timedOut: false, durationMs: 1 }
      if (argv[1] === 'label') return { code: 0, stdout: JSON.stringify([{ name: 'loop:todo' }]), stderr: '', timedOut: false, durationMs: 1 }
      return { code: 0, stdout: 'logged in', stderr: '', timedOut: false, durationMs: 1 }
    } }
    // Used to throw INVALID_CONFIG, which doctor turned into a failed queue read; githubEnsureLabels now self-heals.
    await expect(createGitHubTracker({ runner, config: config() }).preflight?.()).resolves.toMatchObject({ login: 'alice', permission: 'WRITE', missingLabels: ['loop:in-progress', 'loop:review', 'loop:done', 'loop:blocked'] })
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

  describe('queue label filters', () => {
    const runnerFor = (issues: unknown[]): CommandRunner => ({ run: async (argv): Promise<CommandResult> => {
      const stdout = argv.includes('user') ? JSON.stringify({ login: 'alice' }) : argv.includes('issue') && argv.includes('list') ? JSON.stringify(issues) : ''
      return { code: 0, stdout, stderr: '', timedOut: false, durationMs: 1 }
    } })
    // What the web-app / monorepo presets set: a Linear layer filter that a plain `loop:todo` issue does not satisfy.
    const withLinearLayers = (extra: Record<string, unknown> = {}) => validateLoopConfig({ ...config(), linear: { ...config().linear, anyLabels: ['layer:ui', 'layer:api'], requireLabels: ['type:fix'], projects: ['Web'] }, ...extra })

    it('ignores linear.anyLabels, requireLabels and projects for a plain loop:todo issue', async () => {
      const tracker = createGitHubTracker({ runner: runnerFor([detail()]), config: withLinearLayers() })
      await expect(tracker.queue({ assignee: null })).resolves.toMatchObject([{ identifier: 'acme/app#7' }])
      expect(tracker.queueSkips?.()).toEqual([])
    })

    it('github.issues.anyLabels narrows the queue and the skip names that key', async () => {
      const base = withLinearLayers()
      const github = validateLoopConfig({ ...base, github: { ...base.github, issues: { ...base.github.issues, anyLabels: ['ready'] } } })
      const tracker = createGitHubTracker({ runner: runnerFor([detail(), { ...detail([{ name: 'loop:todo' }, { name: 'ready' }]), number: 8, url: 'https://github.com/acme/app/issues/8' }]), config: github })
      expect((await tracker.queue({ assignee: null })).map((issue) => issue.identifier)).toEqual(['acme/app#8'])
      expect(tracker.queueSkips?.()).toEqual([{ identifier: 'acme/app#7', reason: expect.stringContaining('github.issues.anyLabels (ready)') }])
    })

    it('names the excluded label and the ownership that drop a loop:todo issue', async () => {
      const base = config()
      const excluded = validateLoopConfig({ ...base, linear: { ...base.linear, excludeLabels: ['wontfix'] } })
      const one = createGitHubTracker({ runner: runnerFor([detail([{ name: 'loop:todo' }, { name: 'wontfix' }])]), config: excluded })
      expect(await one.queue({ assignee: null })).toEqual([])
      expect(one.queueSkips?.()).toEqual([{ identifier: 'acme/app#7', reason: 'label "wontfix" is in linear.excludeLabels' }])
      const other = createGitHubTracker({ runner: runnerFor([{ ...detail(), assignees: [{ login: 'bob' }] }]), config: base })
      expect(await other.queue({ assignee: null })).toEqual([])
      expect(other.queueSkips?.()[0]?.reason).toContain('assignee bob is outside queueOwnership')
    })
  })
})

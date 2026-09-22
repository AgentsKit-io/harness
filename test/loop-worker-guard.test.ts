import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assessWorkerGuard, installWorkerGuard, parseLoopConfigText, runWorkerGuard } from '../src/index.js'
import { extractFilePath, parsePreToolUseEvent } from '../src/loop/worker-guard.js'
import type { LoopConfig } from '../src/index.js'

const exampleYaml = readFileSync(join(process.cwd(), 'loop.config.example.yaml'), 'utf8').replace('person: my-linear-display-name', 'person: person')
const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const tempDir = (): string => { const dir = mkdtempSync(join(tmpdir(), 'agentskit-worker-guard-')); cleanups.push(dir); return dir }

const config = (extra = ''): LoopConfig => parseLoopConfigText(`${exampleYaml}${extra}`)

describe('parsePreToolUseEvent', () => {
  it('parses a well-formed hook event and rejects malformed input', () => {
    expect(parsePreToolUseEvent('{"tool_name":"Write","tool_input":{"file_path":"a.ts"},"cwd":"/w"}')).toEqual({ tool_name: 'Write', tool_input: { file_path: 'a.ts' }, cwd: '/w' })
    expect(parsePreToolUseEvent('not json')).toBeNull()
    expect(parsePreToolUseEvent('null')).toBeNull()
    expect(parsePreToolUseEvent('[]')).toEqual([]) // an array is still "an object" to typeof; assessWorkerGuard reads it as having no fields, which is the safe outcome
  })
})

describe('extractFilePath', () => {
  it('reads file_path for a guarded tool and ignores everything else', () => {
    expect(extractFilePath({ tool_name: 'Write', tool_input: { file_path: 'src/a.ts' } })).toBe('src/a.ts')
    expect(extractFilePath({ tool_name: 'Edit', tool_input: { file_path: 'src/b.ts' } })).toBe('src/b.ts')
    expect(extractFilePath({ tool_name: 'MultiEdit', tool_input: { file_path: 'src/c.ts', edits: [] } })).toBe('src/c.ts')
    expect(extractFilePath({ tool_name: 'Bash', tool_input: { command: 'echo hi > .env' } })).toBeNull()
    expect(extractFilePath({ tool_name: 'Read', tool_input: { file_path: 'src/a.ts' } })).toBeNull()
    expect(extractFilePath({ tool_name: 'Write', tool_input: {} })).toBeNull()
    expect(extractFilePath({})).toBeNull()
  })
})

describe('assessWorkerGuard', () => {
  const selfEditPaths = ['loop.config.yaml', '.github/**']
  const secretFilePatterns = ['**/.env', '**/*.pem']

  it('blocks a write to a protected path, with a reason naming which rule', () => {
    expect(assessWorkerGuard({ filePath: '.github/workflows/ci.yml', cwd: '/w', selfEditPaths, secretFilePatterns })).toMatchObject({ blocked: true, reason: expect.stringContaining('selfEditPaths') })
  })

  it('blocks a write to a secret-shaped filename', () => {
    expect(assessWorkerGuard({ filePath: 'packages/api/.env', cwd: '/w', selfEditPaths, secretFilePatterns })).toMatchObject({ blocked: true, reason: expect.stringContaining('secretFilePatterns') })
  })

  it('allows an ordinary file, and a null path (a tool this check has no opinion on)', () => {
    expect(assessWorkerGuard({ filePath: 'src/index.ts', cwd: '/w', selfEditPaths, secretFilePatterns })).toEqual({ blocked: false, reason: null })
    expect(assessWorkerGuard({ filePath: null, cwd: '/w', selfEditPaths, secretFilePatterns })).toEqual({ blocked: false, reason: null })
  })

  it('relativizes an absolute path against cwd before matching', () => {
    expect(assessWorkerGuard({ filePath: '/w/loop.config.yaml', cwd: '/w', selfEditPaths, secretFilePatterns })).toMatchObject({ blocked: true })
    expect(assessWorkerGuard({ filePath: '/w/src/index.ts', cwd: '/w', selfEditPaths, secretFilePatterns })).toEqual({ blocked: false, reason: null })
  })

  it('does not block a path outside the worktree — not this check\'s business', () => {
    expect(assessWorkerGuard({ filePath: '/etc/loop.config.yaml', cwd: '/w', selfEditPaths, secretFilePatterns })).toEqual({ blocked: false, reason: null })
  })
})

describe('runWorkerGuard', () => {
  it('exits 2 with the reason on stderr when the event names a protected write', () => {
    const event = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'loop.config.yaml' }, cwd: '/w' })
    expect(runWorkerGuard(event, config(), '/w')).toMatchObject({ exitCode: 2, message: expect.stringContaining('loop.config.yaml') })
  })

  it('exits 0 with no message for an allowed write, an unguarded tool, or unparseable stdin', () => {
    const allowed = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'src/index.ts' }, cwd: '/w' })
    expect(runWorkerGuard(allowed, config(), '/w')).toEqual({ exitCode: 0, message: null })
    const bash = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm loop.config.yaml' }, cwd: '/w' })
    expect(runWorkerGuard(bash, config(), '/w')).toEqual({ exitCode: 0, message: null })
    expect(runWorkerGuard('garbage', config(), '/w')).toEqual({ exitCode: 0, message: null })
  })

  it('falls back to the caller-supplied cwd when the event carries none', () => {
    const event = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'loop.config.yaml' } })
    expect(runWorkerGuard(event, config(), '/w')).toMatchObject({ exitCode: 2 })
  })
})

describe('installWorkerGuard', () => {
  it('writes a Claude Code PreToolUse hook into a fresh worktree, and never duplicates it on a second install', () => {
    const worktreePath = tempDir()
    const first = installWorkerGuard({ worktreePath, provider: 'claude', config: config(), cliPath: '/bin/ak-harness' })
    expect(first).toEqual({ installed: true, path: join(worktreePath, '.claude', 'settings.local.json') })
    const written = JSON.parse(readFileSync(first.installed ? first.path : '', 'utf8'))
    expect(written).toMatchObject({ hooks: { PreToolUse: [{ matcher: 'Write|Edit|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: '"/bin/ak-harness" loop worker-guard' }] }] } })

    installWorkerGuard({ worktreePath, provider: 'claude', config: config(), cliPath: '/bin/ak-harness' })
    const rewritten = JSON.parse(readFileSync(join(worktreePath, '.claude', 'settings.local.json'), 'utf8'))
    expect(rewritten.hooks.PreToolUse).toHaveLength(1) // not duplicated
  })

  it('merges into an existing .claude/settings.local.json instead of overwriting it', () => {
    const worktreePath = tempDir()
    mkdirSync(join(worktreePath, '.claude'), { recursive: true })
    const settingsPath = join(worktreePath, '.claude', 'settings.local.json')
    writeFileSync(settingsPath, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo project-owned-hook' }] }] }, permissions: { allow: ['Bash(pnpm test)'] } }), 'utf8')
    installWorkerGuard({ worktreePath, provider: 'claude', config: config(), cliPath: '/bin/ak-harness' })
    const merged = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(merged.permissions).toEqual({ allow: ['Bash(pnpm test)'] }) // untouched
    expect(merged.hooks.PreToolUse).toHaveLength(2)
    expect(merged.hooks.PreToolUse[0]).toMatchObject({ matcher: 'Bash' }) // the project's own hook, kept first
  })

  it('writes the same shape for grok, at .grok/hooks/config.json', () => {
    const worktreePath = tempDir()
    const outcome = installWorkerGuard({ worktreePath, provider: 'grok', config: config(), cliPath: '/bin/ak-harness' })
    expect(outcome).toEqual({ installed: true, path: join(worktreePath, '.grok', 'hooks', 'config.json') })
    const written = JSON.parse(readFileSync(outcome.installed ? outcome.path : '', 'utf8'))
    expect(written.hooks.PreToolUse[0].hooks[0].command).toBe('"/bin/ak-harness" loop worker-guard')
  })

  it('writes static deny rules for opencode instead of a hook, and never overwrites a rule the project already declared', () => {
    const worktreePath = tempDir()
    const path = join(worktreePath, 'opencode.json')
    writeFileSync(path, JSON.stringify({}), 'utf8')
    const outcome = installWorkerGuard({ worktreePath, provider: 'opencode', config: config(), cliPath: '/bin/ak-harness' })
    expect(outcome).toEqual({ installed: true, path })
    const written = JSON.parse(readFileSync(path, 'utf8'))
    expect(written.permission.edit['loop.config.yaml']).toBe('deny')
    expect(written.permission.edit['.github/**']).toBe('deny')
    expect(written.permission.edit['**/.env']).toBe('deny')

    // A project that already opted a pattern into "ask" keeps that choice.
    writeFileSync(path, JSON.stringify({ permission: { edit: { 'loop.config.yaml': 'ask' } } }), 'utf8')
    installWorkerGuard({ worktreePath, provider: 'opencode', config: config(), cliPath: '/bin/ak-harness' })
    const respected = JSON.parse(readFileSync(path, 'utf8'))
    expect(respected.permission.edit['loop.config.yaml']).toBe('ask')
    expect(respected.permission.edit['.github/**']).toBe('deny') // still filled in
  })

  it('does nothing for codex or an unrecognized provider — the PR-time gate is its only enforcement (ADR-0038)', () => {
    const worktreePath = tempDir()
    expect(installWorkerGuard({ worktreePath, provider: 'codex', config: config(), cliPath: '/bin/ak-harness' })).toEqual({ installed: false })
    expect(installWorkerGuard({ worktreePath, provider: 'some-future-cli', config: config(), cliPath: '/bin/ak-harness' })).toEqual({ installed: false })
  })

  it('does nothing at all when delivery.workerGuard.enabled is false, regardless of provider', () => {
    const worktreePath = tempDir()
    const disabled = parseLoopConfigText(exampleYaml.replace('cleanupWorktree: true', 'cleanupWorktree: true\n  workerGuard: { enabled: false }'))
    expect(installWorkerGuard({ worktreePath, provider: 'claude', config: disabled, cliPath: '/bin/ak-harness' })).toEqual({ installed: false })
  })

  it('quotes the CLI path, so an install prefix with a space does not split into two shell words', () => {
    const worktreePath = tempDir()
    installWorkerGuard({ worktreePath, provider: 'claude', config: config(), cliPath: '/opt/Application Support/ak-harness' })
    const written = JSON.parse(readFileSync(join(worktreePath, '.claude', 'settings.local.json'), 'utf8'))
    expect(written.hooks.PreToolUse[0].hooks[0].command).toBe('"/opt/Application Support/ak-harness" loop worker-guard')
  })

  it('returns installed:false instead of throwing when the dispatch record lost its worktree path', () => {
    expect(installWorkerGuard({ worktreePath: '', provider: 'claude', config: config(), cliPath: '/bin/ak-harness' })).toEqual({ installed: false })
  })

  it('leaves an unparseable existing config alone rather than destroying it', () => {
    const worktreePath = tempDir()
    const path = join(worktreePath, 'opencode.json')
    const theirs = '{ "permission": { "edit": {} }, } // trailing comma + comment'
    writeFileSync(path, theirs, 'utf8')
    expect(installWorkerGuard({ worktreePath, provider: 'opencode', config: config(), cliPath: '/bin/ak-harness' })).toEqual({ installed: false })
    expect(readFileSync(path, 'utf8')).toBe(theirs)
  })
})

describe('extractFilePath — NotebookEdit', () => {
  it('reads notebook_path, which is what NotebookEdit actually names its target', () => {
    expect(extractFilePath({ tool_name: 'NotebookEdit', tool_input: { notebook_path: 'loop.config.yaml' } })).toBe('loop.config.yaml')
  })

  it('blocks a protected path written through NotebookEdit', () => {
    const verdict = assessWorkerGuard({
      filePath: extractFilePath({ tool_name: 'NotebookEdit', tool_input: { notebook_path: 'loop.config.yaml' } }),
      cwd: '/work',
      selfEditPaths: ['loop.config.yaml'],
      secretFilePatterns: [],
    })
    expect(verdict.blocked).toBe(true)
  })
})

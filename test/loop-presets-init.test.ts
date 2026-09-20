import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HarnessError, PRESET_NAMES, composeLoopConfig, describePreset, initQuestions, isPresetName, loadLoopConfig, presetFor, renderGlobalConfig, renderInitConfig, runLoopInit } from '../src/index.js'
import type { InitAnswers } from '../src/index.js'

const exampleYaml = readFileSync(join(process.cwd(), 'loop.config.example.yaml'), 'utf8').replace('person: my-linear-display-name', 'person: person')
const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const MINIMAL = `schemaVersion: 1
extends: monorepo
project:
  name: demo
  repo: acme/demo
linear:
  workspaceId: ws
  teamKey: ENG
  person: person
`

/** Models live in the user's layer, so every composition here supplies one — as a real setup would. */
const MODELS = `models:
  orchestrator: [[claude/opus]]
  reviewer: [[claude/opus]]
  builder: [[claude/opus]]
  watcher: [[claude/opus]]
  providers:
    claude:
      bin: claude
      tui: "claude --model {model}"
`

const ANSWERS: InitAnswers = { preset: 'library', name: 'demo', repo: 'acme/demo', baseBranch: 'main', workspaceId: 'ws', teamKey: 'ENG', person: 'person', verifyCommand: '' }

describe('presets', () => {
  it('knows its own names and describes each one', () => {
    expect(PRESET_NAMES).toContain('web-app')
    expect(isPresetName('monorepo')).toBe(true)
    expect(isPresetName('spaceship')).toBe(false)
    expect(presetFor('spaceship')).toBeNull()
    expect(describePreset('library')).toContain('verify')
    expect(describePreset('library')).toContain('changelog')
  })

  it('fills what the project left unsaid and never overrides what it stated', () => {
    const config = composeLoopConfig({ globalText: MODELS, text: MINIMAL })
    // From the preset:
    expect(config.delivery.verifyCommand).toBe('pnpm lint && pnpm test')
    expect(config.dod.items.map((item) => item.id)).toEqual(['verify', 'test-for-new-code', 'no-todo'])
    expect(config.linear.anyLabels).toEqual(['layer:L1', 'layer:L2', 'layer:L3'])
    // From the project, which wins:
    expect(config.project.repo).toBe('acme/demo')

    const overriding = composeLoopConfig({ globalText: MODELS, text: `${MINIMAL}delivery:\n  verifyCommand: make check\n` })
    expect(overriding.delivery.verifyCommand).toBe('make check')
  })

  it('sits below the user\'s global layer as well', () => {
    const config = composeLoopConfig({ globalText: `${exampleYaml}\n`, text: MINIMAL })
    expect(config.delivery.verifyCommand).toBe('pnpm lint && pnpm test')
    const overridden = composeLoopConfig({ globalText: `${MODELS}delivery:\n  verifyCommand: from-global\n`, text: MINIMAL })
    expect(overridden.delivery.verifyCommand).toBe('from-global')
  })

  it('still needs the models the user declares somewhere — a project file alone is not a whole config', () => {
    expect(() => composeLoopConfig({ text: MINIMAL })).toThrow(/models/)
  })

  it('refuses an unknown preset instead of quietly ignoring it', () => {
    expect(() => composeLoopConfig({ globalText: MODELS, text: MINIMAL.replace('monorepo', 'spaceship') })).toThrow(HarnessError)
    expect(() => composeLoopConfig({ globalText: MODELS, text: MINIMAL.replace('monorepo', 'spaceship') })).toThrow(/Unknown preset "spaceship"/)
  })

  it('changes nothing for a config that extends nothing', () => {
    expect(composeLoopConfig({ text: exampleYaml }).dod.items).toEqual([])
  })
})

describe('loop init', () => {
  const workspace = (): string => { const dir = mkdtempSync(join(tmpdir(), 'agentskit-init-')); cleanups.push(dir); return dir }

  it('asks one question per field, with alternatives for the preset and recommendations where they exist', () => {
    const questions = initQuestions()
    expect(questions[0]).toMatchObject({ key: 'preset' })
    expect(questions[0]?.options?.map((option) => option.value)).toEqual([...PRESET_NAMES])
    expect(questions[0]?.recommendation).toContain('web-app')
    expect(questions.map((question) => question.key)).toEqual(['preset', 'name', 'repo', 'baseBranch', 'workspaceId', 'teamKey', 'person', 'verifyCommand'])
  })

  it('writes a config that says only what the preset does not, and that loads', async () => {
    const dir = workspace()
    const home = workspace()
    const env = { AK_HARNESS_CONFIG: join(home, 'harness.yaml') }
    // The project file alone is deliberately not a whole config: the models a machine can use are the user's layer.
    const result = await runLoopInit({ directory: dir, answers: ANSWERS, writeGlobal: true, env })
    expect(result.wrote).toContain(join(dir, 'loop.config.yaml'))
    const text = readFileSync(result.configPath, 'utf8')
    expect(text).toContain('extends: library')
    expect(text).not.toContain('verifyCommand')
    const loaded = loadLoopConfig(result.configPath, env)
    expect(loaded.config.project.repo).toBe('acme/demo')
    // …and the preset is what fills the rest.
    expect(loaded.config.dod.items.some((item) => item.id === 'changelog')).toBe(true)
  })

  it('keeps an override the human typed', async () => {
    const dir = workspace()
    const home = workspace()
    const env = { AK_HARNESS_CONFIG: join(home, 'harness.yaml') }
    const result = await runLoopInit({ directory: dir, answers: { ...ANSWERS, verifyCommand: 'make ci' }, writeGlobal: true, env })
    expect(readFileSync(result.configPath, 'utf8')).toContain('verifyCommand: "make ci"')
    expect(loadLoopConfig(result.configPath, env).config.delivery.verifyCommand).toBe('make ci')
  })

  it('never lands on an existing config without --force', async () => {
    const dir = workspace()
    writeFileSync(join(dir, 'loop.config.yaml'), '# tuned by hand\n')
    const result = await runLoopInit({ directory: dir, answers: ANSWERS, env: { AK_HARNESS_CONFIG: join(dir, 'nowhere.yaml') } })
    expect(result.wrote).toEqual([])
    expect(result.skipped[0]).toContain('--force')
    expect(readFileSync(join(dir, 'loop.config.yaml'), 'utf8')).toBe('# tuned by hand\n')

    const forced = await runLoopInit({ directory: dir, answers: ANSWERS, force: true, env: { AK_HARNESS_CONFIG: join(dir, 'nowhere.yaml') } })
    expect(forced.wrote).toHaveLength(1)
  })

  it('writes the user layer only when asked, and only with channels — never a project setting', async () => {
    const dir = workspace()
    const home = workspace()
    const result = await runLoopInit({ directory: dir, answers: { ...ANSWERS, notifyCommand: 'terminal-notifier -message {summary}' }, writeGlobal: true, env: { AK_HARNESS_CONFIG: join(home, 'harness.yaml') } })
    expect(result.globalPath).toBe(join(home, 'harness.yaml'))
    const global = readFileSync(join(home, 'harness.yaml'), 'utf8')
    expect(global).toContain('notifications:')
    expect(global).not.toContain('project:')
    expect(renderGlobalConfig(ANSWERS)).toContain('# notifications:')
  })

  it('touches nothing on a dry run', async () => {
    const dir = workspace()
    const result = await runLoopInit({ directory: dir, answers: ANSWERS, dryRun: true, env: { AK_HARNESS_CONFIG: join(dir, 'nowhere.yaml') } })
    expect(result.wrote[0]).toContain('(dry-run)')
    expect(existsSync(join(dir, 'loop.config.yaml'))).toBe(false)
  })

  it('refuses to write a config that would not load', async () => {
    const dir = workspace()
    await expect(runLoopInit({ directory: dir, answers: { ...ANSWERS, repo: 'not a repo' }, env: { AK_HARNESS_CONFIG: join(dir, 'nowhere.yaml') } })).rejects.toThrow(/owner\/name/)
    expect(renderInitConfig(ANSWERS)).toContain('schemaVersion: 1')
  })
})

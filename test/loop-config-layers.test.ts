import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { composeLoopConfig, globalConfigPath, globalLayerDisabled, loadLoopConfig, resolveTeamKey, teamConfigFile } from '../src/index.js'
import { HarnessError } from '../src/index.js'

const exampleYaml = readFileSync(join(process.cwd(), 'loop.config.example.yaml'), 'utf8').replace('person: my-linear-display-name', 'person: person')
const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const workspace = (files: Readonly<Record<string, string>>): string => {
  const dir = mkdtempSync(join(tmpdir(), 'agentskit-loop-layers-')); cleanups.push(dir)
  writeFileSync(join(dir, 'loop.config.yaml'), exampleYaml)
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  return dir
}

describe('the four config layers', () => {
  it('points at the user layer through the environment, and can be told to ignore it', () => {
    expect(globalConfigPath({}, '/home/someone')).toBe('/home/someone/.agentskit/harness.yaml')
    expect(globalConfigPath({ AK_HARNESS_HOME: '/opt/ak' }, '/home/someone')).toBe('/opt/ak/harness.yaml')
    expect(globalConfigPath({ AK_HARNESS_CONFIG: '/etc/harness.yaml' }, '/home/someone')).toBe('/etc/harness.yaml')
    expect(globalLayerDisabled({ AK_HARNESS_NO_GLOBAL: '1' })).toBe(true)
    expect(globalLayerDisabled({})).toBe(false)
  })

  it('merges global, project, team and machine in that order, with the most specific winning', () => {
    const config = composeLoopConfig({
      globalText: 'schedule:\n  provider: codex\n  tick: "*/30 * * * *"\nmachine:\n  minFreeRamGb: 9\n',
      text: exampleYaml,
      teamText: 'schedule:\n  tick: "*/7 * * * *"\nlinear:\n  teamKey: PLAT\n',
      localText: 'machine:\n  minFreeRamGb: 2\n',
    })
    // Only the global declares it, so it survives; the project's own value wins over the global's tick…
    expect(config.schedule.provider).toBe('codex')
    expect(config.schedule.tick).not.toBe('*/30 * * * *')
    // …and the team's wins over the project's.
    expect(config.schedule.tick).toBe('*/7 * * * *')
    expect(config.linear.teamKey).toBe('PLAT')
    // The machine has the last word.
    expect(config.machine.minFreeRamGb).toBe(2)
  })

  it('takes the team key from the environment first, then from project.team', () => {
    expect(resolveTeamKey({ project: { team: 'platform' } }, {})).toBe('platform')
    expect(resolveTeamKey({ project: { team: 'platform' } }, { AK_LOOP_TEAM: 'growth' })).toBe('growth')
    expect(resolveTeamKey({ project: {} }, {})).toBeNull()
    expect(resolveTeamKey('not a mapping', {})).toBeNull()
  })

  it('loads the team layer a repo declares and reports every layer it merged', () => {
    const dir = workspace({
      'loop.config.local.yaml': 'project:\n  team: platform\n',
      [teamConfigFile('platform')]: 'delivery:\n  maxFixRounds: 5\n',
      'harness.yaml': 'notifications:\n  command: [notify-send, "{summary}"]\n',
    })
    const loaded = loadLoopConfig(join(dir, 'loop.config.yaml'), { AK_HARNESS_CONFIG: join(dir, 'harness.yaml') })
    expect(loaded.team).toBe('platform')
    expect(loaded.teamPath).toBe(join(dir, teamConfigFile('platform')))
    expect(loaded.globalPath).toBe(join(dir, 'harness.yaml'))
    expect(loaded.localPath).toBe(join(dir, 'loop.config.local.yaml'))
    expect(loaded.config.delivery.maxFixRounds).toBe(5)
    // The user's own layer survives wherever the project says nothing: this repo declares no channel.
    expect(loaded.config.notifications.command).toEqual(['notify-send', '{summary}'])
  })

  it('fails loudly when a declared team has no file, instead of running the project defaults', () => {
    const dir = workspace({ 'loop.config.local.yaml': 'project:\n  team: ghost\n' })
    expect(() => loadLoopConfig(join(dir, 'loop.config.yaml'), { AK_HARNESS_NO_GLOBAL: '1' })).toThrow(HarnessError)
    expect(() => loadLoopConfig(join(dir, 'loop.config.yaml'), { AK_HARNESS_NO_GLOBAL: '1' })).toThrow(/Team "ghost" is declared/)
  })

  it('loads a project with no global, team or machine layer at all', () => {
    const dir = workspace({})
    const loaded = loadLoopConfig(join(dir, 'loop.config.yaml'), { AK_HARNESS_NO_GLOBAL: '1' })
    expect(loaded.globalPath).toBeUndefined()
    expect(loaded.teamPath).toBeUndefined()
    expect(loaded.localPath).toBeUndefined()
    expect(loaded.config.project.name).toBe('my-project')
  })
})

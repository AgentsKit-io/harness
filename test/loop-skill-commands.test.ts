import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const skill = readFileSync(join(process.cwd(), 'skills/ak-harness-loop/SKILL.md'), 'utf8')
const cli = readFileSync(join(process.cwd(), 'src/cli.ts'), 'utf8')

/** Every `ak-harness <group> <command>` the skill tells an agent to run. */
const citedCommands = (): readonly string[] => {
  const found = new Set<string>()
  for (const match of skill.matchAll(/ak-harness (loop(?: [a-z-]+){1,2})/g)) found.add(match[1]!)
  return [...found].sort()
}

/** Commander declarations, as `loop <name>` / `loop plan <name>` / `loop release <name>`. */
const declaredCommands = (): ReadonlySet<string> => {
  const declared = new Set<string>(['loop'])
  const groups: Record<string, string> = { loop: 'loop', loopPlan: 'loop plan', loopRelease: 'loop release' }
  for (const [variable, prefix] of Object.entries(groups)) {
    for (const match of cli.matchAll(new RegExp(`${variable}\\.command\\('([a-z-]+)`, 'g'))) declared.add(`${prefix} ${match[1]!}`)
  }
  return declared
}

describe('the loop skill only tells an agent about commands that exist', () => {
  it('finds every command it cites in the CLI', () => {
    const declared = declaredCommands()
    const missing = citedCommands().filter((command) => !declared.has(command) && !declared.has(command.split(' ').slice(0, 2).join(' ')))
    expect(missing, `the skill cites commands the CLI does not declare: ${missing.join(', ')}`).toEqual([])
  })

  it('tells the agent driving a plan that the answers are the human\'s', () => {
    // The whole point of the section: an agent that answers for the human invents the requirements.
    expect(skill).toContain('You never answer in the human\'s place')
    expect(skill).toContain('ak-harness loop plan start')
    expect(skill).toContain('ak-harness loop plan answer')
    expect(skill).toContain('ak-harness loop plan approve')
    expect(skill).toContain('ak-harness loop plan approve-design')
  })
})

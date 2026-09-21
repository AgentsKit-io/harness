/**
 * The numbers the site is allowed to claim, read from the repository itself.
 *
 * Every figure here has exactly one source in the code: the commander tree for the commands, the event
 * vocabulary for the events, the config schema for the settings, the files on disk for the ADRs and the tests.
 * Nothing is typed by hand, so a claim cannot drift from what shipped — the same contract the generated CLI,
 * events and configuration references already hold.
 *
 * The shape mirrors the sibling properties' `/api/stats.json` (`schemaVersion`, `property`, `counts`), so a
 * consumer that already reads agentskit.io's can read this one with the same code.
 *
 * `generatedAt` is deliberately absent: a timestamp would make every build produce a different file for the
 * same commit, which turns "the site changed" into noise.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** Commander counts a group and each of its subcommands: `loop` and `loop tick` are both invocable. */
const commandCount = (command) => 1 + command.commands.filter((child) => !child._hidden).reduce((total, child) => total + commandCount(child), 0)

/**
 * Every dotted path of the configuration, walked exactly as `gen-config-reference.mjs` walks it — including
 * the fields of an array's element type and of a record's value type, which are settings a user writes too.
 */
const configPathCount = (node) => {
  if (!node || typeof node !== 'object') return 0
  let total = 0
  for (const value of Object.values(node.properties ?? {})) {
    total += 1
    if (value.type === 'object' && value.properties) total += configPathCount(value)
    if (value.type === 'array' && value.items?.type === 'object' && value.items.properties) total += configPathCount(value.items)
    if (value.type === 'object' && value.additionalProperties?.type === 'object' && value.additionalProperties.properties) total += configPathCount(value.additionalProperties)
  }
  return total
}

/**
 * Counted from the files, never from a run: running the suite to learn how many tests there are would make the
 * documentation build depend on the test build, and would report a number nobody can check from the tree.
 */
const testFileCount = (directory) => readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => {
  if (entry.isDirectory()) return total + testFileCount(join(directory, entry.name))
  return total + (/\.test\.[cm]?tsx?$/.test(entry.name) ? 1 : 0)
}, 0)

export const computeStats = async ({ documents }) => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

  const { LOOP_EVENT_TYPES, LoopConfigSchema } = await import(join(root, 'dist/index.js'))
  // `src/cli.ts` exports the program and skips `parseAsync` under this flag — the same seam the CLI reference uses.
  process.env['AK_HARNESS_CLI_INTROSPECT'] = '1'
  const { cliProgram } = await import(join(root, 'dist/cli.js'))
  if (!cliProgram) throw new Error('dist/cli.js does not export cliProgram — run `pnpm build` first.')

  return {
    schemaVersion: 1,
    property: 'harness',
    version: manifest.version,
    license: manifest.license,
    counts: {
      cliCommands: cliProgram.commands.filter((command) => !command._hidden).reduce((total, command) => total + commandCount(command), 0),
      loopEvents: Object.keys(LOOP_EVENT_TYPES).length,
      configPaths: configPathCount(z.toJSONSchema(LoopConfigSchema, { io: 'input', unrepresentable: 'any' })),
      decisionRecords: readdirSync(join(root, 'docs')).filter((file) => /^ADR-\d+.*\.md$/.test(file)).length,
      testFiles: testFileCount(join(root, 'test')),
      docPages: documents,
    },
  }
}

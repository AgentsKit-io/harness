#!/usr/bin/env node
/**
 * Runs the three reference generators and writes the section's `meta.json`.
 *
 * `--check` is the drift gate: it regenerates nothing and fails when what is committed no longer matches the
 * code. A reference that can drift is a reference nobody can trust.
 */
import { spawnSync } from 'node:child_process'
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const check = process.argv.includes('--check')
const generators = ['gen-config-reference.mjs', 'gen-cli-reference.mjs', 'gen-events-reference.mjs']

const metaPath = join(root, 'apps/docs/content/docs/reference/meta.json')
const meta = `${JSON.stringify({ title: 'Reference', pages: ['configuration', 'cli', 'events'] }, null, 2)}\n`

const results = []
for (const generator of generators) {
  const result = spawnSync(process.execPath, [join(root, 'scripts', generator), ...(check ? ['--check'] : [])], { cwd: root, encoding: 'utf8' })
  process.stderr.write(result.stderr ?? '')
  if (result.status !== 0) {
    console.error(`${generator} failed.`)
    process.exit(result.status ?? 1)
  }
  results.push(JSON.parse((result.stdout ?? '').trim().split('\n').at(-1)))
}

if (check) {
  const current = existsSync(metaPath) ? readFileSync(metaPath, 'utf8') : ''
  if (current !== meta) { console.error(`Stale: ${metaPath}. Run "pnpm docs:generate".`); process.exit(1) }
} else {
  mkdirSync(dirname(metaPath), { recursive: true })
  writeFileSync(metaPath, meta)
}

console.log(JSON.stringify({ status: 'passed', criteria: ['docs-reference'], mode: check ? 'check' : 'write', results }))

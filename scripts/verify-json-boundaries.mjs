#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// `JSON.parse(readFileSync(...)) as SomeType` is a claim about a file on disk that nothing checked. Casting to
// `unknown` asserts nothing and is fine — the rule is about casts that name a type the caller then trusts.
// Everything else reads through `readJsonFile(path, schema)` (src/kernel/json-file.ts).
const CAST = /JSON\.parse\(\s*readFileSync\([^)]*\)[^)]*\)\s*as\s+(?!unknown\b)([A-Za-z_$][\w$]*)/g

// Sites that legitimately cast to a named type: the package's own metadata, and generic helpers whose callers
// validate. Each entry is a deliberate, reviewed exception — not a list to grow casually.
const ALLOW = new Set([
  'src/kernel/json-file.ts',        // the helper itself; the pattern appears in its own documentation
  'src/cli.ts',                     // its own package.json version, shipped in the same tarball
  'src/loop/model-catalog/index.ts', // readJson<T> helper; every caller validates the shape it asked for
  'src/adapters/doc-bridge.ts',     // IndexDocument is all-`unknown` fields: it asserts nothing
])

const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name)
  return statSync(path).isDirectory() ? walk(path) : path.endsWith('.ts') ? [path] : []
})

const failures = []
for (const path of walk('src')) {
  const rel = relative('.', path).split('\\').join('/')
  if (ALLOW.has(rel)) continue
  const text = readFileSync(path, 'utf8')
  for (const match of text.matchAll(CAST)) {
    const line = text.slice(0, match.index).split('\n').length
    failures.push(`${rel}:${line} casts a parsed file to \`${match[1]}\` — read it through readJsonFile(path, schema) instead`)
  }
}

console.log(JSON.stringify(failures.length ? { status: 'failed', criteria: ['json-boundaries'], failures } : { status: 'passed', criteria: ['json-boundaries'], allowed: [...ALLOW] }))
process.exitCode = failures.length ? 1 : 0

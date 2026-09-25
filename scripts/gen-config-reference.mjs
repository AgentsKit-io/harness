#!/usr/bin/env node
/**
 * The configuration reference, generated from the two sources that each hold half of it.
 *
 * `LoopConfigSchema` knows every path's type, default and enum; it declares **no** `.describe()` at all. The
 * JSDoc in `src/loop/config.ts` knows what those paths mean, and the compiler API is the only honest way to
 * read it. So this generator joins them on the dotted path.
 *
 * A schema path with no JSDoc is tolerated and counted — the count is the backlog. A JSDoc path with no schema
 * path is a **hard error**: it means the documentation describes a setting that does not exist, which is the
 * one failure mode a generated reference is supposed to make impossible.
 */
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { jsdocPathsOfSchema } from './lib/jsdoc-paths.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, 'apps/docs/content/docs/reference/configuration.mdx')

const { LoopConfigSchema } = await import(pathToFileURL(join(root, 'dist/index.js')).href)

const jsonSchema = z.toJSONSchema(LoopConfigSchema, { io: 'input', unrepresentable: 'any' })

const typeOf = (node) => {
  if (!node || typeof node !== 'object') return 'any'
  if (Array.isArray(node.enum)) return node.enum.map((value) => `\`${String(value)}\``).join(' · ')
  if (node.type === 'array') return `${typeOf(node.items)}[]`
  if (node.anyOf) return node.anyOf.map(typeOf).join(' | ')
  if (node.type === 'object' && node.additionalProperties && typeof node.additionalProperties === 'object') return `record<${typeOf(node.additionalProperties)}>`
  return node.type ?? 'any'
}

const defaultOf = (node) => node && 'default' in node ? `\`${JSON.stringify(node.default)}\`` : ''

const rows = []
const walk = (node, prefix, required) => {
  if (!node || typeof node !== 'object') return
  const properties = node.properties ?? {}
  for (const [key, value] of Object.entries(properties)) {
    const path = prefix ? `${prefix}.${key}` : key
    const isRequired = (required ?? []).includes(key)
    const leaf = value.type === 'object' && value.properties
    rows.push({ path, type: leaf ? 'object' : typeOf(value), default: defaultOf(value), required: isRequired })
    if (leaf) walk(value, path, value.required)
    // An array of objects documents its element fields under the array's own path, which is how the JSDoc
    // writes them too (`knownFailures.path`, `dod.items.id`).
    if (value.type === 'array' && value.items?.type === 'object' && value.items.properties) walk(value.items, path, value.items.required)
    if (value.type === 'object' && value.additionalProperties?.type === 'object' && value.additionalProperties.properties) walk(value.additionalProperties, path, value.additionalProperties.required)
  }
}
walk(jsonSchema, '', jsonSchema.required)

const docs = jsdocPathsOfSchema(join(root, 'src/loop/config.ts'), 'LoopConfigSchema')
const known = new Set(rows.map((row) => row.path))
const orphans = [...docs.keys()].filter((path) => !known.has(path)).sort()
if (orphans.length) {
  console.error(`Documented paths that do not exist in LoopConfigSchema:\n${orphans.map((path) => `  - ${path}`).join('\n')}`)
  process.exit(1)
}

// MDX reads `record<string>` as a JSX tag and fails the build; angle brackets only survive escaped.
const escapeMdx = (text) => String(text).replace(/</g, '&lt;').replace(/>/g, '&gt;')
const oneLine = (text) => escapeMdx(text.replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|')).trim()
const undocumented = rows.filter((row) => !docs.has(row.path))

const sections = new Map()
for (const row of rows) {
  const top = row.path.split('.')[0]
  if (!sections.has(top)) sections.set(top, [])
  sections.get(top).push(row)
}

const cell = (row) => row.default || (row.required ? '**required**' : '')

const body = [...sections.entries()].map(([section, sectionRows]) => {
  const children = sectionRows.filter((row) => row.path !== section)
  const head = [`## \`${section}\``, '', ...(docs.has(section) ? [oneLine(docs.get(section)), ''] : [])]
  // A top-level scalar (`schemaVersion`, `extends`) has no children: a table with a header and no rows would
  // say less than one line does.
  if (!children.length) {
    const own = sectionRows.find((row) => row.path === section)
    return [...head, own ? `Type: ${escapeMdx(own.type)}${own.default ? ` · Default: ${own.default}` : own.required ? ' · **required**' : ''}` : '', ''].join('\n')
  }
  return [
    ...head,
    '| Path | Type | Default | Description |',
    '|---|---|---|---|',
    ...children.map((row) => `| \`${row.path}\` | ${escapeMdx(row.type)} | ${cell(row)} | ${docs.has(row.path) ? oneLine(docs.get(row.path)) : ''} |`),
    '',
  ].join('\n')
}).join('\n')

const mdx = `---
title: Configuration
description: Every path of loop.config.yaml, its type, its default and what it decides. Generated from the schema and the source.
---

{/* Generated by \`pnpm docs:generate\`. Do not edit by hand: edit \`src/loop/config.ts\` and regenerate. */}

The four layers that produce this configuration — the machine's global file, the project's, the team's and this
machine's overlay — are described in [ADR-0033](https://github.com/AgentsKit-io/harness/blob/main/docs/ADR-0033-four-config-layers-and-presets.md).
\`ak-harness loop validate\` prints the effective result, which is the only one that decides anything.

${undocumented.length} of ${rows.length} paths carry no description yet.

${body}`

if (process.argv.includes('--check')) {
  const current = existsSync(target) ? readFileSync(target, 'utf8') : ''
  if (current !== mdx) {
    console.error(`Stale: ${target}. Run "pnpm docs:generate".`)
    process.exit(1)
  }
} else {
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, mdx)
}

console.log(JSON.stringify({ status: 'passed', criteria: ['config-reference'], paths: rows.length, documented: rows.length - undocumented.length, undocumented: undocumented.length }))

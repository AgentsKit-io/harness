#!/usr/bin/env node
/**
 * Machine-readable surfaces for the documentation site.
 *
 * Writes `apps/docs/public/`: the raw Markdown of every page, `llms.txt` (an index an agent can read in one
 * request), `llms-full.txt` (the whole corpus), `api/stats.json` (the counts the site is allowed to claim,
 * read from the repository) and the `CNAME` GitHub Pages needs for the custom domain.
 *
 * This is a fork of Doc Bridge's script with its `@agentskit/chat` half removed — no deterministic knowledge
 * artifact, no site-config. The only thing it reaches for beyond Node is the stats computation, which has to
 * read the built `dist/` and the config schema to count anything honestly.
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { computeStats } from './lib/stats.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const contentRoot = join(root, 'apps/docs/content/docs')
const publicRoot = join(root, 'apps/docs/public')
const ecosystemManifestPath = join(root, 'ecosystem.json')
const origin = 'https://harness.agentskit.io'
const currentProductId = 'harness'
const domain = origin.replace(/^https:\/\//, '')

const walk = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? walk(path) : [path]
  }))
  return files.flat().filter((path) => ['.mdx', '.md'].includes(extname(path))).sort()
}

const unix = (path) => path.split(sep).join('/')

const frontmatterOf = (markdown) => markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/u)?.[1] ?? ''
const fieldOf = (frontmatter, name) => frontmatter.match(new RegExp(`^${name}:\\s*(.+)$`, 'mu'))?.[1]?.trim().replace(/^['"]|['"]$/g, '')
const bodyOf = (markdown) => markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, '')

const titleOf = (markdown, fallback) => fieldOf(frontmatterOf(markdown), 'title') ?? bodyOf(markdown).match(/^#\s+(.+)$/m)?.[1]?.trim() ?? fallback

const descriptionOf = (markdown) => {
  const declared = fieldOf(frontmatterOf(markdown), 'description')
  if (declared) return declared.slice(0, 240)
  return bodyOf(markdown).split(/\n\s*\n/)
    .map((block) => block.replace(/^#+\s+.*$/gm, '').trim())
    .find((block) => block && !block.startsWith('```') && !block.startsWith('>') && !block.startsWith('<'))
    ?.replace(/\s+/g, ' ').slice(0, 240)
    ?? 'Documentation for @agentskit/harness.'
}

/** `index` is the section root, so it keeps the section's own URL rather than gaining an `/index/` segment. */
const urlOf = (slug) => slug === 'index' ? `${origin}/docs/` : `${origin}/docs/${slug.replace(/\/index$/, '')}/`

await rm(publicRoot, { recursive: true, force: true })
await mkdir(join(publicRoot, 'raw'), { recursive: true })

const files = await walk(contentRoot)
const documents = await Promise.all(files.map(async (path) => {
  const markdown = await readFile(path, 'utf8')
  const file = unix(relative(contentRoot, path))
  const slug = file.replace(/\.mdx?$/, '')
  return { file, slug, markdown, title: titleOf(markdown, slug), description: descriptionOf(markdown) }
}))

for (const doc of documents) {
  const target = join(publicRoot, 'raw', doc.file)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, doc.markdown)
}

/**
 * The ecosystem block, only when the manifest is in the repository.
 *
 * `ecosystem.json` is owned by the `agentskit` repository and copied here; until that copy lands, inventing the
 * sibling list would be a claim nobody could check.
 */
const ecosystemLines = await (async () => {
  if (!existsSync(ecosystemManifestPath)) return []
  const manifest = JSON.parse(await readFile(ecosystemManifestPath, 'utf8'))
  const products = [...(manifest.products ?? [])].sort((left, right) => (left.navigation?.order ?? 0) - (right.navigation?.order ?? 0))
  const lines = ['## AgentsKit ecosystem', '']
  for (const product of products) {
    const primary = product.surfaces?.docs ?? product.surfaces?.home
    if (!primary) continue
    const current = product.id === currentProductId ? ' **(current)**' : ''
    const promise = String(product.promise ?? '').trim()
    lines.push(`- [${product.name}](${primary})${current} — ${/[.!?]$/.test(promise) ? promise : `${promise}.`}`)
  }
  lines.push('')
  return lines
})()

const llms = [
  '# AgentsKit Harness',
  '',
  '> The keep-pushing loop for your SDLC: a vague objective interviewed into a PRD, issues contracted and',
  '> dispatched into their own worktrees, reviewed, proven against a definition of done, merged, and released',
  '> behind a human gate.',
  '',
  '## Start here',
  '',
  `- [Quickstart](${origin}/docs/get-started/quickstart/): from nothing to a first dispatched issue in four commands.`,
  `- [Stages](${origin}/docs/concepts/stages/): the state machines, and what each one decides.`,
  `- [For agents](${origin}/for-agents/): what an agent needs to operate the loop without guessing.`,
  '',
  '## Documentation',
  '',
  ...documents.map((doc) => `- [${doc.title}](${urlOf(doc.slug)}): ${doc.description}`),
  '',
  ...ecosystemLines,
  '## Machine surfaces',
  '',
  `- [Full corpus](${origin}/llms-full.txt)`,
  `- [Raw Markdown](${origin}/raw/)`,
  `- [Counts](${origin}/api/stats.json)`,
  '',
].join('\n')

const llmsFull = [llms, ...documents.flatMap((doc) => [`\n---\n\n# Source: ${doc.file}\n`, doc.markdown])].join('\n')

await writeFile(join(publicRoot, 'llms.txt'), llms)
await writeFile(join(publicRoot, 'llms-full.txt'), llmsFull)
await writeFile(join(publicRoot, 'CNAME'), `${domain}\n`)

// `output: 'export'` has no route handlers, so the stats surface is a real file under `public/`, written here
// rather than committed: `public/` is removed at the top of this script on every run.
const stats = await computeStats({ documents: documents.length })
await mkdir(join(publicRoot, 'api'), { recursive: true })
await writeFile(join(publicRoot, 'api/stats.json'), `${JSON.stringify(stats, null, 2)}\n`)

console.log(JSON.stringify({ status: 'passed', criteria: ['docs-artifacts'], documents: documents.length, ecosystem: ecosystemLines.length > 0, stats: stats.counts }))

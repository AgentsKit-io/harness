import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const publicRoot = resolve(root, 'apps/docs/public')
const contentRoot = resolve(root, 'apps/docs/content/docs')

const llms = readFileSync(resolve(publicRoot, 'llms.txt'), 'utf8')
const full = readFileSync(resolve(publicRoot, 'llms-full.txt'), 'utf8')

const pages = (directory = contentRoot, prefix = '') => readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory()
    ? pages(join(directory, entry.name), `${prefix}${entry.name}/`)
    : /\.mdx?$/.test(entry.name) ? [`${prefix}${entry.name}`] : [])

test('the concise index and the full corpus have distinct jobs', () => {
  // One request, one read: the index carries a line per page plus the ecosystem, and the whole corpus lives
  // in llms-full.txt. The ceiling is generous enough for the pages that exist and tight enough that
  // pasting the corpus in here would fail.
  assert.ok(llms.length < 16_000, `llms.txt should stay a concise index, received ${llms.length} bytes`)
  assert.ok(full.length > llms.length * 4, 'llms-full.txt must be the corpus, not a second index')
  assert.ok(full.length > llms.length)
  assert.ok(llms.startsWith('# AgentsKit Harness'))
})

test('every page of the site is in the corpus, byte for byte, and nothing else is', () => {
  const sources = [...full.matchAll(/^# Source: (.+)$/gmu)].map((match) => match[1])
  assert.deepEqual(sources.sort(), pages().sort())
  for (const file of sources) {
    const raw = readFileSync(resolve(publicRoot, 'raw', file), 'utf8')
    assert.equal(full.split(`# Source: ${file}\n`).length, 2, `${file} appears more than once`)
    // A corpus that paraphrases its own source is worse than no corpus: an agent reading it would answer
    // confidently from something the site never said.
    assert.ok(full.includes(`# Source: ${file}\n\n${raw}`), `${file} must be preserved byte for byte`)
  }
})

test('every documented page is linked from the index, on the product domain', () => {
  for (const file of pages()) {
    const raw = readFileSync(resolve(publicRoot, 'raw', file), 'utf8')
    const title = raw.match(/^title:\s*(.+)$/mu)?.[1]?.trim().replace(/^['"]|['"]$/g, '')
    assert.ok(title, `${file} has no title in its frontmatter`)
    assert.ok(llms.includes(`[${title}](https://harness.agentskit.io/docs/`), `llms.txt does not link "${title}"`)
  }
  assert.ok(!llms.includes('http://'), 'every link is https')
  assert.ok(!/\]\(\/(?!\/)/.test(llms), 'llms.txt carries absolute URLs only — a relative one is unusable off-site')
})

test('the custom domain is declared for GitHub Pages', () => {
  assert.ok(existsSync(resolve(publicRoot, 'CNAME')))
  assert.equal(readFileSync(resolve(publicRoot, 'CNAME'), 'utf8'), 'harness.agentskit.io\n')
})

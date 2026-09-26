import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const file = resolve('doc-bridge.config.json')
// The six products shown by shell v1 (bar, tour, footer); README.md must link each one.
const ECOSYSTEM_URLS = ['https://www.agentskit.io', 'https://registry.agentskit.io', 'https://chat.agentskit.io', 'https://doc-bridge.agentskit.io', 'https://code-review.agentskit.io', 'https://harness.agentskit.io']
const config = {
  schemaVersion: 1,
  project: { name: 'AgentsKit Harness' },
  corpus: {
    agent: { root: 'apps/docs/content/docs', index: 'apps/docs/content/docs/index.mdx', include: ['**/*.md', '**/*.mdx'], exclude: ['**/node_modules/**'] },
    human: [
      { plugin: 'fumadocs', options: { contentDir: 'apps/docs/content/docs', urlPrefix: '/docs' } },
      { plugin: 'plain-markdown', options: { root: '.', include: ['README.md'], urlPrefix: '/docs' } },
    ],
  },
  routing: { options: { ownership: {
    'harness-site': { path: 'apps/docs', purpose: 'Public Fumadocs product site and its curated documentation.', agentDoc: 'apps/docs/content/docs/index.mdx', humanDoc: 'https://harness.agentskit.io/docs', checks: ['pnpm docs:build'] },
    'ecosystem-manifest': { path: 'ecosystem.json', purpose: 'Shared product metadata and public ecosystem references.', agentDoc: 'apps/docs/content/docs/index.mdx', humanDoc: 'https://harness.agentskit.io/docs', checks: ['node scripts/verify-ecosystem-public-outputs.mjs'] },
  }, intents: [{ id: 'understand-harness', title: 'Understand AgentsKit Harness', paths: ['apps/docs/content/docs/index.mdx'] }], changes: [{ id: 'change-harness-docs', title: 'Change public Harness documentation', startHere: 'apps/docs/content/docs/index.mdx' }] } },
  index: { outFile: '.doc-bridge/index.json', llmsTxt: { enabled: true, outFile: '.doc-bridge/llms.txt', preamble: 'AgentsKit Harness is the configurable, open-source SDLC loop for issue-to-release work. Public product documentation lives on the Fumadocs site at https://harness.agentskit.io/docs.' } },
  conformance: { documentationStandardV1: { rawSources: ['README.md', 'apps/docs/content/docs/index.mdx'], contributionPaths: ['CONTRIBUTING.md'], links: ECOSYSTEM_URLS.map(url => ({ url, paths: ['README.md'] })), ecosystemContract: { manifest: 'ecosystem.json', claims: 'ecosystem-claims.json', productId: 'harness' }, metadata: [{ path: 'apps/docs/app/layout.tsx', contains: ['export const metadata', 'title:', 'description:', 'openGraph:'] }], quickstarts: [{ id: 'first-loop', doc: 'apps/docs/content/docs/examples/first-loop.mdx', test: 'test/loop-presets-init.test.ts', command: 'pnpm test', testContains: ["describe('loop init'"] }], visuals: ['apps/docs/app/icon.svg'], diagrams: [{ path: 'docs/PRD-0.4.0.md', contains: ['```mermaid'] }], exceptions: [] } },
  gates: { preset: 'standard', include: ['documentation-standard-v1'] },
  surfaces: { cli: { bin: 'ak-docs', defaultFormat: 'text' }, mcp: { enabled: true, transport: 'stdio' } },
}
const next = `${JSON.stringify(config, null, 2)}\n`
if (process.argv.includes('--check')) {
  if (readFileSync(file, 'utf8') !== next) { console.error('doc-bridge.config.json is stale; run pnpm docs:bridge:config'); process.exit(1) }
} else writeFileSync(file, next)
console.log(JSON.stringify({ status: 'passed', criteria: ['ecosystem-standardization'], file: 'doc-bridge.config.json' }))

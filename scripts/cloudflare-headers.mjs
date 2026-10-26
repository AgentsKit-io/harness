#!/usr/bin/env node
// Writes Cloudflare `_headers` into the static export of the docs site (`pnpm docs:build`), so the
// Cloudflare deploy (cf:deploy) serves the security headers from cloudflare-headers.config.mjs.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { outputDirectory, rules } from './cloudflare-headers.config.mjs'

const blocks = rules.map(({ pattern, headers }) =>
  [pattern, ...headers.map(({ key, value }) => `  ${key}: ${value}`)].join('\n'))
writeFileSync(join(outputDirectory, '_headers'), `${blocks.join('\n\n')}\n`)
console.log(`wrote ${join(outputDirectory, '_headers')} (${blocks.length} rule${blocks.length === 1 ? '' : 's'})`)

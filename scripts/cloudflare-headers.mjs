#!/usr/bin/env node
// Writes Cloudflare `_headers` into the static export served by wrangler.toml. Runs only for the
// Cloudflare deploy (cf:deploy); the security headers below are the single source for the docs site.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const out = 'apps/docs/out'
// HSTS is sent on every response; the custom domain is HTTPS-only.
const rules = [
  {
    pattern: '/*',
    headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Strict-Transport-Security', value: 'max-age=63072000' },
    ],
  },
]
const blocks = rules.map(({ pattern, headers }) =>
  [pattern, ...headers.map(({ key, value }) => `  ${key}: ${value}`)].join('\n'))
writeFileSync(join(out, '_headers'), `${blocks.join('\n\n')}\n`)
console.log(`wrote ${join(out, '_headers')} (${blocks.length} rule${blocks.length === 1 ? '' : 's'})`)

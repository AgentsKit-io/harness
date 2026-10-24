#!/usr/bin/env node
// Writes Cloudflare `_headers` into the static export so the site serves the security headers below.
// Runs only for the Cloudflare deploy (cf:deploy), after the docs build.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const out = 'apps/docs/out'
const rules = [
  {
    source: '/(.*)',
    headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    ],
  },
]
const toPattern = (source) => (source === '/(.*)' ? '/*' : source.replace(/\(\.\*\)/g, '*'))
// HSTS on every response; the custom domain is HTTPS-only.
const HSTS = { key: 'Strict-Transport-Security', value: 'max-age=63072000' }
const blocks = rules.map(({ source, headers }) =>
  [toPattern(source), ...[...headers, ...(source === '/(.*)' ? [HSTS] : [])].map(({ key, value }) => `  ${key}: ${value}`)].join('\n'))
writeFileSync(join(out, '_headers'), `${blocks.join('\n\n')}\n`)
console.log(`wrote ${join(out, '_headers')} (${blocks.length} rule${blocks.length === 1 ? '' : 's'})`)

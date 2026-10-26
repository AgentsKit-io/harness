// The docs site's deploy contract on Cloudflare: where `pnpm docs:build` writes the static export and
// the security headers served on every path. Read by cloudflare-headers.mjs and its contract test.
export const buildCommand = 'pnpm docs:build'
export const outputDirectory = 'apps/docs/out'
export const rules = [
  {
    pattern: '/*',
    headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      // HSTS on every response; the custom domain is HTTPS-only.
      { key: 'Strict-Transport-Security', value: 'max-age=63072000' },
    ],
  },
]

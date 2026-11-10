#!/usr/bin/env node
// Runs in the publish job before `npm publish`. npm Trusted Publishing swaps the GitHub OIDC token for a
// short-lived publish token; when npmjs.com has no matching trusted publisher, the swap fails silently and the PUT
// comes back as an opaque E404 (every publish since 0.22.3 did that). This performs the same exchange first and,
// when npm refuses it, prints npm's reason and the exact values to register on npmjs.com. The token npm returns is
// never printed or stored.
import { pathToFileURL } from 'node:url'

export const NPM_AUDIENCE = 'npm:registry.npmjs.org'

/** Decodes the (unverified) payload of a JWT; only used to show which claims npm compared. */
export function decodeClaims(jwt) {
  const payload = String(jwt ?? '').split('.')[1]
  if (!payload) return {}
  try {
    return JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
  } catch {
    return {}
  }
}

/** The npm trusted-publisher settings that match these GitHub OIDC claims. */
export function expectedPublisher(claims) {
  const workflowRef = String(claims.workflow_ref ?? '')
  const workflowPath = workflowRef.split('@')[0]
  const repository = String(claims.repository ?? '')
  const [owner = '', repo = ''] = repository.split('/')
  const file = workflowPath.split('/.github/workflows/')[1] ?? ''
  return { provider: 'GitHub Actions', organizationOrUser: owner, repository: repo, workflowFilename: file, environment: claims.environment ?? '' }
}

/** Turns the exchange response into a pass/fail verdict with a readable message (never the token). */
export function diagnose({ pkg, status, body, claims }) {
  if (status >= 200 && status < 300) return { ok: true, message: `npm Trusted Publishing accepted this workflow for ${pkg}` }
  const publisher = expectedPublisher(claims ?? {})
  const reason = typeof body === 'object' && body ? (body.message ?? body.error ?? JSON.stringify(body)) : String(body ?? '').slice(0, 500)
  const lines = [
    `npm refused the Trusted Publishing exchange for ${pkg} (HTTP ${status}): ${reason || 'no reason given'}`,
    'npm publish would fail with E404. On npmjs.com, package settings > Trusted Publisher, register:',
    `  provider: ${publisher.provider}`,
    `  organization or user: ${publisher.organizationOrUser}`,
    `  repository: ${publisher.repository}`,
    `  workflow filename: ${publisher.workflowFilename}`,
    `  environment: ${publisher.environment || '(leave empty)'}`,
  ]
  return { ok: false, message: lines.join('\n') }
}

async function main(pkg) {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  if (!url || !requestToken) {
    console.error('No GitHub OIDC token available: the publish job needs `permissions: id-token: write`.')
    return 1
  }
  const idResponse = await fetch(`${url}&audience=${encodeURIComponent(NPM_AUDIENCE)}`, { headers: { Authorization: `Bearer ${requestToken}` } })
  if (!idResponse.ok) {
    console.error(`GitHub refused the OIDC token request (HTTP ${idResponse.status}).`)
    return 1
  }
  const idToken = (await idResponse.json()).value
  const exchange = await fetch(`https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/${encodeURIComponent(pkg)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}` },
  })
  const text = await exchange.text()
  let body = text
  try {
    body = JSON.parse(text)
  } catch {}
  const verdict = diagnose({ pkg, status: exchange.status, body: exchange.ok ? null : body, claims: decodeClaims(idToken) })
  ;(verdict.ok ? console.log : console.error)(verdict.message)
  return verdict.ok ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv[2] ?? '@agentskit/harness')
}

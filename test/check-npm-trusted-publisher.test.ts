import { describe, expect, it } from 'vitest'
// @ts-expect-error plain ESM script without type declarations
import { decodeClaims, diagnose, expectedPublisher } from '../scripts/check-npm-trusted-publisher.mjs'

const claims = {
  repository: 'AgentsKit-io/harness',
  workflow_ref: 'AgentsKit-io/harness/.github/workflows/release-harness.yml@refs/heads/main',
}
const jwt = (payload: object) => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`

describe('check-npm-trusted-publisher', () => {
  it('decodes the claims of a base64url JWT and tolerates garbage', () => {
    expect(decodeClaims(jwt(claims))).toEqual(claims)
    expect(decodeClaims('not-a-jwt')).toEqual({})
    expect(decodeClaims('a.%%%.b')).toEqual({})
  })

  it('derives the npm trusted-publisher settings from the workflow claims', () => {
    expect(expectedPublisher(claims)).toEqual({
      provider: 'GitHub Actions',
      organizationOrUser: 'AgentsKit-io',
      repository: 'harness',
      workflowFilename: 'release-harness.yml',
      environment: '',
    })
  })

  it('passes when npm accepts the exchange', () => {
    expect(diagnose({ pkg: '@agentskit/harness', status: 201, body: null, claims }).ok).toBe(true)
  })

  it('fails with npm reason and the values to register when npm refuses', () => {
    const verdict = diagnose({
      pkg: '@agentskit/harness',
      status: 404,
      body: { message: 'No trusted publisher configured' },
      claims,
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.message).toContain('HTTP 404): No trusted publisher configured')
    expect(verdict.message).toContain('workflow filename: release-harness.yml')
    expect(verdict.message).toContain('organization or user: AgentsKit-io')
    expect(verdict.message).toContain('environment: (leave empty)')
    expect(diagnose({ pkg: 'p', status: 401, body: 'plain text', claims: {} }).message).toContain('plain text')
  })
})

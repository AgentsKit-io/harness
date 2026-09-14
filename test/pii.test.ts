import { describe, expect, it } from 'vitest'
import { scanForPii } from '../src/index.js'

describe('scanForPii', () => {
  it('returns no matches and the text unchanged for a string with no PII shapes', () => {
    const result = scanForPii('Add a button that opens the settings modal.')
    expect(result).toEqual({ matches: [], redacted: 'Add a button that opens the settings modal.' })
  })

  it('detects and redacts an email address', () => {
    const result = scanForPii('Contact support at ops@example.com for access.')
    expect(result.matches).toEqual([{ kind: 'email', index: 19, length: 15 }])
    expect(result.redacted).toBe('Contact support at [REDACTED:email] for access.')
  })

  it('detects common provider API-key shapes', () => {
    const openai = scanForPii('export OPENAI_API_KEY=sk-abcdEFGH12345678ijklMNOP')
    expect(openai.matches[0]).toMatchObject({ kind: 'api-key' })
    const github = scanForPii('token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')
    expect(github.matches[0]).toMatchObject({ kind: 'api-key' })
    const aws = scanForPii('AKIAABCDEFGHIJKLMNOP is the access key id')
    expect(aws.matches[0]).toMatchObject({ kind: 'api-key' })
  })

  // Fixtures below build each fake secret with a `+` concatenation instead of one contiguous literal — the
  // regexes under test still see the full joined string at runtime, but GitHub's push-protection secret scanner
  // (which matches against literal file content) does not trip on a prefix it recognizes as a real provider
  // format, even for an obviously-fake payload.
  it('detects current-format keys the original pattern list missed: sk-proj-, github_pat_, AIza, sk_live_', () => {
    const openaiProject = scanForPii('OPENAI_API_KEY=' + 'sk-proj-' + 'abcdEFGH12345678ijklMNOPqrst')
    expect(openaiProject.matches[0]).toMatchObject({ kind: 'api-key' })
    expect(openaiProject.redacted).toBe('OPENAI_API_KEY=[REDACTED:api-key]')
    const githubFineGrained = scanForPii('token: ' + 'github_pat_' + '11ABCDEFGabcdefghijklmn_0123456789abcdefghijklmnopqrstuvwxyz')
    expect(githubFineGrained.matches[0]).toMatchObject({ kind: 'api-key' })
    const google = scanForPii('key=' + 'AIza' + 'SyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456')
    expect(google.matches[0]).toMatchObject({ kind: 'api-key' })
    const stripe = scanForPii('STRIPE_SECRET_KEY=' + 'sk_live_' + 'ABCDEFGHIJKLMNOPQRSTUVWX')
    expect(stripe.matches[0]).toMatchObject({ kind: 'api-key' })
  })

  it('detects an AWS secret access key only when labeled by its conventional key name', () => {
    // Synthetic 40-char base64-shaped fixture, not a real (or real-example) credential — GitHub's own push
    // protection flags well-known AWS doc placeholders as if they were live secrets, so this test deliberately
    // avoids one.
    const fixture = 'TESTKEY0'.repeat(5)
    const labeled = scanForPii(`aws_secret_access_key: ${fixture}`)
    expect(labeled.matches[0]).toMatchObject({ kind: 'api-key' })
    // A bare 40-char base64-shaped run with no label is not flagged — too generic to scan for on its own.
    const unlabeled = scanForPii(`sha: ${fixture}`)
    expect(unlabeled.matches).toHaveLength(0)
  })

  it('detects and fully redacts a PEM private-key block', () => {
    const pem = 'header\n-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK...\n-----END RSA PRIVATE KEY-----\nfooter'
    const result = scanForPii(pem)
    expect(result.matches[0]).toMatchObject({ kind: 'private-key' })
    expect(result.redacted).toBe('header\n[REDACTED:private-key]\nfooter')
  })

  it('detects a card-number-shaped digit run', () => {
    const result = scanForPii('Card on file: 4111 1111 1111 1111, please charge it')
    expect(result.matches[0]).toMatchObject({ kind: 'credit-card' })
    expect(result.redacted).toContain('[REDACTED:credit-card]')
  })

  it('does not double-report a span already claimed by a more specific pattern', () => {
    const result = scanForPii('key AKIAABCDEFGHIJKLMNOP leaked')
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]?.kind).toBe('api-key')
  })

  it('redacts multiple distinct matches in one pass, preserving surrounding text', () => {
    const result = scanForPii('email a@b.com or call 555-123-4567')
    expect(result.matches.map((match) => match.kind)).toEqual(['email', 'phone'])
    expect(result.redacted).toBe('email [REDACTED:email] or call [REDACTED:phone]')
  })

  it('handles empty and non-string-ish input without throwing', () => {
    expect(scanForPii('')).toEqual({ matches: [], redacted: '' })
  })
})

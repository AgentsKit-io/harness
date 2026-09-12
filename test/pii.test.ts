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

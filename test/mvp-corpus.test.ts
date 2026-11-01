import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loadMvp, mvpDigest, mvpLaunches, parseMvpYaml, validateMvp } from '../src/mvp.js'

// Synthetic corpus: one fixture per format feature, digests computed independently (Python json.dumps + sha256).
const dir = new URL('../docs/fixtures/mvp/corpus/', import.meta.url)
interface Expect { digest?: string; launches?: string[]; throws?: string; errors?: string[] }
const expected = JSON.parse(readFileSync(new URL('expected.json', dir), 'utf8')) as Record<string, Expect>

describe('mvp corpus parity', () => {
  it('every fixture has an expectation and vice versa', () => {
    expect(readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort()).toEqual(Object.keys(expected).sort())
  })
  for (const [file, want] of Object.entries(expected)) {
    it(file, () => {
      const text = readFileSync(new URL(file, dir), 'utf8')
      if (want.throws) return void expect(() => loadMvp(text)).toThrow(want.throws)
      if (want.errors) return void expect(validateMvp(parseMvpYaml(text))).toEqual(want.errors)
      const doc = loadMvp(text)
      expect(mvpDigest(doc)).toBe(want.digest)
      if (want.launches) expect(mvpLaunches(doc).map((l) => l.date)).toEqual(want.launches)
    })
  }
})

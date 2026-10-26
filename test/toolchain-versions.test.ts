import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

// Vitest and its @vitest/* companions ship in lockstep; a coverage provider on another major breaks the run.
it('keeps @vitest/coverage-v8 on the same major as vitest', () => {
  const { devDependencies } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    devDependencies: Record<string, string>
  }
  const major = (range: string | undefined) => range?.replace(/^[^\d]*/, '').split('.')[0]
  expect(major(devDependencies['@vitest/coverage-v8'])).toBe(major(devDependencies['vitest']))
})

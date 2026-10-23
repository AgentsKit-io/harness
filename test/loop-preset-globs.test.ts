import { describe, expect, it } from 'vitest'
import { LOOP_PRESETS, PRESET_NAMES, touchesProtectedPaths } from '../src/index.js'

describe('preset default globs', () => {
  const globs = PRESET_NAMES.flatMap((name) => ((LOOP_PRESETS[name]['dod'] as { items?: { glob?: string }[] } | undefined)?.items ?? []).flatMap((item) => item.glob ? [item.glob] : []))

  it('test-for-new-code matches test and spec files at any depth, and only those', () => {
    const glob = '**/*.{test,spec}.*'
    expect(globs).toContain(glob)
    expect(touchesProtectedPaths(['a.test.ts', 'src/a.spec.tsx', 'packages/x/test/b.test.js', 'src/a.ts', 'src/test.ts', 'src/a.tests.ts'], [glob])).toEqual(['a.test.ts', 'src/a.spec.tsx', 'packages/x/test/b.test.js'])
  })

  it('every brace glob in every preset matches a file its alternatives name', () => {
    for (const glob of globs.filter((entry) => entry.includes('{'))) expect(touchesProtectedPaths(['src/a.test.ts'], [glob])).toEqual(['src/a.test.ts'])
  })
})

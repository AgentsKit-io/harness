import { describe, expect, it } from 'vitest'
import { planFilePreflight, validateSafeCommand } from '../src/index.js'

describe('planFilePreflight validation', () => {
  it('rejects a non-array files list', () => {
    expect(() => planFilePreflight('nope' as never)).toThrow(/files must be an array/)
  })

  it('rejects a blank file path', () => {
    expect(() => planFilePreflight([{ path: '  ' }])).toThrow(/files\[0\].path/)
  })

  it('rejects an absolute path or a path with a directory-traversal segment', () => {
    expect(() => planFilePreflight([{ path: '/etc/passwd' }])).toThrow(/repository-relative/)
    expect(() => planFilePreflight([{ path: 'src/../../etc/passwd' }])).toThrow(/repository-relative/)
  })

  it('rejects a blank testRoots entry', () => {
    expect(() => planFilePreflight([{ path: 'src/a.ts' }], { testRoots: ['  '] })).toThrow(/testRoots\[0\]/)
  })

  it('normalizes backslashes and deduplicates/sorts file paths', () => {
    const plan = planFilePreflight([{ path: 'src\\b.ts' }, { path: 'src/a.ts' }, { path: 'src/a.ts' }])
    expect(plan.files).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('treats an empty file list as not docs-only and requires no checks beyond lint/typecheck', () => {
    const plan = planFilePreflight([])
    expect(plan).toMatchObject({ docsOnly: false, checks: ['lint', 'typecheck'] })
  })

  it('does not skip a mix of docs and existing test files', () => {
    const plan = planFilePreflight([{ path: 'README.md' }, { path: 'src/a.test.ts' }])
    expect(plan.docsOnly).toBe(false)
  })

  it('matches files under a configured test root even without a code counterpart', () => {
    const plan = planFilePreflight([{ path: 'e2e/smoke.ts' }], { testRoots: ['e2e'] })
    expect(plan.testFiles).toEqual(['e2e/smoke.ts'])
    expect(plan.checks).toContain('test')
  })

  it('does not match a path that merely starts with the root name as a prefix', () => {
    const plan = planFilePreflight([{ path: 'testing/helper.ts' }], { testRoots: ['test'] })
    expect(plan.testFiles).toEqual([])
  })

  it('setting includeTests to false does not affect a test file already present in the changeset (colocated tests are always a subset of existingTests)', () => {
    const plan = planFilePreflight([{ path: 'src/a.ts' }, { path: 'src/a.test.ts' }], { includeTests: false })
    expect(plan.testFiles).toEqual(['src/a.test.ts'])
    expect(plan.checks).toEqual(['lint', 'typecheck', 'test'])
  })

  it('requires no test check when code files have no associated tests', () => {
    const plan = planFilePreflight([{ path: 'src/a.ts' }])
    expect(plan.checks).toEqual(['lint', 'typecheck'])
  })

  it('recognizes a .spec.ts colocated test', () => {
    const plan = planFilePreflight([{ path: 'src/a.ts' }, { path: 'src/a.spec.ts' }])
    expect(plan.testFiles).toEqual(['src/a.spec.ts'])
  })
})

describe('validateSafeCommand', () => {
  it('rejects a blank command', () => {
    expect(() => validateSafeCommand('  ')).toThrow(/non-empty string/)
    expect(() => validateSafeCommand(undefined as never)).toThrow(/non-empty string/)
  })
})

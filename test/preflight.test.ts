import { describe, expect, it } from 'vitest'
import { planFilePreflight, validateSafeCommand } from '../src/index.js'

describe('file preflight', () => {
  it('skips docs-only changes and selects colocated tests', () => {
    expect(planFilePreflight([{ path: 'README.md' }]).docsOnly).toBe(true)
    const plan = planFilePreflight([{ path: 'src/a.ts' }, { path: 'src/a.test.ts' }])
    expect(plan.testFiles).toEqual(['src/a.test.ts'])
    expect(plan.checks).toEqual(['lint', 'typecheck', 'test'])
  })

  it('rejects shell composition in dispatch commands', () => {
    expect(validateSafeCommand('orca worktree create --name block-1').valid).toBe(true)
    expect(() => validateSafeCommand('orca worktree create && rm -rf .')).toThrow(/shell metacharacters/)
  })
})

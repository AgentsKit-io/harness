import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sha256 } from '../src/kernel/hash.js'
import { parseStructuredEvidence, validateEvidence } from '../src/execution/evidence.js'
import type { StructuredEvidence, VerificationCheck } from '../src/kernel/types.js'

const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const tempRoot = (): string => { const dir = mkdtempSync(join(tmpdir(), 'agentskit-evidence-')); cleanups.push(dir); return dir }

const check = (category: VerificationCheck['category'] = 'logic'): VerificationCheck => ({ id: 'c1', category, command: 'true', required: true, timeoutMs: 1000, evidence: 'structured' })

describe('parseStructuredEvidence', () => {
  it('picks the last JSON-shaped line with a string status, ignoring surrounding noise', () => {
    const stdout = 'starting up\n{"not":"evidence"}\n{"status":"passed","criteria":["a"]}\ntrailing text'
    expect(parseStructuredEvidence(stdout)).toEqual({ status: 'passed', criteria: ['a'] })
  })

  it('returns null when no line parses as a valid evidence object', () => {
    expect(parseStructuredEvidence('just plain text\nand more')).toBeNull()
    expect(parseStructuredEvidence('{"no-status-field": true}')).toBeNull()
    expect(parseStructuredEvidence('')).toBeNull()
  })
})

describe('validateEvidence', () => {
  it('fails when evidence is missing or did not pass', () => {
    expect(validateEvidence('/root', check(), null, [])).toEqual(['structured evidence did not pass'])
    expect(validateEvidence('/root', check(), { status: 'failed' } as StructuredEvidence, [])).toEqual(['structured evidence did not pass'])
  })

  it('fails when criteria is missing, malformed, or does not cover every outcome id', () => {
    expect(validateEvidence('/root', check(), { status: 'passed' } as StructuredEvidence, ['o1'])[0]).toContain('evidence must map criteria: o1')
    expect(validateEvidence('/root', check(), { status: 'passed', criteria: [1] } as never, ['o1'])[0]).toContain('evidence must map criteria')
    expect(validateEvidence('/root', check(), { status: 'passed', criteria: ['o2'] } as StructuredEvidence, ['o1'])[0]).toContain('evidence must map criteria: o1')
  })

  it('passes a minimal non-UI evidence object with matching criteria and no artifacts', () => {
    expect(validateEvidence('/root', check(), { status: 'passed', criteria: ['o1'] } as StructuredEvidence, ['o1'])).toEqual([])
  })

  it('requires UI evidence to declare the real-browser capability and at least one artifact', () => {
    const uiCheck = check('ui')
    expect(validateEvidence('/root', uiCheck, { status: 'passed', criteria: [] } as unknown as StructuredEvidence, [])).toEqual(expect.arrayContaining(['UI evidence must declare capability real-browser', 'UI evidence requires screenshot artifacts']))
    expect(validateEvidence('/root', uiCheck, { status: 'passed', criteria: [], capability: 'real-browser', artifacts: [] } as unknown as StructuredEvidence, [])).toContain('UI evidence requires screenshot artifacts')
  })

  it('rejects an artifact missing a string path/sha256', () => {
    const evidence = { status: 'passed', criteria: [], artifacts: [{ path: 'x' }] } as unknown as StructuredEvidence
    expect(validateEvidence('/root', check(), evidence, [])).toEqual(['artifact requires string path and sha256'])
  })

  it('rejects an artifact path that escapes the project root', () => {
    const evidence = { status: 'passed', criteria: [], artifacts: [{ path: '../outside.txt', sha256: 'x' }] } as unknown as StructuredEvidence
    const failures = validateEvidence('/root', check(), evidence, [])
    expect(failures[0]).toContain('artifact path escapes project root')
  })

  it('rejects a missing file or a sha256 mismatch, and accepts a verified real artifact', () => {
    const root = tempRoot()
    writeFileSync(join(root, 'out.txt'), 'hello')
    const realHash = sha256(Buffer.from('hello'))
    const missing = { status: 'passed', criteria: [], artifacts: [{ path: 'missing.txt', sha256: 'x' }] } as unknown as StructuredEvidence
    expect(validateEvidence(root, check(), missing, [])[0]).toContain('artifact hash mismatch: missing.txt')
    const wrongHash = { status: 'passed', criteria: [], artifacts: [{ path: 'out.txt', sha256: 'wrong' }] } as unknown as StructuredEvidence
    expect(validateEvidence(root, check(), wrongHash, [])[0]).toContain('artifact hash mismatch: out.txt')
    const good = { status: 'passed', criteria: [], artifacts: [{ path: 'out.txt', sha256: realHash }] } as unknown as StructuredEvidence
    expect(validateEvidence(root, check(), good, [])).toEqual([])
  })

  it('requires a UI artifact to be type=screenshot with a valid viewport (string label or positive width/height)', () => {
    const root = tempRoot()
    mkdirSync(join(root, 'shots'), { recursive: true })
    writeFileSync(join(root, 'shots', 'a.png'), 'img')
    const hash = sha256(Buffer.from('img'))
    const uiCheck = check('ui')
    const wrongType = { status: 'passed', criteria: [], capability: 'real-browser', artifacts: [{ path: 'shots/a.png', sha256: hash, type: 'log', viewport: 'desktop' }] } as unknown as StructuredEvidence
    expect(validateEvidence(root, uiCheck, wrongType, [])[0]).toContain('UI artifact requires type=screenshot and viewport')
    const badViewport = { status: 'passed', criteria: [], capability: 'real-browser', artifacts: [{ path: 'shots/a.png', sha256: hash, type: 'screenshot', viewport: { width: 0, height: 10 } }] } as unknown as StructuredEvidence
    expect(validateEvidence(root, uiCheck, badViewport, [])[0]).toContain('UI artifact requires type=screenshot and viewport')
    const okStringViewport = { status: 'passed', criteria: [], capability: 'real-browser', artifacts: [{ path: 'shots/a.png', sha256: hash, type: 'screenshot', viewport: 'desktop' }] } as unknown as StructuredEvidence
    expect(validateEvidence(root, uiCheck, okStringViewport, [])).toEqual([])
    const okObjectViewport = { status: 'passed', criteria: [], capability: 'real-browser', artifacts: [{ path: 'shots/a.png', sha256: hash, type: 'screenshot', viewport: { width: 800, height: 600 } }] } as unknown as StructuredEvidence
    expect(validateEvidence(root, uiCheck, okObjectViewport, [])).toEqual([])
  })
})

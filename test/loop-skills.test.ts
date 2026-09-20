import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadPinnedSkills, renderPinnedSkills, renderSkillsForHandoff, skillDigest, skillRefs } from '../src/index.js'

const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const tempRoot = (): string => { const dir = mkdtempSync(join(tmpdir(), 'agentskit-skills-')); cleanups.push(dir); return dir }

describe('loadPinnedSkills', () => {
  it('reads, digests and returns each configured file untruncated when under the cap', () => {
    const root = tempRoot()
    writeFileSync(join(root, 'AGENTS.md'), '# Conventions\nUse named exports.', 'utf8')
    const skills = loadPinnedSkills(root, ['AGENTS.md'], 6_000)
    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({ path: 'AGENTS.md', content: '# Conventions\nUse named exports.', truncated: false })
    expect(skills[0]?.digest).toBe(skillDigest('# Conventions\nUse named exports.'))
  })

  it('reads a nested path relative to root', () => {
    const root = tempRoot()
    mkdirSync(join(root, 'docs', 'for-agents'), { recursive: true })
    writeFileSync(join(root, 'docs', 'for-agents', 'INDEX.md'), 'index content', 'utf8')
    const skills = loadPinnedSkills(root, ['docs/for-agents/INDEX.md'], 6_000)
    expect(skills[0]).toMatchObject({ path: 'docs/for-agents/INDEX.md', content: 'index content' })
  })

  it('truncates a file over maxChars with a visible note, and digests the truncated content', () => {
    const root = tempRoot()
    const raw = 'x'.repeat(100)
    writeFileSync(join(root, 'BIG.md'), raw, 'utf8')
    const skills = loadPinnedSkills(root, ['BIG.md'], 10)
    expect(skills[0]?.truncated).toBe(true)
    expect(skills[0]?.content).toMatch(/^x{10}\n…\[truncated 90 chars\]$/)
    expect(skills[0]?.digest).toBe(skillDigest(skills[0]!.content))
  })

  it('fails closed when a configured skill file is missing', () => {
    const root = tempRoot()
    expect(() => loadPinnedSkills(root, ['MISSING.md'], 6_000)).toThrow(/MISSING\.md/)
  })

  it('returns an empty list for an empty config without touching the filesystem', () => {
    const root = tempRoot()
    expect(loadPinnedSkills(root, [], 6_000)).toEqual([])
  })
})

describe('renderPinnedSkills', () => {
  it('renders each skill with a truncated sha256 prefix and its content', () => {
    const skills = loadPinnedSkills((() => { const r = tempRoot(); writeFileSync(join(r, 'A.md'), 'hello', 'utf8'); return r })(), ['A.md'], 6_000)
    const rendered = renderPinnedSkills(skills)
    expect(rendered).toContain('## Skills (pinned')
    expect(rendered).toContain('### A.md (sha256:')
    expect(rendered).toContain('hello')
    expect(rendered).toContain(skills[0]!.digest.slice(0, 12))
  })

  it('renders nothing for an empty list', () => {
    expect(renderPinnedSkills([])).toBe('')
  })
})

describe('skillRefs', () => {
  it('projects path+digest only, dropping content', () => {
    const root = tempRoot()
    writeFileSync(join(root, 'A.md'), 'hello', 'utf8')
    const skills = loadPinnedSkills(root, ['A.md'], 6_000)
    expect(skillRefs(skills)).toEqual([{ path: 'A.md', digest: skills[0]!.digest }])
  })
})

describe('renderSkillsForHandoff', () => {
  it('points at a file that still matches the record, and sends the whole thing when it does not', () => {
    const root = tempRoot()
    writeFileSync(join(root, 'A.md'), 'unchanged content', 'utf8')
    writeFileSync(join(root, 'B.md'), 'edited since dispatch', 'utf8')
    const delivered = [...skillRefs(loadPinnedSkills(root, ['A.md'], 6_000)), { path: 'B.md', digest: 'a'.repeat(64) }]

    const block = renderSkillsForHandoff(root, delivered, 6_000)
    expect(block.referenced).toEqual(['A.md'])
    expect(block.resent).toEqual(['B.md'])
    expect(block.text).toContain('`A.md` (sha256:')
    expect(block.text).toContain('unchanged since the first brief')
    expect(block.text).not.toContain('unchanged content') // the pointer costs a line, not the file
    expect(block.text).toContain('edited since dispatch') // the delta is sent in full

    // A file that vanished is said out loud rather than silently dropped — the next worker needs to know what it
    // is working without.
    const gone = renderSkillsForHandoff(root, [{ path: 'C.md', digest: 'c'.repeat(64) }], 6_000)
    expect(gone.resent).toEqual(['C.md'])
    expect(gone.text).toContain('C.md — MISSING')

    expect(renderSkillsForHandoff(root, [], 6_000)).toEqual({ text: '', referenced: [], resent: [] })
  })
})

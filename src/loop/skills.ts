import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fail } from '../kernel/errors.js'

export interface PinnedSkill {
  /** As configured in `brief.skills` — a path relative to the project root. */
  readonly path: string
  /** sha256 of the content actually embedded (post-truncation), so the digest matches what the worker saw. */
  readonly digest: string
  readonly content: string
  readonly truncated: boolean
}

export interface PinnedSkillRef { readonly path: string; readonly digest: string }

export const skillDigest = (content: string): string => createHash('sha256').update(content).digest('hex')

/**
 * Read every configured skill file relative to `root`, hash and truncate each (with a visible note) to `maxChars`
 * so one large file cannot blow the whole brief's budget. A file listed in `brief.skills` is a promise to the
 * worker that specific guidance is present — missing or unreadable files fail the dispatch outright (fail-closed)
 * rather than silently sending a worker without conventions it was told it would have.
 */
export const loadPinnedSkills = (root: string, paths: readonly string[], maxChars: number): readonly PinnedSkill[] => paths.map((relativePath) => {
  const absolute = resolve(root, relativePath)
  if (!existsSync(absolute)) return fail(`brief.skills lists "${relativePath}" but it does not exist at ${absolute}`, 'INVALID_CONFIG')
  let raw: string
  try { raw = readFileSync(absolute, 'utf8') } catch (error) { return fail(`brief.skills: could not read "${relativePath}": ${error instanceof Error ? error.message : String(error)}`, 'INVALID_CONFIG') }
  const truncated = raw.length > maxChars
  const content = truncated ? `${raw.slice(0, maxChars)}\n…[truncated ${raw.length - maxChars} chars]` : raw
  return { path: relativePath, digest: skillDigest(content), content, truncated }
})

/** Rendered once per dispatch and embedded in the worker brief; the digest lets a human or `loop retro` prove which exact revision a given run saw. */
export const renderPinnedSkills = (skills: readonly PinnedSkill[]): string => {
  if (!skills.length) return ''
  const sections = skills.map((skill) => `### ${skill.path} (sha256:${skill.digest.slice(0, 12)}${skill.truncated ? ', truncated' : ''})\n${skill.content}`)
  return `\n## Skills (pinned at dispatch time — later edits to these files do not affect this already-running worker)\n${sections.join('\n\n')}\n`
}

/** The `{path, digest}` list persisted in `dispatch.json` — the full content lives only in the brief file, not duplicated per issue. */
export const skillRefs = (skills: readonly PinnedSkill[]): readonly PinnedSkillRef[] => skills.map(({ path, digest }) => ({ path, digest }))

export interface SkillHandoffBlock {
  readonly text: string
  /** Skills the next worker is pointed at, because the file on disk still is what the record says it was. */
  readonly referenced: readonly string[]
  /** Skills sent whole, because the digest no longer matches — or never did. */
  readonly resent: readonly string[]
}

/**
 * What the worker taking over is told about the skills the previous one was given.
 *
 * A file that still hashes to the digest in the dispatch record is a pointer: it is right there in the worktree,
 * and paying to copy it into the prompt buys nothing. Anything else — edited since, unreadable, or never recorded
 * — is sent whole. The rule is deliberately asymmetric: a worker without its context is worse than a worker that
 * costs more.
 */
export const renderSkillsForHandoff = (root: string, delivered: readonly PinnedSkillRef[], maxChars: number): SkillHandoffBlock => {
  if (!delivered.length) return { text: '', referenced: [], resent: [] }
  const referenced: string[] = []
  const resent: string[] = []
  const lines = delivered.map((ref) => {
    const absolute = resolve(root, ref.path)
    let raw: string | null = null
    try { raw = existsSync(absolute) ? readFileSync(absolute, 'utf8') : null } catch { raw = null }
    if (raw === null) { resent.push(ref.path); return `### ${ref.path} — MISSING\nThe previous worker was given this file (sha256:${ref.digest.slice(0, 12)}) but it is not in the worktree now. Work without it and say so in the PR.` }
    const content = raw.length > maxChars ? `${raw.slice(0, maxChars)}\n…[truncated ${raw.length - maxChars} chars]` : raw
    if (skillDigest(content) === ref.digest) { referenced.push(ref.path); return `- \`${ref.path}\` (sha256:${ref.digest.slice(0, 12)}) — unchanged since the first brief; open it in the worktree.` }
    resent.push(ref.path)
    return `### ${ref.path} (sha256:${skillDigest(content).slice(0, 12)} — changed since the first brief, so here it is in full)\n${content}`
  })
  return { text: `\n## Skills\n${lines.join('\n\n')}\n`, referenced, resent }
}

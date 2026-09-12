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

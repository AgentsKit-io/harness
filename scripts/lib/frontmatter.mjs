import { splitFrontmatter } from '@agentskit/cross-platform/pure'
import { parse } from 'yaml'

export const parseDocument = (markdown) => {
  const { frontmatter, body } = splitFrontmatter(markdown)
  return { fields: frontmatter === null ? {} : parse(frontmatter) ?? {}, body }
}

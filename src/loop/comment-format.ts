/**
 * A tracker comment as structure, not as one vendor's markup. The loop builds a `CommentDocument`; the tracker
 * connector decides how it is written (`TrackerConnector.comments`): Markdown for Linear and GitHub, plain text, or a
 * connector's own renderer (Jira's ADF). Text in the model is plain — renderers add the markup — with one inline
 * exception: `backticks` mark code, which Markdown keeps, plain text strips and ADF maps to a code mark.
 */

import { splitLines } from '@agentskit/cross-platform'

export type CommentFormat = 'markdown' | 'plain'

export type CommentBlock =
  | { readonly kind: 'heading'; readonly text: string; readonly drop?: CommentDrop }
  | { readonly kind: 'paragraph'; readonly text: string; readonly drop?: CommentDrop }
  | { readonly kind: 'list'; readonly items: readonly string[]; readonly drop?: CommentDrop }
  | { readonly kind: 'table'; readonly header: readonly string[]; readonly rows: readonly (readonly string[])[]; readonly drop?: CommentDrop }
  | { readonly kind: 'code'; readonly text: string; readonly drop?: CommentDrop }

/** What a block is, for the truncation note, and how early it goes when the comment is too long (higher first). */
export interface CommentDrop { readonly label: string; readonly priority: number }

export interface CommentDocument {
  readonly blocks: readonly CommentBlock[]
  /** Idempotency marker (`loop:merged:42`). Markdown hides it in an HTML comment; a format that cannot hide it omits it. */
  readonly marker?: string
}

/** How one tracker takes a comment: its format, its size ceiling, and optionally its own renderer. */
export interface TrackerCommentOptions {
  readonly format: CommentFormat
  /** Largest body `comment()` accepts, in characters, after rendering. */
  readonly maxChars: number
  /** A connector whose API wants another shape (Jira ADF JSON) renders the document itself. */
  readonly render?: (document: CommentDocument) => string
}

export const DEFAULT_COMMENT_OPTIONS: TrackerCommentOptions = { format: 'markdown', maxChars: 60_000 }

const mdCell = (value: string): string => value.replaceAll('\r', '').replaceAll('\n', ' ').replaceAll('|', '\\|')
const fence = (text: string): string => { const ticks = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((match) => match[0].length + 1))); return `${ticks}\n${text}\n${ticks}` }

const markdownBlock = (block: CommentBlock): string => {
  switch (block.kind) {
    case 'heading': return `**${block.text}**`
    case 'paragraph': return block.text
    case 'list': return block.items.map((item) => `- ${item}`).join('\n')
    case 'table': return [`| ${block.header.map(mdCell).join(' | ')} |`, `|${block.header.map(() => '---').join('|')}|`, ...block.rows.map((row) => `| ${row.map(mdCell).join(' | ')} |`)].join('\n')
    case 'code': return fence(block.text)
  }
}

const unmark = (text: string): string => text.replace(/`([^`\n]*)`/g, '$1')
const plainBlock = (block: CommentBlock): string => {
  switch (block.kind) {
    case 'heading': return unmark(block.text).toUpperCase()
    case 'paragraph': return unmark(block.text)
    case 'list': return block.items.map((item) => `- ${unmark(item)}`).join('\n')
    case 'table': { const cell = (value: string): string => unmark(value).replaceAll('\r', '').replaceAll('\n', ' '); return [block.header.map(cell).join(' | '), ...block.rows.map((row) => row.map(cell).join(' | '))].join('\n') }
    case 'code': return splitLines(block.text).map((line) => `    ${line}`).join('\n')
  }
}

export const renderComment = (document: CommentDocument, format: CommentFormat): string => {
  const body = document.blocks.map(format === 'markdown' ? markdownBlock : plainBlock).join('\n\n')
  return format === 'markdown' && document.marker ? `${body}\n\n<!-- ${document.marker} -->` : body
}

/**
 * Render within `maxChars`. Over the limit, droppable blocks go first (highest priority number, last one first) and
 * one closing line names what was cut; a body that is still too long is cut at the end and says by how much. The
 * marker always survives, so a truncated comment is still deduplicated.
 */
export const fitComment = (document: CommentDocument, options: TrackerCommentOptions): string => {
  const render = (doc: CommentDocument): string => options.render ? options.render(doc) : renderComment(doc, options.format)
  const full = render(document)
  if (full.length <= options.maxChars) return full
  let blocks = [...document.blocks]
  const cut: string[] = []
  const note = (): CommentBlock => ({ kind: 'paragraph', text: `Truncated to fit this tracker's ${options.maxChars}-character comment limit. ${cut.length ? `Omitted: ${cut.join('; ')}. ` : ''}The full record is on the PR and in the loop's run store.` })
  const candidate = (): CommentDocument => ({ ...document, blocks: [...blocks, note()] })
  while (render(candidate()).length > options.maxChars) {
    let index = -1
    for (let at = blocks.length - 1; at >= 0; at -= 1) if (blocks[at]!.drop && (index < 0 || blocks[at]!.drop!.priority > blocks[index]!.drop!.priority)) index = at
    if (index < 0) break
    const [removed] = blocks.splice(index, 1)
    if (removed?.drop && !cut.includes(removed.drop.label)) cut.push(removed.drop.label)
  }
  // Nothing droppable left: the core itself is too long. Cut whole blocks from the end, then the headline's text —
  // on the model, never on the rendered string, so a structured format (ADF JSON) is never sliced mid-token.
  while (render(candidate()).length > options.maxChars && blocks.length > 1) {
    blocks.pop()
    if (!cut.includes('later sections')) cut.push('later sections')
  }
  // Rendering can lengthen text (escaping, upper-casing), so shorten the headline until the whole body fits. Cut on
  // code points, never mid-surrogate-pair, and never leave an unmatched backtick before the ellipsis.
  const first = blocks[0]
  if (first && 'text' in first && render(candidate()).length > options.maxChars) {
    if (!cut.includes('end of the headline')) cut.push('end of the headline')
    const points = Array.from(first.text)
    const withHead = (count: number): CommentBlock => {
      let text = points.slice(0, count).join('')
      if ((text.match(/`/g) ?? []).length % 2 === 1) text = text.slice(0, text.lastIndexOf('`'))
      return { ...first!, text: `${text}…` }
    }
    // Longest headline prefix that fits (binary search: rendering is monotonic in length).
    let low = 0
    let high = points.length
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      blocks = [withHead(mid)]
      if (render(candidate()).length <= options.maxChars) low = mid
      else high = mid - 1
    }
    blocks = [withHead(low)]
  }
  return render(candidate())
}

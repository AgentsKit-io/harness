/**
 * Pull the JSON a model was asked to put between two markers out of its output.
 *
 * The markers are the contract; the fallbacks are what models actually do. Measured on the plan interview prompt:
 * kimi-k2.6 answered with a correct object in a ```json fence and no markers; minimax-m3 opened with `<<LOOP_QUESTION`
 * (two brackets), thought aloud, and closed with `<<<LOOP_QUESTION>>>`. So, in order: the exact markers when what
 * sits between them parses; else the last fenced JSON block; else the last balanced JSON value in the text that
 * parses. The schema that validates the result afterwards is unchanged, so the wrong object still fails — one step
 * later, with a message about its content instead of "no block".
 */
export const extractOutputBlock = (text: string, open: string, close: string): string | null => {
  const start = text.lastIndexOf(open)
  const end = text.lastIndexOf(close)
  const marked = start >= 0 && end > start ? stripFence(text.slice(start + open.length, end)) : null
  if (marked !== null && parses(marked)) return marked
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/gi)]
  for (const fence of fences.reverse()) {
    const body = fence[1]?.trim() ?? ''
    if (/^[[{]/.test(body) && parses(body)) return body
  }
  // Nothing parses anywhere: hand back what the markers held, so the caller reports *that* JSON as invalid instead of
  // claiming there was no block at all.
  return lastJsonValue(text) ?? (marked || null)
}

const stripFence = (block: string): string => block.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')

const parses = (text: string): boolean => {
  try { JSON.parse(text); return true } catch { return false }
}

/** The last `{…}` (or `[…]`) in the text that is balanced and parses — scanning back from the end. */
const lastJsonValue = (text: string): string | null => {
  for (let index = text.length - 1; index >= 0; index -= 1) {
    const char = text[index]
    if (char !== '{' && char !== '[') continue
    const closing = matchingClose(text, index)
    if (closing < 0) continue
    const candidate = text.slice(index, closing + 1)
    if (parses(candidate)) {
      // Keep widening: an inner object parses too, but the answer is the outermost value that ends here.
      let outer = candidate
      for (let back = index - 1; back >= 0; back -= 1) {
        if (text[back] !== '{' && text[back] !== '[') continue
        const wider = matchingClose(text, back)
        if (wider >= closing && parses(text.slice(back, wider + 1))) outer = text.slice(back, wider + 1)
      }
      return outer
    }
  }
  return null
}

/** Index of the bracket closing the one at `open`, honouring strings and escapes; -1 when unbalanced. */
const matchingClose = (text: string, open: number): number => {
  let depth = 0
  let inString = false
  for (let index = open; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (char === '\\') index += 1
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{' || char === '[') depth += 1
    else if (char === '}' || char === ']') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

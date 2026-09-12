/**
 * Deterministic pattern scanner for text that is about to be embedded in a prompt or echoed back into a public
 * PR/issue comment — a segment lifted from an issue description or a code-review finding can carry a secret that
 * was never meant to leave the private context it came from. Pure and kernel-safe: no adapters, no network, no
 * state. Pattern-based, not a claim of completeness — it catches the shapes that show up in practice (emails,
 * common provider API-key prefixes, phone numbers, card-number-shaped digit runs), not every possible secret.
 */

export type PiiKind = 'email' | 'api-key' | 'phone' | 'credit-card'

export interface PiiMatch {
  readonly kind: PiiKind
  readonly index: number
  readonly length: number
}

export interface PiiScanResult {
  readonly matches: readonly PiiMatch[]
  /** `text` with every match replaced by `[REDACTED:<kind>]`. Equal to `text` when `matches` is empty. */
  readonly redacted: string
}

const PATTERNS: readonly { readonly kind: PiiKind; readonly regex: RegExp }[] = [
  { kind: 'api-key', regex: /\b(?:sk-[A-Za-z0-9]{16,}|gh[opsu]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g },
  { kind: 'email', regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { kind: 'credit-card', regex: /\b(?:\d[ -]?){13,16}\b/g },
  { kind: 'phone', regex: /\b\+?\d{1,3}?[\s().-]?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{4}\b/g },
]

/** Scan `text` for every configured pattern kind and return both the matches (positions into the *original* text) and a redacted copy. */
export const scanForPii = (text: string): PiiScanResult => {
  if (typeof text !== 'string' || !text) return { matches: [], redacted: text ?? '' }
  const matches: PiiMatch[] = []
  const claimed: { readonly start: number; readonly end: number }[] = []
  for (const { kind, regex } of PATTERNS) {
    for (const match of text.matchAll(regex)) {
      if (match.index === undefined) continue
      const start = match.index
      const end = start + match[0].length
      // A card-number-shaped span already claimed by an earlier, more specific pattern (e.g. api-key) is not reported twice.
      if (claimed.some((range) => start < range.end && end > range.start)) continue
      matches.push({ kind, index: start, length: match[0].length })
      claimed.push({ start, end })
    }
  }
  if (!matches.length) return { matches, redacted: text }
  const ordered = [...matches].sort((left, right) => left.index - right.index)
  let redacted = ''
  let cursor = 0
  for (const match of ordered) {
    redacted += text.slice(cursor, match.index) + `[REDACTED:${match.kind}]`
    cursor = match.index + match.length
  }
  redacted += text.slice(cursor)
  return { matches: ordered, redacted }
}

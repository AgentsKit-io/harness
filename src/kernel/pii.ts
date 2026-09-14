/**
 * Deterministic pattern scanner for text that is about to be embedded in a prompt or echoed back into a public
 * PR/issue comment — a segment lifted from an issue description or a code-review finding can carry a secret that
 * was never meant to leave the private context it came from. Pure and kernel-safe: no adapters, no network, no
 * state. Pattern-based, not a claim of completeness — it catches the shapes that show up in practice (emails,
 * common provider API-key prefixes, PEM private-key blocks, phone numbers, card-number-shaped digit runs), not
 * every possible secret.
 */

export type PiiKind = 'email' | 'api-key' | 'phone' | 'credit-card' | 'private-key'

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
  // PEM key blocks first: large, unambiguous, and must claim their content before any narrower pattern below
  // could otherwise match a substring inside the base64 body (unlikely, but claimed-range order matters).
  { kind: 'private-key', regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |)PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |)PRIVATE KEY-----/g },
  // `sk-` body allows `-`/`_` (not just alnum) so a project/scoped key like `sk-proj-...`/`sk-live-...` matches
  // as one token instead of the hyphen splitting it into a too-short fragment. `github_pat_` (fine-grained PAT)
  // and `AIza…` (Google API key) are current real-world formats missing from the original list entirely.
  { kind: 'api-key', regex: /\b(?:sk-[A-Za-z0-9_-]{16,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|pk_(?:live|test)_[A-Za-z0-9]{16,}|gh[opsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{30,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g },
  // The AWS *secret* half (as opposed to the `AKIA…` access-key id above) has no recognizable prefix — a bare
  // 40-char base64-shaped run is too generic to scan for on its own (matches hashes, tokens, arbitrary base64).
  // Anchoring on the conventional key name it's almost always assigned to/from keeps this pattern high-signal.
  { kind: 'api-key', regex: /\b(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY|SecretAccessKey)\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})["']?/g },
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

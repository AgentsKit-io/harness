import { existsSync, readFileSync } from 'node:fs'
import { z } from 'zod'
import { join } from 'node:path'
import { touchesProtectedPaths } from '../adapters/github-cli.js'
import type { LoopConfig } from './config.js'
import type { TaskContract } from './contract.js'
import { readJsonFile } from '../kernel/json-file.js'

export type DodItem = LoopConfig['dod']['items'][number]

/** One proof the worker wrote: which item, whether it passed, and the evidence it captured. */
export interface DodProof {
  readonly id: string
  readonly status: 'passed' | 'failed'
  /** Command output, file list, or whatever the check produced. Trimmed when it reaches the PR. */
  readonly evidence: string
  readonly at?: string
}

export interface DodEvidenceFile {
  readonly project: readonly DodProof[]
  readonly outcomes: readonly DodProof[]
}

export interface DodLine {
  readonly id: string
  readonly list: 'project' | 'issue'
  readonly description: string
  readonly status: 'proven' | 'failed' | 'missing'
  readonly evidence: string
  readonly source: 'worker' | 'harness'
}

export interface DodAssessment { readonly complete: boolean; readonly lines: readonly DodLine[]; readonly missing: readonly string[]; readonly failed: readonly string[] }

export const dodEvidencePath = (worktreePath: string, config: LoopConfig): string => join(worktreePath, config.dod.evidenceFile)

/** Read the worker's proofs from its worktree. A missing or malformed file reads as "nothing proven", never as an error. */
export const readDodEvidence = (worktreePath: string | null | undefined, config: LoopConfig): DodEvidenceFile => {
  const empty: DodEvidenceFile = { project: [], outcomes: [] }
  if (!worktreePath) return empty
  const path = dodEvidencePath(worktreePath, config)
  if (!existsSync(path)) return empty
  try {
    const parsed = (readJsonFile(path, z.object({}).loose()) ?? {}) as Partial<DodEvidenceFile>
    const proofs = (value: unknown): readonly DodProof[] => Array.isArray(value)
      ? value.filter((entry): entry is DodProof => typeof entry === 'object' && entry !== null && typeof (entry as DodProof).id === 'string' && ((entry as DodProof).status === 'passed' || (entry as DodProof).status === 'failed'))
        .map((entry) => ({ id: entry.id, status: entry.status, evidence: typeof entry.evidence === 'string' ? entry.evidence : '', ...(typeof entry.at === 'string' ? { at: entry.at } : {}) }))
      : []
    return { project: proofs(parsed.project), outcomes: proofs(parsed.outcomes) }
  } catch { return empty }
}

const matches = (files: readonly string[], globs: readonly string[]): readonly string[] => globs.length ? touchesProtectedPaths(files, globs) : files

/**
 * Items the harness can decide by itself from the PR's changed files. `command` is never one of them: the harness
 * does not run project commands (the worker does, in its own worktree), so its proof can only come from the worker.
 */
const harnessVerdict = (item: DodItem, prFiles: readonly string[], fileContents: Readonly<Record<string, string>>): Pick<DodLine, 'status' | 'evidence'> | null => {
  if (item.kind === 'file-changed') {
    const hit = item.glob ? touchesProtectedPaths(matches(prFiles, item.paths), [item.glob]) : matches(prFiles, item.paths)
    const what = item.glob ?? (item.paths.join(', ') || 'anything')
    return hit.length ? { status: 'proven', evidence: `changed: ${hit.slice(0, 5).join(', ')}${hit.length > 5 ? ` (+${hit.length - 5})` : ''}` } : { status: 'failed', evidence: `no changed file matches ${what}` }
  }
  if (item.kind === 'pattern-absent') {
    if (!item.pattern) return { status: 'failed', evidence: 'pattern-absent item declares no pattern' }
    const scope = matches(prFiles, item.paths)
    const regex = new RegExp(item.pattern)
    // Only files whose content this caller supplied can be inspected; anything else is left to the worker's proof.
    const readable = scope.filter((file) => file in fileContents)
    if (!readable.length) return null
    const offenders = readable.filter((file) => regex.test(fileContents[file] ?? ''))
    return offenders.length ? { status: 'failed', evidence: `${item.pattern} found in ${offenders.join(', ')}` } : { status: 'proven', evidence: `${item.pattern} absent from ${readable.length} changed file(s)` }
  }
  return null
}

/**
 * Both lists, judged together.
 *
 * The project list comes from `dod.items`, the issue list from the frozen contract's outcomes. An item the worker
 * did not prove is `missing`, not `failed` — the difference matters: missing means "prove it", failed means "fix
 * it", and a loop that conflates them sends the wrong instruction back to the worker.
 */
export const assessDod = (input: {
  readonly config: LoopConfig
  readonly contract: TaskContract | null
  readonly evidence: DodEvidenceFile
  readonly prFiles?: readonly string[]
  readonly fileContents?: Readonly<Record<string, string>>
}): DodAssessment => {
  const lines: DodLine[] = []
  const byId = (proofs: readonly DodProof[], id: string): DodProof | undefined => proofs.find((proof) => proof.id === id)

  for (const item of input.config.dod.items) {
    const verdict = harnessVerdict(item, input.prFiles ?? [], input.fileContents ?? {})
    if (verdict) { lines.push({ id: item.id, list: 'project', description: item.description, status: verdict.status, evidence: verdict.evidence, source: 'harness' }); continue }
    const proof = byId(input.evidence.project, item.id)
    lines.push({
      id: item.id, list: 'project', description: item.description, source: 'worker',
      status: proof ? (proof.status === 'passed' ? 'proven' : 'failed') : 'missing',
      evidence: proof?.evidence ?? (item.kind === 'command' ? `run \`${(item.command ?? []).join(' ')}\` and record its output` : 'no proof recorded'),
    })
  }

  for (const outcome of input.contract?.outcomes ?? []) {
    const proof = byId(input.evidence.outcomes, outcome.id)
    lines.push({
      id: outcome.id, list: 'issue', description: outcome.description, source: 'worker',
      status: proof ? (proof.status === 'passed' ? 'proven' : 'failed') : 'missing',
      evidence: proof?.evidence ?? `check: ${outcome.check.kind}${outcome.check.command ? ` → ${outcome.check.command}` : ''}`,
    })
  }

  const missing = lines.filter((line) => line.status === 'missing').map((line) => line.id)
  const failed = lines.filter((line) => line.status === 'failed').map((line) => line.id)
  return { complete: !missing.length && !failed.length, lines, missing, failed }
}

const clip = (value: string, max = 400): string => value.length > max ? `${value.slice(0, max)}…` : value

/** The DoD block the loop writes on the PR: one row per item, with the proof next to it. */
export const renderDodMarkdown = (assessment: DodAssessment): string => {
  const icon = (status: DodLine['status']): string => status === 'proven' ? '✅' : status === 'failed' ? '❌' : '⬜️'
  const rows = assessment.lines.map((line) => `| ${icon(line.status)} | ${line.list} | \`${line.id}\` | ${line.description} | ${clip(line.evidence.replaceAll('\n', ' ').replaceAll('|', '\\|'), 200)} |`)
  return ['## Definition of Done', '', assessment.complete ? '_Both lists proven._' : `_Missing: ${assessment.missing.join(', ') || 'none'} · failing: ${assessment.failed.join(', ') || 'none'}_`, '', '| | list | id | item | evidence |', '|---|---|---|---|---|', ...rows].join('\n')
}

/** The instructions the worker gets: what to prove, and exactly where to write the proof. */
export const renderDodForBrief = (config: LoopConfig): string => {
  if (!config.dod.items.length) return ''
  const items = config.dod.items.map((item) => {
    const how = item.kind === 'command' ? `run \`${(item.command ?? []).join(' ')}\` (exit 0)` : item.kind === 'file-changed' ? `this PR must change a file matching \`${item.glob ?? item.paths.join(', ')}\`` : `no changed file may contain \`${item.pattern}\`${item.paths.length ? ` under ${item.paths.join(', ')}` : ''}`
    return `- \`${item.id}\`: ${item.description} — ${how}`
  }).join('\n')
  return `
## Definition of Done (project — the same for every issue)
${items}

Prove every item above **and** every contract outcome before opening the PR, and record the proofs in \`${config.dod.evidenceFile}\` at the root of this worktree:

\`\`\`json
{ "project": [{ "id": "<item id>", "status": "passed", "evidence": "<command output, file list, or what you saw>" }],
  "outcomes": [{ "id": "<outcome id>", "status": "passed", "evidence": "<how you verified it>" }] }
\`\`\`

The loop reads that file and writes the two lists, with your evidence, onto the PR. **An item without a proof blocks the merge** — a reviewer reads evidence, not a promise.
`
}

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { LoopConfig } from './config.js'

/**
 * The contract between a worker and the harness: one file per phase, at `.ak-loop/` in the worktree.
 *
 * The machine advances on **presence plus validation**, never on a promise in a terminal. A phase whose file is
 * missing is not "probably fine" — it is a phase nobody can check, and `deliver` says which file it wanted.
 */
export const ARTIFACT_DIR = '.ak-loop'

const nonEmpty = z.string().trim().min(1)

/** `verify.json` — what the worker ran and what happened, outcome by outcome. */
export const VerifyArtifactSchema = z.object({
  ranAt: z.string().trim().optional(),
  command: z.string().trim().default(''),
  exitCode: z.number().int().optional(),
  outcomes: z.array(z.object({
    id: nonEmpty,
    status: z.enum(['passed', 'failed']),
    evidence: z.string().trim().default(''),
  })).default([]),
})
export type VerifyArtifact = z.infer<typeof VerifyArtifactSchema>

export type PhaseArtifactName = 'plan' | 'verify' | 'dod'

export interface PhaseArtifact {
  readonly name: PhaseArtifactName
  readonly file: string
  readonly present: boolean
  /** False when the file exists but does not match its schema — worse than absent, because it looks like evidence. */
  readonly valid: boolean
  readonly detail: string
}

export const artifactPath = (worktreePath: string, file: string): string => join(worktreePath, ARTIFACT_DIR, file)

const readJson = (path: string): unknown => { try { return JSON.parse(readFileSync(path, 'utf8')) as unknown } catch { return undefined } }

/** Read `plan.md` — free text, so presence is the whole check. Empty counts as absent. */
export const readPlanArtifact = (worktreePath: string | null | undefined): string | null => {
  if (!worktreePath) return null
  const path = artifactPath(worktreePath, 'plan.md')
  if (!existsSync(path)) return null
  try { const text = readFileSync(path, 'utf8').trim(); return text || null } catch { return null }
}

export const readVerifyArtifact = (worktreePath: string | null | undefined): VerifyArtifact | null => {
  if (!worktreePath) return null
  const path = artifactPath(worktreePath, 'verify.json')
  if (!existsSync(path)) return null
  const parsed = VerifyArtifactSchema.safeParse(readJson(path))
  return parsed.success ? parsed.data : null
}

/**
 * What the worktree has to show for itself.
 *
 * `dod` is checked by name only here — its contents are `dod.ts`'s business, and duplicating that judgement in two
 * places is how the two drift apart.
 */
export const readPhaseArtifacts = (worktreePath: string | null | undefined, config: LoopConfig): readonly PhaseArtifact[] => {
  // Both separators: a config written on Windows says `.ak-loop\dod.json`, and stripping only the forward-slash
  // form would look for `<worktree>/.ak-loop/.ak-loop\dod.json` and report the evidence missing forever.
  const dodFile = config.dod.evidenceFile.replace(/^\.ak-loop[\\/]/, '')
  const plan = readPlanArtifact(worktreePath)
  const verifyPath = worktreePath ? artifactPath(worktreePath, 'verify.json') : ''
  const verifyExists = Boolean(worktreePath) && existsSync(verifyPath)
  const verify = readVerifyArtifact(worktreePath)
  const dodPath = worktreePath ? artifactPath(worktreePath, dodFile) : ''
  const dodExists = Boolean(worktreePath) && existsSync(dodPath)
  return [
    { name: 'plan', file: `${ARTIFACT_DIR}/plan.md`, present: plan !== null, valid: plan !== null, detail: plan ? `${plan.split(/\r?\n/).length} line(s)` : 'not written' },
    { name: 'verify', file: `${ARTIFACT_DIR}/verify.json`, present: verifyExists, valid: verify !== null, detail: verify ? `${verify.outcomes.length} outcome(s)${verify.command ? ` · ${verify.command}` : ''}` : verifyExists ? 'present but does not match the schema' : 'not written' },
    { name: 'dod', file: `${ARTIFACT_DIR}/${dodFile}`, present: dodExists, valid: dodExists, detail: dodExists ? 'present' : 'not written' },
  ]
}

/** The artifacts a phase requires but does not have. Empty means the machine may advance. */
export const missingArtifacts = (artifacts: readonly PhaseArtifact[], required: readonly PhaseArtifactName[]): readonly PhaseArtifact[] =>
  artifacts.filter((artifact) => required.includes(artifact.name) && !(artifact.present && artifact.valid))

/** Outcome proofs the worker recorded in `verify.json`, in the shape `assessDod` already understands. */
export const verifyProofs = (verify: VerifyArtifact | null): readonly { readonly id: string; readonly status: 'passed' | 'failed'; readonly evidence: string }[] =>
  verify ? verify.outcomes.map((outcome) => ({ id: outcome.id, status: outcome.status, evidence: outcome.evidence || `${verify.command || 'verify'} → ${outcome.status}` })) : []

/** The block in the worker's brief that names the three files and what each one is for. */
export const renderArtifactsForBrief = (config: LoopConfig): string => `
## What to leave behind (\`${ARTIFACT_DIR}/\` at the root of this worktree)
The loop advances on files it can check, not on what a terminal said. Write all three before you open the PR:

- \`${ARTIFACT_DIR}/plan.md\` — the plan you actually followed. If you departed from the approved one, this is where you say so and why.
- \`${ARTIFACT_DIR}/verify.json\` — what you ran and what happened: \`{ "ranAt": "<iso>", "command": "<the command>", "exitCode": 0, "outcomes": [{ "id": "<outcome id>", "status": "passed", "evidence": "<the output line that proves it>" }] }\`
- \`${config.dod.evidenceFile}\` — the Definition of Done proofs, in the shape described above.

A file that is missing blocks the merge and comes back to you as a fix round naming it. A file that exists but does not match its schema is worse than a missing one, because it looks like evidence.
`

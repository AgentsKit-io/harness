import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import type { CommandRunner } from '../adapters/command.js'
import { sha256 } from '../kernel/hash.js'
import type { LoopConfig } from './config.js'
import type { StoredContract } from './contract.js'
import type { StoredPlan } from './plan-vote.js'

/**
 * Spec-driven development without a spec writer (ADR-0041): `specs/<issue>/` in the Spec Kit / Kiro layout, rendered
 * from what the loop already froze — the contract (requirements) and the approved plan (design, tasks). Pure: the
 * same contract and plan always render the same bytes, which is what lets `deliver` call a changed copy drift.
 *
 * Requirement ids are the contract's outcome ids. That is the whole traceability story: requirement → its check
 * (here) → the worker's proof in `verify.json` for the same id → the DoD table on the PR.
 */
export const SPEC_FILES = ['requirements.md', 'design.md', 'tasks.md'] as const
export type SpecFile = typeof SPEC_FILES[number]
export type RenderedSpec = Readonly<Record<SpecFile, string>>

export interface SpecInput {
  readonly issue: string
  readonly url?: string | null
  readonly contract: StoredContract
  readonly plan: StoredPlan | null
}

const list = (items: readonly string[], empty: string): string => items.length ? items.map((item) => `- ${item}`).join('\n') : `- ${empty}`

const banner = (source: string): string =>
  `<!-- Rendered by ak-harness from ${source}. Do not edit: the loop re-renders this file and holds a PR whose copy differs. -->`

const checkOf = (outcome: StoredContract['contract']['outcomes'][number]): string =>
  `${outcome.check.kind}${outcome.check.command ? ` — \`${outcome.check.command}\`` : ''}${outcome.check.note ? ` (${outcome.check.note})` : ''}`

export const renderSpec = (input: SpecInput): RenderedSpec => {
  const { contract } = input.contract
  // A plan for another contract digest is not this contract's design: `tick` and `deliver` must render the same bytes.
  const approved = input.plan?.status === 'approved' && input.plan.contractDigest === input.contract.digest ? input.plan : null
  const plan = approved?.plan ?? null
  const contractSource = `the frozen contract ${input.contract.digest.slice(0, 12)}`
  const planSource = approved ? `the approved plan ${approved.digest.slice(0, 12)}` : 'the frozen contract (no approved plan)'
  const header = (title: string): string => `# ${title} — ${input.issue}\n\n${input.url ? `Issue: ${input.url}\n\n` : ''}`

  const requirements = `${banner(contractSource)}
${header('Requirements')}## Intent

${contract.intent}

## Scope

### In scope

${list(contract.scope.inScope, 'nothing declared')}

### Out of scope

${list(contract.scope.outOfScope, 'nothing declared')}

## Requirements

${contract.outcomes.length ? contract.outcomes.map((outcome) => `### ${outcome.id}\n\n${outcome.description}\n\n**Acceptance:** ${checkOf(outcome)}`).join('\n\n') : '_No outcomes: this contract is not dispatchable._'}
${contract.ambiguities.length ? `\n## Open questions\n\n${contract.ambiguities.map((item) => `- ${item.question}${item.blocking ? ' **(blocking)**' : ''}`).join('\n')}\n` : ''}`

  const design = `${banner(planSource)}
${header('Design')}## Approach

${plan?.summary ?? 'No plan was approved for this issue; the worker records the plan it followed in `.ak-loop/plan.md`.'}

## Touchpoints

${list(contract.touchpoints, 'none declared')}

## Risks

${list([...contract.risks, ...(plan?.risks ?? [])], 'none declared')}
${approved?.unresolved.length ? `\n## Objections carried past the vote\n\n${list(approved.unresolved, '')}\n` : ''}`

  const tasks = `${banner(planSource)}
${header('Tasks')}## Implementation

${plan ? plan.steps.map((step) => `- [ ] **${step.id}** ${step.description}${step.files.length ? `\n  - files: ${step.files.map((file) => `\`${file}\``).join(', ')}` : ''}`).join('\n') : '- [ ] Implement the requirements in `requirements.md` (no approved plan)'}
${plan?.tests.length ? `\n## Tests\n\n${plan.tests.map((test) => `- [ ] ${test}`).join('\n')}\n` : ''}
## Verification

| Requirement | Check | Proof |
|---|---|---|
${contract.outcomes.map((outcome) => `| ${outcome.id} | ${checkOf(outcome).replace(/\|/g, '\\|')} | \`.ak-loop/verify.json\` → \`${outcome.id}\` |`).join('\n')}
`
  return { 'requirements.md': requirements, 'design.md': design, 'tasks.md': tasks }
}

export const specDigest = (spec: RenderedSpec): string => sha256(SPEC_FILES.map((file) => spec[file]).join('\0'))

/** `specs/<issue>` relative to the worktree root. */
// Repository paths, not filesystem paths: `/` on every OS (git pathspecs, PR text, the brief).
export const specDirFor = (config: LoopConfig, issue: string): string => posix.join(config.spec.dir.replace(/\\/g, '/'), issue)

export const writeSpec = (worktreePath: string, config: LoopConfig, issue: string, spec: RenderedSpec): readonly string[] =>
  SPEC_FILES.map((file) => {
    const path = join(worktreePath, specDirFor(config, issue), file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, spec[file], 'utf8')
    return posix.join(specDirFor(config, issue), file)
  })

export interface SpecCheck {
  readonly missing: readonly string[]
  readonly drifted: readonly string[]
  readonly uncommitted: readonly string[]
  /** Correct in the worktree but not in the PR (gitignored, or committed and never pushed), and not already on the base. */
  readonly notInPr: readonly string[]
}

/** What `deliver` holds a PR for: a spec file absent, edited, or left out of the commits. */
export const checkSpec = async (runner: CommandRunner, worktreePath: string, config: LoopConfig, issue: string, expected: RenderedSpec, prFiles: readonly string[]): Promise<SpecCheck> => {
  const dir = specDirFor(config, issue)
  const missing: string[] = []
  const drifted: string[] = []
  for (const file of SPEC_FILES) {
    const path = join(worktreePath, dir, file)
    if (!existsSync(path)) { missing.push(posix.join(dir, file)); continue }
    if (readFileSync(path, 'utf8') !== expected[file]) drifted.push(posix.join(dir, file))
  }
  const status = await runner.run(['git', 'status', '--porcelain', '--', dir], { cwd: worktreePath, timeoutMs: 10_000 })
  // Fails closed: a status nobody could read is not proof the files were committed.
  const uncommitted = status.code === 0 ? status.stdout.split(/\r?\n/).map((line) => line.slice(3).trim()).filter(Boolean) : [`${dir} (git status failed: ${status.stderr.trim().slice(0, 120) || `exit ${status.code ?? 'null'}`})`]
  // The worktree is not the PR: a gitignored or unpushed spec reads fine locally and never reaches the reviewer. Each
  // file must be in the PR's diff, or already identical on the base (a re-dispatch of an issue whose spec merged).
  const notInPr: string[] = []
  for (const file of SPEC_FILES) {
    const path = posix.join(dir, file)
    if (missing.includes(path) || prFiles.includes(path)) continue
    const base = await runner.run(['git', 'show', `origin/${config.project.baseBranch}:${path}`], { cwd: worktreePath, timeoutMs: 10_000 })
    if (base.code !== 0 || base.stdout !== expected[file]) notInPr.push(path)
  }
  return { missing, drifted, uncommitted, notInPr }
}

export const renderSpecForBrief = (config: LoopConfig, issue: string): string => `
## Spec (\`${specDirFor(config, issue)}/\`)
The loop rendered \`requirements.md\`, \`design.md\` and \`tasks.md\` there from your frozen contract and plan. Commit them **unchanged** in this PR — they are the specification the reviewer reads next to the diff. Requirement ids are the outcome ids below; prove each one in \`verify.json\` under the same id. Do not edit them: a copy that differs from the contract holds the PR. If the spec is wrong, say so in \`.ak-loop/plan.md\` and the PR body.
`

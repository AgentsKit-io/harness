import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { CommandRunner } from '../adapters/command.js'
import type { LoadedLoopConfig } from './config.js'
import type { Design, PlanStageState, Prd } from './plan-stage.js'

/**
 * The PRD and the technical design, written into the repository when a human approves them.
 *
 * They go in as files on purpose: a worker three weeks from now greps the repo, not a loop state directory, and a
 * reviewer diffs a document the same way they diff code. The state directory keeps the machine's copy; this is
 * the one people read.
 */
export interface WrittenDocument { readonly kind: 'prd' | 'design'; readonly path: string; readonly note?: string }

export const prdPathFor = (loaded: LoadedLoopConfig, id: string, root: string = loaded.root): string => resolve(root, join(loaded.config.documents.prdPath, `${id}.md`))
export const designPathFor = (loaded: LoadedLoopConfig, id: string, root: string = loaded.root): string => resolve(root, join(loaded.config.documents.designPath, `${id}.md`))

/** The operator's checkout as git reports it; null where `project.root` is not a git work tree. */
export interface CheckoutState { readonly branch: string | null; readonly dirty: boolean }

export const readCheckoutState = async (runner: CommandRunner, root: string): Promise<CheckoutState | null> => {
  try {
    const branch = await runner.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, timeoutMs: 10_000 })
    if (branch.code !== 0) return null
    const status = await runner.run(['git', 'status', '--porcelain'], { cwd: root, timeoutMs: 30_000 })
    const name = branch.stdout.trim()
    return { branch: name && name !== 'HEAD' ? name : null, dirty: status.code !== 0 || status.stdout.trim().length > 0 }
  } catch { return null }
}

/**
 * Where an approved document is written: the repository when its checkout is the clean base branch, the state
 * directory otherwise.
 *
 * `project.root` is the operator's own checkout. Observed: a PRD approved while it sat on an unrelated, dirty
 * branch landed silently among that branch's uncommitted changes, where it either rides along in the wrong PR or
 * gets lost with the branch. Kept under the state directory instead, with a note saying so, it waits for a person
 * to carry it to the base branch in a PR of its own.
 */
export const documentRoot = (loaded: LoadedLoopConfig, checkout: CheckoutState | null): { readonly root: string; readonly note?: string } => {
  if (!checkout) return { root: loaded.root }
  const base = loaded.config.project.baseBranch
  const reason = checkout.branch !== base ? `the checkout is on ${checkout.branch ?? 'a detached HEAD'}, not ${base}` : checkout.dirty ? 'the checkout has uncommitted changes' : null
  if (!reason) return { root: loaded.root }
  return { root: join(loaded.stateDir, 'documents'), note: `written under the loop's state directory because ${reason}; commit it to ${base} in a PR of its own` }
}

const list = (items: readonly string[]): string => items.length ? items.map((item) => `- ${item}`).join('\n') : '- _none declared_'

export const renderPrdMarkdown = (state: PlanStageState, prd: Prd, approvedBy: string | null): string => [
  `# PRD — ${prd.objective}`,
  '',
  `Plan \`${state.id}\` · approved by ${approvedBy ?? 'pending'}`,
  '',
  '## Users', list(prd.users),
  '', '## In scope', list(prd.inScope),
  '', '## Out of scope', list(prd.outOfScope),
  '', '## Non-goals', list(prd.nonGoals),
  '', '## Constraints', list(prd.constraints),
  '', '## Success criteria', list(prd.successCriteria),
  '', '## Risks', list(prd.risks),
  '',
  '## How this was decided',
  '',
  ...(state.rounds.length ? state.rounds.map((round) => `- **${round.field || 'question'}** — ${round.question}\n  - ${round.answer}`) : ['- _no interview rounds recorded_']),
  '',
  `<!-- loop:prd:${state.id} -->`,
  '',
].join('\n')

export const renderDesignMarkdown = (state: PlanStageState, design: Design, approvedBy: string | null): string => [
  `# Technical design — ${state.prd.objective ?? state.objective}`,
  '',
  `Plan \`${state.id}\` · ${state.designVotes.filter((vote) => vote.vote === 'approve').length}/${state.designVotes.length} agents approved after ${state.designCycles} cycle(s) · approved by ${approvedBy ?? 'pending'}`,
  '',
  design.summary,
  '',
  '## Modules',
  ...(design.modules.map((module) => `- **${module.name}** — ${module.responsibility}${module.boundary ? ` · never: ${module.boundary}` : ''}`)),
  '',
  '## Contracts',
  ...(design.contracts.length ? design.contracts.map((contract) => `- **${contract.name}** — \`${contract.shape}\``) : ['- _none declared_']),
  '',
  '## Decisions',
  ...(design.decisions.length ? design.decisions.map((decision) => `- **${decision.id}** — ${decision.decision}\n  - because: ${decision.because}`) : ['- _none recorded_']),
  '',
  '## Sequence', list(design.sequence),
  '', '## Risks', list(design.risks),
  '',
  '_Promoting any decision above into a numbered ADR under `docs/adr/` is a human gesture; the loop never writes one._',
  '',
  `<!-- loop:design:${state.id} -->`,
  '',
].join('\n')

const write = (path: string, text: string): void => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text, 'utf8') }

/** Write the PRD once a human approves it. A no-op under `documents.backend: none`. */
export const writePrdDocument = (loaded: LoadedLoopConfig, state: PlanStageState, target: { readonly root: string; readonly note?: string } = { root: loaded.root }): WrittenDocument | null => {
  if (loaded.config.documents.backend !== 'file') return null
  const prd = state.prd
  if (!prd.objective) return null
  const path = prdPathFor(loaded, state.id, target.root)
  write(path, renderPrdMarkdown(state, prd as Prd, state.approvals.plan))
  return { kind: 'prd', path, ...(target.note ? { note: target.note } : {}) }
}

/** Write the design once a human approves it. A no-op under `documents.backend: none`. */
export const writeDesignDocument = (loaded: LoadedLoopConfig, state: PlanStageState, target: { readonly root: string; readonly note?: string } = { root: loaded.root }): WrittenDocument | null => {
  if (loaded.config.documents.backend !== 'file' || !state.design) return null
  const path = designPathFor(loaded, state.id, target.root)
  write(path, renderDesignMarkdown(state, state.design, state.approvals.design))
  return { kind: 'design', path, ...(target.note ? { note: target.note } : {}) }
}

/**
 * The part of the design an issue implements, as **content** rather than a link.
 *
 * This is the fork closed in the roadmap: a worker that receives a pointer has to go and fetch it, and a worker
 * that cannot fetch it invents the architecture instead. So the module, contract or decision the issue names
 * travels inside the issue itself.
 */
export const designExcerptFor = (design: Design | null, designRef: string): string => {
  if (!design) return ''
  const ref = designRef.trim().toLowerCase()
  const module = design.modules.find((item) => item.name.toLowerCase() === ref)
  if (module) return `**${module.name}** — ${module.responsibility}${module.boundary ? `\n\nNever: ${module.boundary}` : ''}`
  const contract = design.contracts.find((item) => item.name.toLowerCase() === ref)
  if (contract) return `**${contract.name}** — \`${contract.shape}\``
  const decision = design.decisions.find((item) => item.id.toLowerCase() === ref)
  if (decision) return `**${decision.id}** — ${decision.decision}\n\nBecause: ${decision.because}`
  // Nothing matched: the summary is still better than a bare reference the worker cannot resolve.
  return design.summary
}

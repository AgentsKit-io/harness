/**
 * Every event the loop emits, named once.
 *
 * The value of each entry is the fields that event carries beyond `at` and `type`, which every event has. The
 * list is the contract a plugin, a notification channel or the reference documentation reads — an event whose
 * name only exists inside a template string is an event nobody can subscribe to on purpose.
 *
 * Adding an emission without adding it here does not compile, and `test/loop-event-vocabulary.test.ts` fails the
 * other way round too: a name declared here that nothing emits is a promise the loop does not keep.
 */
export const LOOP_EVENT_TYPES = {
  /** A contract was frozen but is not dispatchable; a human was asked to settle it. */
  'contract.escalated': ['issue', 'reasons', 'digest'],
  /** Contract generation failed on every candidate provider. */
  'contract.failed': ['issue', 'error'],

  /** One planning cycle finished: how many agents approved the plan, out of how many voted. */
  'plan.voted': ['issue', 'cycle', 'approvals', 'votes'],
  /** Planning failed on every candidate provider. */
  'plan.failed': ['issue', 'error'],
  /** The cycles ran out without consensus; the unresolved objections are a human's to settle. */
  'plan.escalated': ['issue', 'cycles', 'unresolved'],

  /** A worker was launched in its own worktree. Carries the whole dispatch record plus the command that ran. */
  'worker.dispatched': ['issue', 'worktree', 'worktreeId', 'branch', 'terminal', 'provider', 'model', 'contractDigest', 'briefDigest', 'command', 'briefAccepted', 'tuiIdle'],
  /** The dispatch itself failed — worktree, terminal or brief — before any work started. */
  'worker.dispatch-failed': ['issue', 'error'],
  /** `project.setup.command` ran in the fresh worktree. */
  'worker.setup': ['issue', 'worktreeId', 'ok'],
  /**
   * An idle worker was nudged in its own terminal — and also the terminal outcome `nudged`, which ends a delivery
   * pass on the same issue. Two emissions, one name: `kind` is present on the first, `reason` on the second.
   */
  'worker.nudged': ['issue', 'kind', 'reason', 'worktreeId'],
  /** A stale terminal was relaunched for a worker that was still supposed to be working. */
  'worker.reactivated': ['issue', 'terminal', 'previousTerminal'],
  /** A finished issue came back: a new head on a PR the loop had already closed out. */
  'worker.reopened': ['issue', 'pr', 'previousHead', 'head', 'previousOutcome'],
  /**
   * The task was handed to another provider in the same worktree, on the same branch — and also the terminal
   * outcome `handed-off` that ends the delivery pass which did it.
   */
  'worker.handed-off': ['issue', 'from', 'to', 'worktreeId', 'branch', 'reason', 'briefAccepted'],

  /** CI is red; the failing checks went back to the worker as a fix round. */
  'worker.ci-round': ['issue', 'pr', 'head', 'round'],
  /** The review found blocking issues; the findings went back to the worker as a fix round. */
  'worker.review-round': ['issue', 'pr', 'head', 'round'],
  /** The PR conflicts with the base branch; the rebase instruction went back to the worker. It costs no fix round. */
  'worker.conflict-round': ['issue', 'pr', 'head', 'round'],

  /** Delivery finished for this issue, with the outcome that closed it. One per terminal outcome. */
  'worker.merged': ['issue', 'reason', 'worktreeId'],
  'worker.held': ['issue', 'reason', 'worktreeId'],
  'worker.blocked': ['issue', 'reason', 'worktreeId'],
  'worker.stuck': ['issue', 'reason', 'worktreeId'],
  'worker.abandoned': ['issue', 'reason', 'worktreeId'],
  'worker.failed': ['issue', 'reason', 'worktreeId'],
  'worker.waiting': ['issue', 'reason', 'worktreeId'],
  'worker.reviewed': ['issue', 'reason', 'worktreeId'],
  'worker.fix-round': ['issue', 'reason', 'worktreeId'],

  /** A review ran against a PR, with the verdict and who gave it. `source` marks a PR that came from GitHub intake. */
  'pr.reviewed': ['issue', 'pr', 'head', 'status', 'blocking', 'provider', 'model', 'source'],
  /** The PR was squash-merged by the loop. */
  'pr.merged': ['issue', 'pr', 'head', 'sha'],
  /** GitHub refused the merge — branch protection, a required check, a race with another merge. */
  'pr.merge-refused': ['issue', 'pr', 'head', 'message'],
  /** The optional post-merge smoke failed. */
  'pr.smoke-failed': ['issue', 'pr', 'head', 'detail'],

  /** A PR the loop did not dispatch, adopted through GitHub intake, reached a terminal outcome. */
  'github-intake.merged': ['pr', 'reason'],
  'github-intake.held': ['pr', 'reason'],
  'github-intake.blocked': ['pr', 'reason'],
  'github-intake.failed': ['pr', 'reason'],
  'github-intake.stuck': ['pr', 'reason'],
  'github-intake.abandoned': ['pr', 'reason'],
  'github-intake.waiting': ['pr', 'reason'],
  'github-intake.reviewed': ['pr', 'reason'],
  'github-intake.fix-round': ['pr', 'reason'],
  'github-intake.nudged': ['pr', 'reason'],
  'github-intake.handed-off': ['pr', 'reason'],

  /** A batch is on the integration branch with nobody's approval behind it. Emitted once per head. */
  'release.waiting': ['head', 'branch', 'commits', 'issues', 'detail'],
  /** The approved batch reached the release branch. */
  'release.promoted': ['head', 'branch', 'commits', 'issues', 'approvedBy'],
  /** The deploy command succeeded. */
  'release.deployed': ['head', 'branch'],
  /** Promotion or deploy failed; `phase` says which. */
  'release.failed': ['head', 'phase', 'detail'],
  /** The post-deploy smoke failed. */
  'release.smoke-failed': ['head', 'detail'],
  /** The rollback ran after a failed smoke; `ok` says whether it worked. */
  'release.rolled-back': ['head', 'ok', 'detail'],

  /** An external alert became a tracked issue. */
  'intake.filed': ['issue', 'source', 'fingerprint', 'severity'],
  /** A maintenance check became a tracked issue. */
  'maintain.filed': ['issue', 'check', 'fingerprint'],

  /** Approved memory was recalled into a prompt, with what it cost and what it saved. */
  'memory.recalled': ['issue', 'hits', 'docBridgeBefore', 'docBridgeAfter', 'approxCharsSaved', 'memoryDigest'],
  /** Learnings the retro promoted into memory without a human in the middle (`memory.autoPromote`). */
  'memory.auto-promoted': ['ids', 'remembered', 'digest'],
  /** The automatic promotion itself failed; the learnings stay in the ledger. */
  'memory.auto-promote-failed': ['error'],

  /** A provider was put on cooldown after a quota/auth/timeout failure. `source` names the caller when not a dispatch. */
  'provider.cooldown': ['provider', 'kind', 'until', 'source'],
  /** The tracker refused the claim that reserves an issue for this loop. */
  'queue.claim-failed': ['issue', 'assignee', 'error'],
  /** Text that looks like PII was found before it reached a model. */
  'security.pii-detected': ['issue', 'source', 'kinds', 'count'],
  /** An issue was paused after consecutive failures; it needs a human before it is tried again. */
  'issue.paused': ['issue', 'kind', 'consecutive', 'reason'],
  /** A whole stage was paused after consecutive failures. */
  'stage.paused': ['stage', 'reason', 'consecutiveFailures'],

  /** The retro's agent-improvement pass reached a verdict for one role's installed agent. */
  'agent.adopted': ['role', 'agent', 'detail'],
  'agent.rejected': ['role', 'agent', 'detail'],
  'agent.needs-human': ['role', 'agent', 'detail'],
  'agent.reverted': ['role', 'agent', 'detail'],

  /** A tuning knob moved by itself after a retro, inside its declared range and justified by its declared metric. */
  'tuning.applied': ['path', 'from', 'to', 'metric', 'reason'],
  /** The same knob moved back, because the metric that justified the change got worse. */
  'tuning.reverted': ['path', 'from', 'to', 'metric', 'reason'],

  /** The cost circuit breaker stopped a dispatch that burned more usage than `resilience.maxUsageDeltaPercent` allows. */
  'cost-guard.tripped': ['issue', 'reason'],
  /** The time circuit breaker stopped a dispatch older than `delivery.maxDispatchMinutes`. */
  'max-duration.tripped': ['issue', 'reason'],
} as const satisfies Readonly<Record<string, readonly string[]>>

export type LoopEventType = keyof typeof LOOP_EVENT_TYPES

/** Whether a string is an event the loop declares. Used where a name arrives as data (a config list, a CLI flag). */
export const isLoopEventType = (value: string): value is LoopEventType => value in LOOP_EVENT_TYPES

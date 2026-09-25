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
  /** A structured human decision was requested by an LLM stage. */
  'human.hitl-requested': ['issue', 'requestId', 'batchId', 'role', 'stage', 'question', 'context', 'options', 'recommendedOptionId', 'digest'],
  /** A human answered one structured HITL request. */
  'human.hitl-answered': ['issue', 'requestId', 'batchId', 'role', 'stage', 'optionId', 'freeText', 'digest', 'actor'],
  /** All requests in a structured HITL batch have answers and the stage may resume. */
  'human.hitl-batch-ready': ['issue', 'batchId', 'requestId'],
  /** Contract generation failed on every candidate provider. */
  'contract.failed': ['issue', 'error'],
  /** A contract was frozen successfully. `provider`/`model`/`effort` are what actually produced it — the join key
   * for comparing how different LLMs (at what reasoning effort) did on the same kind of issue. */
  'contract.generated': ['issue', 'provider', 'model', 'effort', 'digest'],

  /** One planning cycle finished: how many agents approved the plan, out of how many voted, and who each one was. */
  'plan.voted': ['issue', 'cycle', 'approvals', 'votes', 'voters'],
  /** Planning failed on every candidate provider. */
  'plan.failed': ['issue', 'error'],
  /** The cycles ran out without consensus; the unresolved objections are a human's to settle. */
  'plan.escalated': ['issue', 'cycles', 'unresolved'],

  /** A worker was launched in its own worktree. Carries the whole dispatch record plus the command that ran. */
  'worker.dispatched': ['issue', 'worktree', 'worktreeId', 'branch', 'terminal', 'provider', 'model', 'effort', 'contractDigest', 'briefDigest', 'command', 'briefAccepted', 'tuiIdle', 'workerGuardInstalled'],
  /** The dispatch itself failed — worktree, terminal or brief — before any work started. */
  'worker.dispatch-failed': ['issue', 'error'],
  /** `project.setup.command` ran in the fresh worktree. */
  'worker.setup': ['issue', 'worktreeId', 'ok'],
  /**
   * An idle worker was nudged in its own terminal — and also the terminal outcome `nudged`, which ends a delivery
   * pass on the same issue. Two emissions, one name: `kind` is present on the first, `reason` on the second.
   */
  'worker.nudged': ['issue', 'kind', 'reason', 'worktreeId'],
  /** The worker stopped at a tool-permission prompt: held for a person, never typed into. Once per idle window. */
  'worker.permission-wait': ['issue', 'terminal', 'reason'],
  /** A stale terminal was relaunched for a worker that was still supposed to be working. */
  'worker.reactivated': ['issue', 'terminal', 'previousTerminal'],
  /** A human answered a worker HITL request and the decision was sent back to the worker terminal. */
  'worker.hitl-resumed': ['issue', 'requestIds'],
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

  /** Delivery finished for this issue: the pull request was merged and the issue closed out. */
  'worker.merged': ['issue', 'reason', 'worktreeId'],
  /** Held for a human: protected paths, a secret-shaped file, a crossed layer boundary, or a gate the config demands. */
  'worker.held': ['issue', 'reason', 'worktreeId'],
  /** Blocked: the fix rounds ran out, or a circuit breaker stopped the dispatch. */
  'worker.blocked': ['issue', 'reason', 'worktreeId'],
  /** The worker stopped producing output for longer than the idle timeout and could not be revived. */
  'worker.stuck': ['issue', 'reason', 'worktreeId'],
  /** The pull request was closed without merging, or the branch disappeared. */
  'worker.abandoned': ['issue', 'reason', 'worktreeId'],
  /** The delivery pass itself failed - a tool, a credential, an unexpected state. */
  'worker.failed': ['issue', 'reason', 'worktreeId'],
  /** Nothing to do at this head: the pass ended waiting for CI, a push, or a human. */
  'worker.waiting': ['issue', 'reason', 'worktreeId'],
  /** The review ran and the pass ended there, without merging. */
  'worker.reviewed': ['issue', 'reason', 'worktreeId'],
  /** The pass ended by sending the worker back to work. */
  'worker.fix-round': ['issue', 'reason', 'worktreeId'],
  /** A structured human decision stopped delivery without turning it into a technical failure. */
  'worker.needs-input': ['issue', 'reason', 'worktreeId'],

  /** A review ran against a PR, with the verdict, who gave it, how it was configured (profile/votes/severity
   * floor) and what it cost (`calls`/token fields, from `agentskit-review`'s own usage tracking) — what a study
   * comparing review thoroughness and spend across models needs. `source` marks a PR that came from GitHub intake. */
  'pr.reviewed': ['issue', 'pr', 'head', 'status', 'blocking', 'provider', 'model', 'profile', 'votes', 'minSeverity', 'source', 'calls', 'inputTokens', 'outputTokens', 'totalTokens'],
  /** The PR was squash-merged by the loop. */
  'pr.merged': ['issue', 'pr', 'head', 'sha'],
  /** A tracked PR closed without merge; the issue waits for a close-or-reopen decision. */
  'pr.closed': ['issue', 'pr', 'head', 'reason'],
  /** A remote tracker write failed; local lifecycle remains authoritative until a human retries synchronization. */
  'tracker.sync-failed': ['issue', 'operation', 'error'],
  /** GitHub refused the merge — branch protection, a required check, a race with another merge. */
  'pr.merge-refused': ['issue', 'pr', 'head', 'message'],
  /** A person attested a PR held for protected paths, for exactly this head. */
  'pr.human-approved': ['issue', 'head', 'by', 'pr'],
  /** The optional post-merge smoke failed. */
  'pr.smoke-failed': ['issue', 'pr', 'head', 'detail'],

  /** A PR the loop did not dispatch, adopted through GitHub intake, reached a terminal outcome. */
  /** Merged by the loop. */
  'github-intake.merged': ['pr', 'reason'],
  /** Held for a human. */
  'github-intake.held': ['pr', 'reason'],
  /** Out of fix rounds. */
  'github-intake.blocked': ['pr', 'reason'],
  /** The pass over it failed. */
  'github-intake.failed': ['pr', 'reason'],
  /** It stopped moving. */
  'github-intake.stuck': ['pr', 'reason'],
  /** Closed without merging. */
  'github-intake.abandoned': ['pr', 'reason'],
  /** Nothing to do at this head. */
  'github-intake.waiting': ['pr', 'reason'],
  /** Reviewed without merging. */
  'github-intake.reviewed': ['pr', 'reason'],
  /** Sent back to its author. */
  'github-intake.fix-round': ['pr', 'reason'],
  /** Its author was nudged. */
  'github-intake.nudged': ['pr', 'reason'],
  /** It changed hands. */
  'github-intake.handed-off': ['pr', 'reason'],
  /** An external review requested a structured human decision. */
  'github-intake.needs-input': ['pr', 'reason'],

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
  /** One scheduled stage run finished — the entrypoint every scheduler (cron, Orca) calls, so this is the one
   * event that always exists regardless of what the stage itself did. */
  'stage.completed': ['stage', 'durationMs', 'status', 'count'],
  /** `loop.config.yaml` changed since the last stage run; `from`/`to` are its digest before and after. */
  'config.changed': ['from', 'to'],

  /** The retro's agent-improvement pass adopted a dated note into the agent's instructions; the eval passed. */
  'agent.adopted': ['role', 'agent', 'detail'],
  /** Nothing was adopted: no installed agent for the role, or nothing to measure the change with. */
  'agent.rejected': ['role', 'agent', 'detail'],
  /** A proposal was recorded for a human: a critical role, too many lines, or an agent that is code. */
  'agent.needs-human': ['role', 'agent', 'detail'],
  /** The change was applied, the eval did not pass, and the file was put back exactly as it was. */
  'agent.reverted': ['role', 'agent', 'detail'],

  /** A tuning knob moved by itself after a retro, inside its declared range and justified by its declared metric. */
  'tuning.applied': ['path', 'from', 'to', 'metric', 'reason'],
  /** The same knob moved back, because the metric that justified the change got worse. */
  'tuning.reverted': ['path', 'from', 'to', 'metric', 'reason'],

  /** The cost circuit breaker stopped a dispatch that burned more usage than `resilience.maxUsageDeltaPercent` allows. */
  'cost-guard.tripped': ['issue', 'reason'],
  /** The time circuit breaker stopped a dispatch older than `delivery.maxDispatchMinutes`. */
  'max-duration.tripped': ['issue', 'reason'],

  /**
   * One call the harness itself made to a provider CLI (contract, review, plan vote — never the worker's own
   * dispatched session, which stays opaque). Always carries timing/size; `providerCalls`/token fields are present
   * only when the caller could parse them out of that call's own structured result.
   */
  'provider.call': ['role', 'provider', 'model', 'effort', 'issue', 'durationMs', 'exitCode', 'timedOut', 'stdoutBytes', 'stderrBytes'],
  /** How much of a provider's usage window moved for one in-flight issue since its dispatch — logged on every
   * `deliver` pass regardless of whether it crosses `resilience.maxUsageDeltaPercent`, so the trend is visible
   * before it ever trips the breaker. */
  'provider.usage-observed': ['issue', 'provider', 'initialRemainingPercent', 'currentRemainingPercent', 'deltaPercent'],

  /** The definition of done was judged for a PR: how many of its lines were proven, missing, or failing. */
  'dod.assessed': ['issue', 'pr', 'head', 'complete', 'proven', 'missing', 'failed'],
  /** The project's own `delivery.verify.argv` passed before a review was even requested. */
  'verify.passed': ['issue', 'pr', 'head'],

  /**
   * A fresh attempt is queued through the control plane — the wizard's confirm, or a retry. `queue.ts` is the
   * authoritative record of the attempt itself (read live by `store.ts`, and by `tick.ts` for
   * `queue.mode: explicit`); this event only carries the phase signal nothing else emits before a dispatch
   * happens: "an operator just asked for this."
   */
  'ui.run-enqueued': ['issue'],
  /** Cancellation cleanup (terminal, worktree, lease, tracker state) finished for a run. */
  'ui.cleanup-completed': ['issue', 'runId'],
  /** Cancellation cleanup failed partway; the run is held for a human to inspect. */
  'ui.cleanup-failed': ['issue', 'runId', 'detail'],
  /** A human resolved a `needs-decision` issue (a PR closed without merge): close it for good, or reopen it for
   * a fresh run. The only decision type in the control plane that isn't a structured HITL question — there is
   * nothing to ask the LLM, the tracker state already says what happened. */
  'ui.issue-decided': ['issue', 'action'],
} as const satisfies Readonly<Record<string, readonly string[]>>

export type LoopEventType = keyof typeof LOOP_EVENT_TYPES

/** Whether a string is an event the loop declares. Used where a name arrives as data (a config list, a CLI flag). */
export const isLoopEventType = (value: string): value is LoopEventType => value in LOOP_EVENT_TYPES

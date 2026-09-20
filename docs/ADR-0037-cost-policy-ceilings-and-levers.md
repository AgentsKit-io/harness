# ADR-0037: Cost — the routing policy, the ceilings, and the levers

## Status

Accepted

## Context

The loop cannot count what a worker's CLI spends: each worker is an opaque session,
and its own model and tool calls never reach the harness. Every cost control here is
therefore about what the harness *can* decide — who it calls, how often, with how
much context — plus circuit breakers on the signals it can actually observe.

## Decision

**The policy chooses among the candidates a role already allows; it never widens the
set.** `models.routing.policy` orders them: `quality-first` (the best available, with
failover), `usage-balanced` (spread by remaining window), `cost-first` (the cheapest
the role can still use — from `models.cost` when declared, otherwise the last tier,
which is where a config already puts its cheap last resort).

**Ceilings, all of them refusals rather than degradations:**

- `budget.perProvider` — leave the rest of a shared window for the human who shares it.
- `budget.perIssueTokens` — exceeding it escalates. An issue that has spent its
  ceiling gets a human, not another attempt with less headroom.
- `delivery.maxDispatchMinutes` and `resilience.maxUsageDeltaPercent` — the time and
  cost circuit breakers for a runaway worker, both escalating in the shape of a stuck
  worker: worktree preserved, lease released, issue returned.
- `delivery.review.maxCalls` and the review deadline — the reviewer is the most
  frequently called role; it is also the easiest to spend without noticing.

**The levers, which are about what gets sent rather than to whom:**

1. **The cheap check before the expensive one.** `delivery.verify.argv` runs before
   the review: a build that does not compile does not deserve a two-vote review. A
   layer's own test (`layers[].verify`) closes an issue that belongs to a layer,
   instead of the whole suite.
2. **The model matched to the change.** `modelForChange` picks a smaller reviewer for
   a small change outside `delivery.review.criticalPaths`, and the report says why it
   chose what it chose.
3. **A cacheable prefix.** The worker brief and the contract prompt open with
   everything invariant for the repository and close with the issue, so two issues
   share the head of the prompt byte for byte. A test asserts a minimum shared prefix:
   without it, the ordering is decoration that the next edit silently undoes.
4. **Delta instead of repetition.** Context a worker already has is referenced by
   digest — a handoff points at a pinned skill whose file still hashes to the record
   instead of copying it, and a fix round carries a one-line anchor. The rule is
   deliberately asymmetric: when the digest does not match, the whole block is sent
   again. A worker without its context is worse than a worker that costs more.
5. **The flow decides what runs at all.** `flows.profiles.<name>` switches phases off
   (`stages`) and names who runs each role (`roles`), so an incident flow and the
   critical path can share one motor without sharing one bill.

**What this ADR does not claim.** There is no token accounting inside a worker
session, so `budget.perIssueTokens` counts what the harness itself spent, not what
the worker's CLI did. Prompt caching is an ordering the harness can offer; whether a
provider honours it is the provider's business and is not measured here. And the
memory backend is still the file adapter — its `recall` is a substring scan with a
fixed relevance, so `memory.maxRecall` means "the first N records containing the
token", not "the N most relevant". An SQLite/FTS5 backend was designed and
deliberately left out of 0.15.0; until it lands, this ADR records the limitation
rather than implying a ranking that does not exist.

## Consequences

Cost is configuration, not a rewrite: a project changes a policy, a ceiling or a flow
profile. Every refusal is loud — an escalation with a reason, never a silent
downgrade to a cheaper model on a critical path. The levers that were measured have
tests that keep them; the ones that were not are named above as not done.

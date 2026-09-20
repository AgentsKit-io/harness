# ADR-0019: Record human decisions as attested lifecycle events

## Context

The verification result is now attested before approval, but the approval and
tracking authorization themselves only existed in the mutable `run.json`
projection. An audit consumer could see that a run reached `COMPLETE` without
an immutable record of which human decision accepted the exact evidence.

## Decision

Record `approval.recorded` and `authorization.recorded` events in the existing
hash-chained lifecycle log. Each event contains the decision, resulting state,
verification digest, source revision, contract hash, and human actor; tracking
authorization also contains its declared target. Rejections are recorded too,
so every human terminal decision is auditable. The default tracking mode is
goal-scoped: one human approval covers the declared tracking effect and emits
both events. A project may set `tracking.authorization: "separate"` when an
independent tracking decision is required.

The existing freshness and verification-attestation checks run before either
decision is accepted. The `run.json` fields remain a convenient projection,
but the event is the audit record.

## Amendment 2026-09-19: learning promotion may be automated, attested as such

`promoteLearnings` refused any actor that was not `human`, which made memory
promotion a manual step for every recurring lesson. The rule it was protecting is
real — memory is injected into every worker brief, so a wrong lesson becomes a
wrong instruction on every future task — but it was enforced by forbidding the
actor rather than by bounding the decision.

Automated promotion is now allowed under three bounds, and only when a project
opts in with `memory.autoPromote.enabled`:

1. **Recurrence, not novelty.** The same lesson must have been proposed at least
   `memory.recurrence.minSightings` times. A lesson seen once cannot promote.
2. **A cap per run**, `memory.recurrence.maxPerRun`, so one bad retro cannot
   flood the store.
3. **Only the configured categories** (`memory.categories`, `adjustment` by
   default) — process tweaks, not claims about the product.

The actor is recorded as `loop-auto`, never as `human`. That distinction is the
point of the amendment: the attestation stays truthful about who decided, so an
auditor can list every automatically promoted lesson and a human can revoke any
of them. A promotion is still a decision with a name attached; it is no longer
required to be a person's.

What remains human-only: approving a verification result and authorizing an
external tracking effect. Those act on the world. Promoting a lesson acts on the
next brief, and is reversible by rejecting the record.

## Consequences

Consumers can independently prove which verified result was approved and which
external tracking target was authorized. Humans do not need to copy a run ID or
digest: approval commands resolve the latest pending run, while the identifiers
remain in the audit record. Legacy logs remain readable and are reported as
legacy until they contain the new hashed event protocol. This is an audit
attestation, not a digital signature or external notarization.

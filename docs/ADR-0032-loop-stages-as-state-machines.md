# ADR-0032: Stages as state machines

## Status

Accepted

## Context

The loop started as two scheduled passes, `tick` and `deliver`. Planning, health
scanning, release promotion, alert intake and maintenance arrived afterwards, and
each of them could have been written as "ask a model what to do next". That shape
fails the same way every time: the model decides the transition, so the same state
produces different behaviour on two runs, and nobody can say afterwards why.

## Decision

Every stage is a state machine the harness runs. A model may produce content — a
contract, a plan, a vote, a review, an alert triage — but **the machine reads that
content and decides the transition**. The stages are:

- `tick` — queue → contract → (plan → vote) → dispatch.
- `deliver` — PR → checks → verify → review → definition of done → merge.
- `plan` — objective → interview → PRD → design → vote → issues, with two human gates.
- `observe` — read-only anomaly scan; its exit code is the only one that is a decision.
- `release` — batch → human approval bound to a head sha → promote → deploy → smoke → rollback.
- `intake` / `maintain` — alerts and checks become tracked issues, deduplicated by fingerprint.

A stage runs inside Orca's `--precheck` command and exits 1 so the run is recorded
without launching an agent session (`observe` exits 0 when a human has to look).
Every transition writes a declared event (ADR-0030, and the vocabulary in
`src/loop/event-vocabulary.ts`), so the path a run took is reconstructable from the
event log alone.

## Consequences

A stage is testable without a model: given state, assert the transition. Adding a
phase means adding a state and its event, not a new prompt. The cost is that the
harness carries the decision logic instead of delegating it, and that every new
transition has to be named — which is the point: an unnamed transition is one
nobody can subscribe to, gate, or explain.

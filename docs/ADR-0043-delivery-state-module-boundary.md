# ADR-0043: Delivery state module boundary

**Status:** Accepted

## Context

`src/loop/deliver.ts` combines the delivery state machine with persisted delivery
state and dispatch inventory helpers used across the loop and UI. The state
helpers form a cohesive file-backed API with higher fan-in than the state
machine itself.

## Decision

Move delivery state types, state read/write helpers, dispatch inventory, and
restart bookkeeping into `src/loop/deliver-state.ts`. Keep the existing exports
from `src/loop/deliver.ts` as re-exports so callers and the public API stay
stable.

## Consequences

Persistent state operations can be reviewed and tested independently from
delivery orchestration. The move does not change serialized formats or runtime
behavior; future changes to either module still need the loop and package
checks.

# ADR-0030: Loop event bus and orchestration hooks, not model-loop middleware

- Status: Accepted
- Date: 2026-09-12

## Context

Comparing the loop against frameworks that build a "custom agent harness" in-process (e.g. LangChain's
`create_agent` + middleware: hooks before/after every model call and every tool call) surfaced a real gap: this
harness had no deterministic extension point at all. `appendLoopEvent` (`src/loop/tick.ts`) only appends to
`<stateDir>/events.ndjson` — nothing can react in real time, and nothing can say "stop, don't do this" before a
consequential action.

The gap is real, but the shape of the fix is not "add middleware like LangChain's": this harness orchestrates
external CLI agents (claude/codex/grok) as opaque processes inside an Orca worktree. There is no in-process
model↔tool loop to hook into — the worker's own context window, its own tool calls, are invisible to us by design
(ADR-0027). Building a `before model call` hook here is not possible without controlling that loop, which is
explicitly out of scope.

What we *do* control, end to end, is the orchestration around that opaque worker: whether we dispatch it, whether
we act on its review, whether we merge its PR. That is the level at which a deterministic extension point is both
useful and achievable.

## Decision

1. **`src/loop/event-bus.ts`** (Composition): a local, in-process pub/sub over the loop's existing free-form event
   vocabulary (`contract.failed`, `worker.dispatched`, `pr.reviewed`, …) plus a small, fixed set of **orchestration
   lifecycle hooks**: `beforeDispatch`, `afterDispatch`, `beforeReview`, `afterReview`, `beforeMerge`, `afterMerge`,
   `onPause`, `onEscalate`. A `before*` hook may return `{ block: true, reason }` to stop the action; every other
   hook is notification-only. A listener or hook that throws is swallowed (logged as a note, never fatal) — a
   broken local plugin must not take down tick or deliver.
2. **Not `kernel/plugins.ts`.** The kernel's plugin registry is tied to `HARNESS_EVENT_TYPES`, the harness's own
   run-lifecycle vocabulary, and carries plugin ids/versions/dependency ordering appropriate for a shared kernel
   contract. The loop's event vocabulary is an open set of strings owned by composition, not the kernel, so
   `event-bus.ts` is a separate, simpler primitive with the same "who's listening" ergonomics rather than a reuse
   of that contract.
3. **`plugins.modules`** (`loop.config.yaml`): local `.mjs` files, relative to `project.root`, loaded once at the
   start of `tick`/`deliver`. Same trust level as `agents.registry.yaml` today — files already checked into the
   project's own repo, never fetched over a network. Each module exports `{ id, apply(bus) }`.
4. **`appendLoopEvent` gains an optional third `bus` parameter.** Every existing call site (`retro.ts`, tests) is
   unaffected; `tick.ts`/`deliver.ts` pass their bus so every event written to disk is also emitted live.
5. **`loop doctor` gains a `plugins.modules` check** using the same `loadLoopPlugins` the runtime uses, so a typo
   or a broken module surfaces before a tick silently drops a plugin.

## Consequences

- No kernel change; `pnpm test:boundaries` stays green.
- `loop.config.yaml` gains one new block (`plugins: { modules: [] }`), empty by default — zero behavior change for
  every existing config.
- This directly enables the human-approval gate (`delivery.merge.requireHumanApproval`, ADR follow-up in the same
  release) and the PII-scan wiring as bus consumers, without a bespoke mechanism for each.
- Explicitly **not** delivered: hooking into the worker's own model/tool loop (structural — the worker is an
  opaque CLI), a distributed/external event bus (webhook, message broker) as a first consumer, and dynamic module
  loading from anywhere other than the local repo.

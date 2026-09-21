# ADR-0036: Bounded self-modification

## Status

Accepted

## Context

A loop that runs unattended for weeks accumulates evidence about itself: the same
lesson proposed over and over, a knob that is plainly set wrong, a role whose runs
cost more fix rounds than the others. Doing nothing with that evidence wastes it.
Letting the loop act on it freely is how an autonomous system drifts away from what
its owners agreed to, one defensible step at a time.

## Decision

The loop may change three things about itself, each inside declared bounds, and
nothing else.

**1. Promoting a learning (`memory.autoPromote`).** A lesson proposed
`recurrence.minSightings` times stops being an anecdote. With auto-promotion on, the
retro promotes it itself, attributed to **`loop-auto`** — never to `human`
(ADR-0019, amendment of 2026-09-19) — at most `recurrence.maxPerRun` per run. Off by
default. Every automatic promotion stays listable and revocable, and the attribution
is what makes that possible: a memory record nobody can tell apart from a human's is
a record nobody can safely revoke.

**2. Moving a knob (`tuning`).** A knob is auto-adjustable only when it declares the
**metric that justifies moving it** — and that same metric is what moves it back when
the next cycle is worse. At most `maxChangesPerRetro` move per retro, inside the
declared range or ladder, so a bad cycle changes one thing and stays explainable.
Never auto-adjustable, whatever the config says: models, providers, gates and
branches — the things that decide who pays and what reaches production.

**3. Improving an installed agent (`agents.autoImprove`).** The retro may append one
dated note to the instructions of an agent this project installed under `agents/<id>/`,
and **only if the eval still passes**. The bar is "not worse", not "better": a change
that leaves the score alone but makes the agent clearer is worth keeping, and a change
that cannot be measured is never adopted (`agents.evalCommand` empty ⇒ nothing is
adopted). A failing eval puts the file back exactly as it was — an agent left
half-improved is worse than one never touched. Three things the machine never does:
touch a critical role (`architect`, `reviewer`), write more than `agents.maxAutoLines`
lines, or publish anything back to the registry. An agent installed as code gets a
recorded proposal for a human instead of an edit (ADR-0036 is implemented in
`src/loop/agent-improvement.ts`).

## Consequences

Every self-modification is attributable, bounded, measured and revocable, and each
one is off by default — turning it on is the project's decision, made once, in a file
a reviewer reads. The cost is that the loop improves slowly and only where a metric
exists. That is the intended trade: an unattended system that can change anything
about itself is not a loop, it is a liability.

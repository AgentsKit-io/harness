## What

What changed?

## Why

What problem does this solve?

## How

How does it work? Note relevant design choices.

## Contract

- Issue/task:
- Intended change:
- In scope:
- Out of scope:

## Validation

- Acceptance criteria and their contract or edge-case tests:
- The repository's documented gates run on this commit:
- Generated artifacts regenerated with the official tools, if applicable:

- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm build`
- [ ] `pnpm pack --pack-destination /tmp/agentskit-harness-pack`
- [ ] Narrow `test:*` script for each touched criterion (see AGENTS.md `scope:`)
- [ ] Closing PR only: `ak-verify run --config .ak-harness/verification.json --json`

Verification run ID (closing PR only):

## Definition of Done

- [ ] One package, or one isolated cross-cutting gate change, per PR.
- [ ] Each acceptance criterion has contract or edge-case test evidence.
- [ ] The documented gates pass on this commit.
- [ ] Measure size when a bundle or export changes; add or update JSDoc when a public API changes.
- [ ] Required changeset and documentation updates are included.
- [ ] No tests were disabled to pass checks.
- [ ] Generated artifacts were regenerated with official tools, when applicable.

## Reuse

- Existing ecosystem package or module checked:
- Established library or service considered:
- Why new code or a new dependency is needed (or "none added"):

## Risk and compatibility

- Public API or CLI changed: yes/no
- State-machine or enforcement behavior changed: yes/no
- Breaking change: yes/no
- Documentation/ADR updated when needed: yes/no

## Review focus

Call out the exact gate, invariant, or recovery path that reviewers should
challenge. Do not mark a PR complete when evidence is missing or stale.

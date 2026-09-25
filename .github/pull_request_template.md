## Contract

- Issue/task:
- Intended change:
- In scope:
- Out of scope:

## Evidence

- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm build`
- [ ] `pnpm pack --pack-destination /tmp/agentskit-harness-pack`
- [ ] Narrow `test:*` script for each touched criterion (see AGENTS.md `scope:`)
- [ ] Closing PR only: `ak-verify run --config .ak-harness/verification.json --json`

Verification run ID (closing PR only):

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

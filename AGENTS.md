# AGENTS.md

## Mission

This repository owns the deterministic SDLC enforcement engine published as
`@agentskit/harness`. The Playbook documents practices; the Harness enforces
contracts, gates, state transitions, evidence, and recovery.

## Before changing code

1. Read the issue or task contract and identify its acceptance criteria.
2. Run `pnpm ak-harness doctor --json` when the CLI is available.
3. Keep public API changes explicit in `src/index.ts`.
4. Add criterion-level tests before declaring behavior complete.

## Boundaries

- `src/index.ts`: supported public API only.
- `src/cli.ts`: `ak-harness` and `ak-verify` command surface.
- `src/adapters/`: optional integrations; adapters must not weaken kernel gates.
- `src/*.ts`: capability modules for contracts, evidence, delivery, runtime,
  optimization, and metrics. Keep modules small and capability-oriented.
- `test/`: deterministic unit and contract tests; real CLI checks live in
  `scripts/`.
- `docs/`: ADRs and protocol decisions.

The package is provider-neutral. Do not add direct dependencies on Linear,
GitHub, Orca, Doc Bridge, or a model provider to the kernel.

## Enforcement rules

- Required gates fail closed with a non-zero exit code.
- Missing evidence is not success.
- Ambiguities and business decisions remain human decisions.
- YOLO mode may skip generic review only when the frozen contract permits it;
  it never bypasses material blockers or approvals.
- Never auto-commit residue, expose broad credentials, or approve own output.

## Verification contract

Run the repository contract before reporting completion:

```bash
ak-verify run --config .codex/verification.json --json
```

The run ID and criterion-level evidence belong in the change report. A failed,
stale, blocked, or approval-pending run is not complete.

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

## Coding style — ponytail

Default to the laziest correct solution, in this order: necessity (YAGNI) → reuse
existing code → stdlib → native platform features → an already-installed
dependency → a one-liner → minimum new code. No unrequested abstractions
(interfaces/factories for a single implementation). Deletion beats addition.
Mark an intentional shortcut with a one-line `ponytail: <fact>; <consequence>.`
comment instead of building it out "properly" now — see
[DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) for the
full ladder. This repo already uses the convention (`src/execution/verification.ts`,
`src/loop/deliver.ts`, `src/loop/doctor.ts`); keep it going.

## Output style — caveman

Commit messages, PR bodies, and review replies are technical and short: state the
change and the reason, skip the narration. If the explanation is longer than the
diff it explains, cut the explanation, not the diff. See
[caveman](https://github.com/JuliusBrussee/caveman) (`caveman-commit`,
`caveman-review`) for the full style.

## Local tooling — rtk

Install [rtk](https://github.com/rtk-ai/rtk) globally (`rtk init -g`) before
working in this repo. It rewrites shell commands (test runs, builds, `git`, `gh`)
through a hook and compresses their output 60-90% before it reaches your context —
same commands, a fraction of the tokens. Nothing in the repo depends on it; it only
makes long sessions in a large monorepo cheaper.

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
ak-verify run --config .ak-harness/verification.json --json
```

The run ID and criterion-level evidence belong in the change report. A failed,
stale, blocked, or approval-pending run is not complete.

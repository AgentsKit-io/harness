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

## Reuse first

Before adding a package or dependency, check existing AgentsKit ecosystem
packages first, then established libraries or services. Write new code only
when neither fits, and justify it in the PR's **Reuse** section.

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

**scope:** a task carries an explicit scope; the check it needs, not the full
gate. Most changes touch one criterion — run its narrow script directly
(`pnpm test:boundaries`, `pnpm vitest run test/loop-deliver.test.ts`, etc.; see
`package.json` for the full `test:*` list). Those scripts and the contract's
criteria are **not** one-to-one and this file used to claim they were: there are
47 `test:*` scripts emitting 82 criteria names against 18 outcomes / 22 checks
in `.ak-harness/verification.json`, and 12 of those outcomes have no script that
emits them. Pick the script that covers what you touched; the mapping is a
judgement call, not a lookup. Only the PR that closes an issue runs the complete
contract:

```bash
ak-verify run --config .ak-harness/verification.json --json
```

The run ID and criterion-level evidence belong in the change report. A failed,
stale, blocked, or approval-pending run is not complete. "Before reporting
completion" above means before the PR is ready to merge, not after every edit —
running the full 22-check gate on every iteration is the single largest source
of wasted time and tokens in this repository; do not do it by default.

## House conventions

Five one-line, checkable rules, each named after the waste it stops. Applying
one is preferred to writing a paragraph explaining the same judgment call:

- **`digest:`** — content repeated across calls (skills, contract, plan, PRD) is
  referenced by hash, never resent whole unless the hash changed.
- **`windowed:`** — no function reads an append-only log/history store without a
  time or count bound (`sinceMs`, `keep: N`). An unbounded read gets slower
  every week the loop runs; that is a bug, not a style preference.
- **`scope:`** — see above: a task's verification is the criterion it touches,
  not the whole contract.
- **`cheapest-sufficient:`** — a role's default model quality matches the
  difficulty of what that role actually does, not tradition. The role writing
  the code is never given a weaker default than the role only reading it.
- **`one-shot-vote:`** — prefer one call asking for N structured perspectives
  over N separate full calls, unless the provider genuinely cannot return
  structured multi-perspective output in one call.

---

type: package
package: harness-core
editRoot: src
checks: [pnpm typecheck, pnpm test]
---

# Harness core

`src` is the `@agentskit/harness` package: the CLI, the loop, the verification kernel and its adapters.

## Layout

- `src/cli.ts` — the `ak-harness` / `ak-verify` entrypoint; changing it means regenerating the reference docs.
- `src/kernel` — contract, verification and event vocabulary; no provider or tracker dependency here.
- `src/loop`, `src/execution`, `src/delivery` — the issue-to-release loop and its delivery steps.
- `src/adapters` — provider, agent, code-review and doc-bridge adapters.
- `src/profiles`, `src/context`, `src/record.ts`, `src/mvp.ts`, `src/ui` — profiles, context, run records, the
  `mvp` command and the terminal UI.
- `src/index.ts` — the public API; changes need `pnpm check:public-api:update`.

## Change rules

- Keep files small and per capability (see `AGENTS.md`).
- New code needs a test under `test/`; coverage floors live in `vitest.config.ts`.
- Add a `changelog.d/<ticket>.md` fragment instead of editing `CHANGELOG.md`.

## Check

`pnpm typecheck` and `pnpm vitest run test/<file>.test.ts`; the full suite is `pnpm test:coverage`.

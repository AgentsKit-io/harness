---

type: package
package: harness-scripts
editRoot: scripts
checks: [pnpm test:docs-artifacts]
---

# Harness scripts

`scripts` holds the repository generators and verifiers that the CI runs; none of it ships in the npm package.

## Layout

- `scripts/gen-*-reference.mjs`, `scripts/build-docs-artifacts.mjs` — generated reference docs (`pnpm docs:generate`).
- `scripts/generate-doc-bridge-config.mjs` — writes `doc-bridge.config.json` (`pnpm docs:bridge:config`).
- `scripts/generate-capability-manifest.mjs` — writes `capabilities/public-surface.json` (`pnpm test:capabilities`).
- `scripts/check-public-api.mjs` — guards `docs/stability/public-api-v1.json`.
- `scripts/verify-*.mjs` — release, docs, dependency-direction and package verifiers.
- `scripts/*.test.mjs` — `node --test` suites, run by `pnpm test:docs-artifacts` (outside vitest).
- `scripts/lib`, `scripts/ci` — shared helpers and CI-only scripts.

## Change rules

- Changing a generator means running it again and committing its output in the same change.
- Keep scripts free of tracker or provider dependencies (`scripts/verify-dependency-directions.mjs`).
- Add a `changelog.d/<ticket>.md` fragment instead of editing `CHANGELOG.md`.

## Check

`pnpm test:docs-artifacts`, plus the `--check` mode of the generator you changed.

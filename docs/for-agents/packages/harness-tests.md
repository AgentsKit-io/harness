---
type: package
package: harness-tests
editRoot: test
checks: [pnpm test]
---

# Harness tests

`test` holds the vitest suites of the `@agentskit/harness` package, with their fixtures and helpers.

## Layout

- `test/*.test.ts`, `test/*.test.tsx` — one suite per capability of `src`.
- `test/fixtures` — static inputs used by the suites; changing an existing fixture needs a note in the PR.
- `test/helpers`, `test/git.ts` — shared helpers (temporary repositories, git setup).

## Change rules

- Tests never use the real HOME; create temporary directories.
- Coverage floors for `src/**` live in `vitest.config.ts`; new code needs a test here.
- The `loop-cross-platform` CI job runs `test/loop*.test.ts` on Linux, macOS and Windows: avoid timing and path assumptions.

## Check

`pnpm vitest run test/<file>.test.ts` for one suite; `pnpm test` for the whole package.

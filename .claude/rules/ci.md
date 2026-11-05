# CI rules

- Before pushing, run only the tests/scripts for changed files (`pnpm vitest run <changed tests>`), not the full contract. See `docs/adr/0048-scoped-verification.md`.
- Tests use no fixed ports (bind to port 0) and no hard-coded dates (inject a clock or use relative times).
- Tests never use the real HOME; use temp directories.
- Generated artifacts (docs, capability manifest, Doc Bridge index) are regenerated, never hand-edited.

# Compatibility report

**Release:** `@agentskit/harness@0.4.0`  
**Harness revision:** `a18b57d43f037b7a34b134e01baf913ae2341fd7`  
**Captured:** 2026-09-10  
**Decision:** BLOCKED (fail closed)

## Passed boundaries

- `@agentskit/core@1.12.9` at `d89a2d7`: 498/498 tests.
- `@agentskit/memory@0.11.9` at `d89a2d7`: 228/228 tests.
- `@agentskit/eval@0.6.5` at `d89a2d7`: 105/105 tests, including build/bundler preparation.
- `@agentskit/doc-bridge@1.7.45` at `9f9e9d`: 351/351 tests plus plugin contracts and typecheck.
- Harness adapter and runtime boundaries: covered by `ak-verify` run `1789063362018-21016-775q93` (21/21 checks).

## Blocked evidence

`@agentskit/code-review@0.30.8` passed its 241-test suite. A real fixed-provider run (`codex-cli`, `gpt-5.6-luna`, high, run `ceaf007a-ea6e-4dc9-a601-f816702b301c`) completed coverage, safety, reliability, memory, configuration, and actionability checks, but the quality matrix blocked on detection, precision, batch efficiency, integration, and missing comparable baselines. The result is retained as evidence, not promoted to a pass.

The 0.4.0 no-Harness comparison remains unavailable because the owner-approved ten-task cohort and matching criterion-level logs have not been captured. Registry smoke can only run after the main Trusted Publishing workflow publishes the package.

See [`migration.md`](migration.md), [`rollback.md`](rollback.md), and the machine-readable [`report.json`](report.json).

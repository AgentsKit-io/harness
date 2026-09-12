# 0.7.0 release candidate

Dynamic Orca-aware model routing (hybrid/dynamic/catalog) with remaining-usage ranking and a living model catalog (CLI + builtin + optional Artificial Analysis).

# 0.6.0 release candidate

Keep-pushing loop gains approved memory (token reduction + continuous improvement), Doc Bridge freshness/review doctor probes, brief guidance scopes, optional deliver smoke, agent registry YAML, RAG context provider, MCP adapter seam (ADR-0028), Docker verify config, and weekly Linear retro automation. Config defaults preserve 0.5.0 behaviour.

# 0.5.0 release candidate

This release adds the keep-pushing SDLC loop (`ak-harness loop …`): project config with a per-machine overlay,
provider detection with Orca usage awareness and cooldowns, tiered model routing, machine slot assessment, Orca /
Linear / GitHub / code-review adapters, the dispatch tick with orchestrator-frozen contracts, the deliver stage
(CI → review → fix rounds → squash-merge → Linear Done) and the Orca automation installer. See `docs/LOOP.md` and
ADR-0027. `yaml` and `zod` become runtime dependencies.

Publication happens only when this candidate merges to `main` (release workflow, npm Trusted Publishing, no
`NPM_TOKEN`). `release/qualification.json` still records the 0.4.0 publication and will be refreshed after 0.5.0 is
on the registry. Compatibility and pilot-benchmark criteria remain fail-closed as in 0.4.0.

# 0.4.0 release

This release packages the deterministic SDLC kernel, phase quality matrix,
versioned eval battery, compatibility contract, and consumer examples.

Publication is intentionally limited to a merge on `main`. The release
workflow uses npm Trusted Publishing (`id-token: write`) and no `NPM_TOKEN`.

The package was published from `main` through npm Trusted Publishing at
`2df60bcbda850382d1a1112f338fa53858c5d4cf`. Pinned upstream tests and the
registry/consumer smoke are recorded as passed. Compatibility remains fail-closed
until the real Code Review quality baseline and the owner-approved ten-task
Harness/no-Harness pilot cohort are captured.

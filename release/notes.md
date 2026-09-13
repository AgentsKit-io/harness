# 0.12.0 release candidate

Reuses Orca instead of reinventing it, where Orca's own tooling gives a better answer than the harness's own
heuristics: `loop deliver` escalations now fold in the dispatched worker's own terminal output (best-effort,
`terminal read --screen`) so a human sees the worker's own diagnosis instead of a generic idle/no-PR message; slot
assessment prefers Orca's `diagnostics memory` (macOS's real memory-pressure reading) and real per-session RSS over
the harness's own `vm_stat` approximation and static per-agent guess, which were measured roughly 2x more
conservative at the same instant. Also ships an installable `ak-harness-loop` Orca Skill documenting the loop's
commands and the operational constraints this release's investigation confirmed (Orca's orchestration mutations —
`run-create`/`task-create`/`worker-start`/`send` — require a live coordinator terminal pane and cannot be called
from the loop's headless `tick`/`deliver`, verified from every angle tried). Publication remains gated on a merge
to `main` through npm Trusted Publishing.

# 0.11.0 release candidate

Read-only loop observability for the keep-pushing SDLC loop: deterministic anomaly detection and operating metrics
for queue, delivery, machine pressure, provider headroom, memory, cache, reviews, fix rounds, lead time, and
observed token fields. Publication remains gated on a merge to `main` through npm Trusted Publishing.

# 0.8.0 release candidate

Worker handoff: continue in-flight tickets on the same Orca worktree/branch with another provider when usage runs out.

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

# ADR-0027: Keep-pushing loop as composition over Orca

- Status: Accepted
- Date: 2026-09-11

## Context

Teams want a coding-agent loop that drains one person's Linear queue around the clock: pick a ticket, freeze a
verifiable contract, run a worker in an isolated worktree, review, merge, repeat — while never exceeding the
machine, never guessing when acceptance criteria are missing, and surviving provider usage limits. The harness already
owns the deterministic pieces (dispatch ledger, machine pressure, delivery gates, evidence). Orca already owns
scheduling, worktrees, terminals, Linear access and the visibility surface. Nothing owned the composition.

## Decision

1. The loop lives in this package as **Adapter + Composition** (`src/adapters/{command,orca-cli,providers,linear-orca,
   github-cli,code-review}.ts`, `src/loop/*`). The kernel is unchanged and never imports it (`pnpm test:boundaries`).
2. Every project-specific value lives in `loop.config.yaml` (zod-validated). The code carries no repository, person,
   path or model id. Env variable **names** may appear in config; values never do.
3. External systems are reached only through argv-based, timeout-bounded process execution injected as a
   `CommandRunner`. Adapters never spawn a shell; composition supplies the real runner; tests supply fakes.
4. Orca is the single scheduler and visibility surface: two automations (`<prefix>-tick`, `<prefix>-deliver`), each
   gated by a read-only `--precheck` that exits 0 only when work exists, run an agent prompt whose sole job is to
   invoke `ak-harness loop <stage>`. No cron, launchd or daemon of our own.
5. Model routing is tiered per role (`orchestrator`, `reviewer`, `builder`, `watcher`); within a tier the first
   provider with usage available wins. Usage comes from `orca account list`; an auth/quota failure marks the provider
   cooling down (exponential, never before the reset Orca reports) and the next candidate is tried.
6. Autonomy envelope: the loop may claim tickets, freeze contracts, dispatch workers, nudge them, review, squash-merge on
   a clean review plus green checks, move Linear states and clean worktrees. It must not merge PRs touching
   `selfEditPaths`, must not force-push or bypass approvals, must not recover leases (human only, ADR-0021), and must
   escalate with one deduplicated comment when a contract has no executable acceptance criterion or when fix rounds
   are exhausted.

## Consequences

- `yaml` and `zod` become runtime dependencies of the package.
- The loop is verifiable offline: every stage has fixture-driven tests and `--dry-run` prints the exact argv.
- Provider CLIs (`claude`, `codex`, `grok`, `opencode`) are configuration, not code; adding one is a YAML entry with a
  TUI template, an optional headless template and an `agentskit-review` provider id.
- Windows is supported through Node's process model; WSL is detected and capped to one worker because host
  antivirus load is invisible from the distro.

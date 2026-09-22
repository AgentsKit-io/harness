# ADR-0038: Worker guard — real-time enforcement inside the worker's own session

## Status

Accepted, partial (see Consequences — `codex` is deliberately not covered yet)

## Context

Every gate this harness had before this ADR runs *after* the worker: `deliver.ts`
reads a PR's changed files and holds one that touches `delivery.selfEditPaths` or
looks like a secret (`secretFilePatterns`). A worker is free to write anything inside
its own session; the harness only ever finds out once the PR exists. That gap is
structural — ADR-0037 already names it: the worker's own CLI session is opaque, its
tool calls never reach the harness.

Four providers this loop dispatches (`claude`, `codex`, `opencode`, `grok`) each have
some mechanism to intercept a tool call before it runs. Whether that mechanism is
*real* enforcement, under the exact invocation this loop already uses (a TUI opened
by Orca and driven by pasted text, not each CLI's own `-p`/`exec`/`run` headless
mode), was verified live against this project's own dispatched `claude` binary and
by reading the other three CLIs' source/docs directly — not assumed from a feature
list. What follows is what that verification found, provider by provider.

## Decision

**`ak-harness loop worker-guard`** is a new CLI subcommand: it reads one `PreToolUse`
event on stdin (`{tool_name, tool_input, cwd}` — the shape Claude Code and Grok Build
CLI deliberately share, byte-for-byte), judges the file it names against
`delivery.selfEditPaths`/`secretFilePatterns` (the exact same `touchesProtectedPaths`
call the PR-time gate already makes), and exits `2` to block or `0` to allow. One
rule, two enforcement points — this one during the work, the PR-time one as the
backstop for whatever a hook missed, crashed on, or was never installed for.

**The loop installs it into the fresh worktree before the worker's terminal opens**
(`installWorkerGuard`, called from `tick.ts` at dispatch and from `deliver.ts` on a
handoff, since a handoff changes which format — or none — applies):

- **`claude`** — `.claude/settings.local.json`, a `PreToolUse` hook on
  `Write|Edit|MultiEdit|NotebookEdit`. **Verified live** in this repository's own
  sandbox: a real `claude -p` session, with a real deny hook installed, was asked to
  overwrite `loop.config.yaml`; the write did not happen, and the model itself
  reported the block. Hooks here fire unconditionally, *before* the
  `--permission-mode` check — including in `bypassPermissions`. The one real risk,
  confirmed against the official docs rather than inferred: a hook that times out,
  crashes, or returns malformed output is **not** blocking — the call proceeds as if
  allowed. Only a hook that runs to completion and exits `2` (or returns
  `permissionDecision:"deny"`) is fail-closed. `worker-guard` is deliberately a
  single, fast, dependency-free check for exactly this reason: less surface for it to
  crash or hang on.
- **`grok`** (`xai-org/grok-build`) — `.grok/hooks/config.json`, same shape as
  Claude's (confirmed deliberately compatible by that project). Its own docs describe
  the best fail-closed story of the four for a permission rule with no terminal to
  answer it: the call is rejected and Grok is told why, not silently allowed and not
  hung. It shares Claude's fail-open-on-crash behavior, and it has its own,
  independent first-run "trust this folder" prompt that blocks with no TTY unless
  `--trust` is passed — `loop.config.example.yaml`'s `grok.tui` now carries it.
  Deliberately not `--yolo`: that would also relax the permission mode this hook
  depends on.
- **`opencode`** — no hook at all. Its declarative permission engine's `ask` tier,
  under no attached terminal, is reported across multiple open upstream issues as
  either hanging indefinitely or aborting the session, depending on version — never
  settled, and never reported as silently auto-approving either. Rather than depend
  on an unresolved tier, `worker-guard` writes static `"deny"` rules straight into
  `opencode.json`'s `permission.edit` for every `selfEditPaths`/`secretFilePatterns`
  pattern (confirmed against `packages/core/src/v1/config/permission.ts` directly,
  not inferred) — no subprocess, no hang, nothing to crash.
- **`codex` — deliberately not covered.** Two open upstream issues make a hook-based
  deny unsafe to depend on today: `PreToolUse` is not emitted at all for several tool
  handlers (`openai/codex#20204`), and — more directly disqualifying — a report that
  `apply_patch` (Codex's primary file-write path) proceeds and reports success *even
  when its own `PreToolUse` hook returned `deny`* (`openai/codex#27833`, unconfirmed
  fixed as of this ADR). Fail-open on a crashed/timed-out hook is an admitted current
  limitation, not a bug (`openai/codex#41979`). There is also no supported,
  non-interactive way to pre-trust a hook short of `--dangerously-bypass-hook-trust`
  (`openai/codex#46210`) or reverse-engineering an undocumented internal hash. Shipping
  a `codex` hook today would look like enforcement and might not be — the PR-time gate
  stays `codex`'s only real gate until `#27833` is confirmed fixed on a pinned version.

**Version pinning.** The hook file records an absolute path
(`resolveOwnCliPath`, `realpathSync(process.argv[1])`), not `ak-harness` resolved
fresh off `PATH` at the moment the hook fires. A worker dispatched before an upgrade
keeps calling the exact build that was running at dispatch time — consistent with
everything else frozen at dispatch (`contractDigest`, `briefDigest`, labels).
`delivery.workerGuard.enabled` (default `true`) is the one escape hatch, for a
project that already has its own conflicting hooks or does not want this yet.

## Consequences

A protected-path or secret-shaped write is now refused as it happens for `claude` and
`grok`, and denied by static rule for `opencode` — not just discovered afterward at
review time. `codex` gets nothing new: it is exactly as covered as it was before this
ADR, by the PR-time gate alone, and that limitation is named here on purpose rather
than papered over with a hook that current upstream bugs could make a no-op.

What this ADR does not claim: `worker-guard` only ever sees `Write`/`Edit`/
`MultiEdit`/`NotebookEdit` calls — a `Bash` command that writes the same protected
path (`echo secret > .env`) is not caught here, for the same reason it is not caught
by the PR-time gate this backs up (that gate only ever sees the PR's changed-file
list, never how a file got that way). And the non-`-p` interactive TUI session Orca
actually drives (as opposed to the `-p` session this ADR's live test used) was not
verified end-to-end for the first-run trust dialog specifically — that risk, if it is
one, predates this ADR and is independent of it; a project that already dispatches
`claude` successfully today has already answered that question one way or another.

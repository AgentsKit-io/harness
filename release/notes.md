# 0.17.0 release candidate

Two things, both from a pre-publish review that went looking for the gap between what this package claims and
what it does.

**Worker guard.** `ak-harness loop worker-guard` blocks a `Write`/`Edit`/`MultiEdit`/`NotebookEdit` touching
`delivery.selfEditPaths` or `delivery.secretFilePatterns` as it happens, inside the worker's own session —
the same check `deliver` already made on a PR's changed files, early enough to prevent the write instead of
reporting it. `claude` and `grok` get a `PreToolUse` hook; `opencode` gets deny rules in `.opencode/`;
`codex` is deliberately uncovered while its upstream hook bugs stand. The review then found four ways the
guard failed open while reporting itself installed, and all four are fixed here — see `docs/ADR-0038` for
what it does not claim, including the `Bash` path it cannot see and the fail-open on a crashed hook.

**The release can no longer outrun its own gate.** Publishing was a separate workflow running *in parallel*
with CI, re-running only typecheck/test/build, so a commit could fail the contract, the docs check or the
Windows matrix and publish anyway. It is now a job in `ci.yml` that `needs` all three. `docs/ADR-0039` covers
the other half of that review: a floor under auto-merge, and a configured runner that nothing called.

Publication remains gated on a merge to `main` through npm Trusted Publishing. The blockers in
`release/manifest.json` (`ecosystem-compatibility`, `pilot-benchmark`) are unchanged and still open;
`release/qualification.json` records what was and was not measured for this version rather than asserting a
qualification run that did not happen.

# 0.18.0 release candidate

What a pre-publish review found when it went looking for the gap between what this package claims and what it
does. Seven changes landed; every one of them is a place the harness was wrong about itself.

**Worker guard.** `ak-harness loop worker-guard` blocks a `Write`/`Edit`/`MultiEdit`/`NotebookEdit` touching
`delivery.selfEditPaths` or `delivery.secretFilePatterns` as it happens, inside the worker's own session — the
same check `deliver` already made on a PR's changed files, early enough to prevent the write instead of
reporting it. The review then found four ways the guard failed open *while reporting itself installed*; all
four are fixed. `docs/ADR-0038` states what it does not claim, including the `Bash` path it cannot see and the
fail-open on a crashed hook.

**Gates.** A flow profile could turn the review, the verify, the definition of done and CI gating all off and
still auto-merge, with no human approval required — nothing examined the diff and nobody was asked to. There is
a floor under auto-merge now. `connectors.runner: "local"` is rejected at load rather than silently running
Orca. `docs/ADR-0039` covers both.

**Boundaries.** Every read of a JSON file the harness wrote is validated before the caller sees it, and a rule
in CI keeps new unchecked casts out. `DispatchRecordFile.worktreePath` is optional, because it always was on
disk — making the type honest surfaced the one defect a human review had to find by reading.

**Economy.** Four of this repository's own five house conventions were being broken by it: fix rounds ran the
whole gate instead of the layer's, the role writing the code reasoned less than the roles reading it, the issue
timeline read the event log unbounded, and plan votes made one full call each even when the pool had one model.

**Release.** Publishing ran in parallel with CI and could ship past a red gate. It is a job in
`release-harness.yml` now, needing all three check jobs. The filename is load-bearing: npm Trusted Publishing
authorises by repository and workflow filename.

The blockers in `release/manifest.json` (`ecosystem-compatibility`, `pilot-benchmark`) are unchanged and still
open; `release/qualification.json` records what was and was not measured for this version rather than asserting
a qualification run that did not happen.

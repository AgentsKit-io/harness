# 0.19.0 release candidate

Everything here was found by running the keep-pushing loop on a real multi-week repository migration, first with
a single non-default provider and then a mixed one. Each fix was observed live and has a test; `CHANGELOG.md`
has the full list.

**Safety.** A worker at a tool-permission prompt is held for a person, never typed into. The orchestrator reads
a harness-owned view of `origin/<baseBranch>`, and workers start from it. A PR held for protected paths is
released only by `loop approve <issue> --head <sha> --by <you>`, bound to that commit. Gate lists accumulate
across config layers. Approved plan documents stay out of a checkout that is not the clean base branch.

**Delivery.** The brief goes over as a file with a one-line pointer, and counts as delivered only when the turn
starts, or, for agents Orca cannot observe, when it stays on screen. An unconfirmed brief is re-sent on the
first idle pass. A worker out of usage is handed to another provider after its terminal is closed, and a reset
given in days is read whole. A PR closed without merge is escalated once.

**Planning.** Model output is found in markers, a fenced block or the last valid JSON value. Decompose files
what it reviewed, outside the queue, and marks work that is not a PR to this repository (`outside-loop`).

**Breaking.** Gate lists accumulate across layers; `approve-design` needs `--accept-objections` when votes
carry objections; decompose files issues in `linear.entryState`, which must not be one of `linear.states`;
the queue never dispatches `linear.outsideLabel`.

The blockers in `release/manifest.json` (`ecosystem-compatibility`, `pilot-benchmark`) are unchanged.

# ADR-0044: Delivery evidence on the tracker issue, and the shape of a Jira connector

## Status

Accepted (evidence comment). Proposed (Jira connector — not built).

## Context

When the loop finished an issue it left one line on the tracker: `Loop: merged — <pr> as <sha>`. What was verified
— the review verdict, the worker's `verify.json`, the Definition of Done, the CI checks, the fix rounds — lived on
the PR or in the local run store (ADR-0041). A reader of the issue could not audit the merge without opening the
repository, and nothing on the issue distinguished "verified" from "merged by someone outside the loop".

Trackers differ in how a comment is written: Linear and GitHub take Markdown, Jira Cloud takes Atlassian Document
Format (ADF, JSON), and each has its own size ceiling. ADR-0034 already says the second implementation of a seam is
what proves it; this change is the first to put a structured comment through the tracker seam.

## Decision

**The evidence is built once, as structure.** `src/loop/evidence.ts` is pure: `buildEvidenceDocument` turns a
`DeliveryEvidence` record into a `CommentDocument` (headings, paragraphs, lists, tables, code). `deliver` gathers the
record from what it already holds — delivery state, the review result file, `verify.json` and the DoD file (worktree,
or the copy in the run), the PR's checks, the windowed event log (ADR-0041 `windowed:`), `issueSpend`. Every gate has
an explicit state: absent evidence is written as absent, a `skipped` or `blocked` item is never shown as passed, and
every free-text field passes `scanForPii` before it reaches a comment.

**The tracker decides how it is written.** `TrackerConnector.comments` (`src/loop/comment-format.ts`) declares the
format (`markdown` | `plain`), the size ceiling, and optionally the connector's own `render(document)`. `fitComment`
renders within the ceiling: detail is dropped first (output tails, then tables), one closing line names what was
cut, and the idempotency marker always survives. Markdown hides the marker in an HTML comment; formats that cannot
hide it omit it and rely on `dedupeKey`.

**Was it resolved? The comment answers that first.** A `Resolution` section opens the comment with a verdict computed
only from recorded evidence: `RESOLVED` (at least one acceptance criterion and every one proven), `PARTIAL` (some
proven, the rest listed with their status) or `NOT PROVEN` (none proven, or none recorded). A merge alone never
yields RESOLVED; a merge with missing evidence says so. The criteria are the frozen contract's outcomes (the list
`assessDod` already judges): each row keeps the id and the criterion text, its status (a criterion with no proof is
UNPROVEN, never omitted) and the worker's evidence, with the verify command and exit code when `verify.json` covers
it. Project DoD items stay in their own table. The links (PR, merge sha, files changed, the issue's own checkbox
state) sit under the verdict.

**Bug fix proof.** An issue carrying one of `delivery.evidence.bugLabels` (case-insensitive; default `Bug`,
`type:bug`, `type:fix`) gets a block with the reproduction steps copied from the issue (the section under a
"Steps to reproduce"-style heading, one line, truncated, PII-redacted), the regression tests the PR added or changed
(test files in the PR's file list; test names only when the worker's verify output lists them as passing) or "no
regression test in this PR". The harness does not run the test on the base, so the block always states "not
demonstrated: regression test not verified to fail before the fix". ponytail: a base-vs-head run needs a second
checkout and a per-project test command; it is not built, so the comment never claims it.

**Cost.** One extra tracker read (the issue: labels, description) on the merged comment only; escalations skip it. If
the read fails the comment names the issue details as unavailable and omits the bug block.

**Same idempotency as before.** `complete()` posts with the existing `dedupeKey` (`merged:<issue>:<pr>`) and marker
(`loop:merged:<pr>`), on every path — merged by the loop, reconciled after branch deletion, merged outside the loop.
A blocked-after-fix-rounds escalation appends a brief version (review findings, DoD gaps).

## A future Jira connector

Not built here. What it would be, against the interfaces as they now stand:

| Method | Jira Cloud REST v3 |
|---|---|
| `queue` | `POST /rest/api/3/search/jql` with project + `statusCategory` + labels + `assignee is EMPTY` (`queueOwnership: unassigned`) or `= <accountId>`; map to `LoopIssue` |
| `issue` | `GET /rest/api/3/issue/{key}?fields=summary,description,status,labels,assignee,priority,created,updated,comment`; ADF description flattened to text for the contract |
| `comment` | `POST /rest/api/3/issue/{key}/comment` with `body` = the ADF document from `comments.render`; dedupe by an entity property (`PUT /issue/{key}/properties/harness.<dedupeKey>`) checked before posting — ADF has no hidden HTML comment |
| `addLabels` / `removeLabels` | `PUT /rest/api/3/issue/{key}` with `update.labels: [{add}|{remove}]` (labels cannot contain spaces — map `config.linear.*Label` values accordingly) |
| `setState` / `transitions` | `GET /issue/{key}/transitions`, pick the transition whose `to.name` matches the configured state (`linear.states`, `inProgressState`, `reviewState`, `doneState`, `returnState`), `POST` it. A state with no transition from the current one fails closed, naming both |
| `claim` / `release` | `PUT /issue/{key}/assignee` with `accountId` (from `linear.people`, renamed in config) / `null` |
| `attach` | `POST /issue/{key}/remotelink` with the PR URL; `globalId` = `dedupeKey` makes it idempotent |
| `createIssue` | `POST /rest/api/3/issue` (ADF description); `parent` for sub-tasks; dedupe by JQL on a label/property carrying the key |
| `preflight` | `GET /rest/api/3/myself` + `GET /rest/api/3/mypermissions?permissions=BROWSE_PROJECTS,ADD_COMMENTS,TRANSITION_ISSUES,EDIT_ISSUES` |

- **Auth**: API token + account email (Basic) from env (`JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_BASE_URL`), never config
  files; OAuth 2.0 (3LO) later. Calls go through `@agentskit/net` (deadlines, body caps) — no Jira SDK.
- **Rate limits**: a `429` maps to `isTrackerRateLimit` so `guardTracker`'s cooldown applies unchanged.
- **Comments**: `comments: { format: 'plain', maxChars: 30_000, render: toAdf }`. Jira caps a comment body at
  32,767 characters of the serialized document; `fitComment` measures what `render` returns, so the ceiling holds for
  the JSON, not the text. `toAdf` maps `heading` → `heading`, `paragraph` → `paragraph` (backtick spans → `code`
  marks), `list` → `bulletList`, `table` → `table`/`tableRow`/`tableHeader`/`tableCell`, `code` → `codeBlock`.
- **Reused from this change**: `DeliveryEvidence`, `buildEvidenceDocument`, `fitComment`, the `comments` contract and
  every caller of `tracker.comment`. A Jira connector is a new factory in `connectors.ts` and a `connectors.tracker`
  value — no change in `deliver`.
- **Known leak to fix then**: escalation bodies (`escalateTracker`) are still Markdown strings; a connector with its
  own renderer gets them unformatted (and no appended evidence) until they move to `CommentDocument` too.

## Consequences

The issue alone answers "what was verified, at which head, by whom". The cost is one windowed event-log read, one tracker issue read (merged comments only) and one
optional GraphQL call (unresolved review threads) per completion, and comments of up to the tracker's ceiling. On
Windows both trackers pass the body as one argv element, so the ceiling there is held at 24k characters.

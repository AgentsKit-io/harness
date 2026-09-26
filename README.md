---
docbridge:
  covers:
    - package:@agentskit/harness
---

# @agentskit/harness

**The keep-pushing loop for your SDLC.** A vague objective becomes a PRD, the PRD becomes issues, each issue
becomes a frozen contract, a worker in its own worktree, a reviewed pull request proven against a definition of
done, a merge — and, behind a human gate, a release.

The local UI is optional and loopback-protected: it projects `.ak-loop/` files and events and can start typed Harness jobs without adding a daemon or database. Its primary flow is issue-first: select an available issue, freeze its contract/profile/limits, enqueue it, and resolve only human decisions from the persistent Inbox.
Docs: **[harness.agentskit.io](https://harness.agentskit.io)**

## Install

```bash
pnpm add -D @agentskit/harness     # Node 22+
```

Node 22 or newer. Two binaries: `ak-harness` (everything) and `ak-verify` (the same binary under the common
verification-protocol name).

## 60 seconds

```bash
npx ak-harness loop init           # writes loop.config.yaml from a preset
npx ak-harness loop doctor         # providers, routing, slots, queue — dispatches nothing
npx ak-harness ui                  # local operational view at http://127.0.0.1:4321
npx ak-harness loop tick --dry-run --max 1
npx ak-harness loop install        # puts tick + deliver on a schedule
```

Then it runs without you: `tick` contracts and dispatches, `deliver` drives the pull request to merge.

## What a run looks like

```console
$ ak-harness loop tick --max 1
{"status":"ok","routing":{"orchestrator":"codex/gpt-5.6-sol","builder":"codex/gpt-5.6-luna"},
 "results":[{"issue":"REP-141","outcome":"dispatched","branch":"you/rep-141-usage-flag",
             "worktree":"rep-141-usage-flag","contractDigest":"9f2c1ab4…"}]}

$ ak-harness loop deliver
{"results":[{"issue":"REP-141","outcome":"fix-round","pr":482,
             "reason":"review found 2 blocking finding(s)"}]}

$ ak-harness loop deliver
{"results":[{"issue":"REP-141","outcome":"merged","pr":482,
             "actions":["local verify passed before review","verify.json supplied 2 outcome proof(s)",
                        "definition of done proven (5 item(s))"]}]}
```

## The worker leaves evidence, not promises

Three files in `.ak-loop/` at the root of its worktree. `deliver` reads them before the merge gate; a missing
one comes back as a fix round **naming the file**.

```jsonc
// .ak-loop/verify.json — what it ran, outcome by outcome
{ "ranAt": "2026-09-20T18:04:11.000Z", "command": "pnpm test packages/report", "exitCode": 0,
  "outcomes": [{ "id": "o1", "status": "passed", "evidence": "42 passed | 0 failed" }] }
```

```jsonc
// .ak-loop/dod.json — both definition-of-done lists
{ "project":  [{ "id": "tests", "status": "passed", "evidence": "212 tests · 212 pass" }],
  "outcomes": [{ "id": "o1",    "status": "passed", "evidence": "returns 404 for an unknown id" }] }
```

`.ak-loop/plan.md` is the third: the plan the worker actually followed, and where it departed from the approved
one.

## Configuration, by example

```yaml
# loop.config.yaml — the project's layer (there are four; the project outweighs the global one)
project: { name: report, repo: acme/report, baseBranch: main }
delivery:
  verifyCommand: pnpm lint && pnpm test
  review: { minSeverity: med, votes: 1 }
  merge: { auto: true, requireChecks: true }
```

```yaml
# Every issue must prove the project's list, on top of its own contract outcomes.
dod:
  items:
    - { id: tests, description: the suite is green, kind: command, command: [pnpm, test] }
    - { id: changelog, description: the changelog moved, kind: file-changed, glob: CHANGELOG.md }
```

```yaml
# One motor, three kinds of demand. A pin narrows the candidates; it never widens them.
flows:
  default: standard
  profiles:
    standard: { review: { votes: 1, minSeverity: med } }
    critical:
      review: { votes: 3, minSeverity: nit }
      merge: { requireHumanApproval: true }
      roles: { review: { provider: codex, model: gpt-5.6-sol, effort: xhigh } }
    incident:
      merge: { requireChecks: false }
      stages: { planner: false, vote: false, review: false }
      maxFixRounds: 1
  select:
    - { flow: incident, anyLabels: [sev1] }
    - { flow: critical, anyLabels: ['area:billing'] }
```

```yaml
# A layer says which test closes an issue — cheaper than the whole suite on a monorepo.
layers:
  - { id: L2, label: 'layer:L2', paths: ['packages/runtime/**'], verify: pnpm test packages/runtime }
```

### GitHub Issues as the configured tracker

Set the tracker to GitHub when the UI and execution loop should operate on issues from `project.repo`:

```yaml
connectors:
  tracker: github
github:
  issues:
    state: open
    maxIssues: 500
    refreshSeconds: 60
    labels:
      todo: loop:todo
      inProgress: loop:in-progress
      review: loop:review
      done: loop:done
      blocked: loop:blocked
```

The Harness calls the existing `gh` CLI, sorts by most recently updated, and caches the board at
`.ak-loop/ui/github-issues.json`. `gh auth status` and repository write permission are checked before a mutating job.
Lifecycle labels are exclusive; `done` closes an issue and active states reopen it. Missing configured labels fail
closed. The UI exposes typed, confirmed actions and jobs; only one tracker is selected per configuration.

The Harness reads `loop.config.yaml`; it does not consume a project's `.github/ai-loop.yaml`, whose schema belongs to a
different executor.

## Commands

| Read-only | |
|---|---|
| `loop doctor` | Providers, usage, routing, slots, selected tracker board, installed agents |
| `loop debrief` | What the loop is doing right now, per issue |
| `loop observe --since 24h` | Anomalies and metrics; `--precheck` gives a scheduler exit code |
| `loop retro --since 7d` | Digest, learnings and calibration suggestions |
| `loop status` · `loop watch --once` · `loop paused` | Schedule, in-flight phases, what it stopped on |

| Acts | |
|---|---|
| `loop tick` · `loop deliver` | One dispatch pass · one delivery pass (both take `--dry-run`) |
| `loop plan start \| answer \| approve \| architect \| approve-design \| decompose` | Objective → PRD → design → issues, two human gates |
| `loop release status \| approve \| run` | Promote a batch a human approved, bound to a head sha |
| `loop install` · `loop uninstall` · `loop resume` | Schedule, and clearing a pause |

## As a library

```ts
import { loadLoopConfig, resolveFlowSettings, assessDod, readPhaseArtifacts } from '@agentskit/harness'

const { config } = loadLoopConfig('loop.config.yaml')
const flow = resolveFlowSettings(config, { labels: ['sev1'] })
// → flow.review.votes, flow.merge.requireChecks, flow.flow.name === 'incident'

const artifacts = readPhaseArtifacts('/path/to/worktree', config)
// → [{ name: 'verify', file: '.ak-loop/verify.json', present: true, valid: true, detail: '2 outcome(s)' }, …]
```

```js
// plugin.mjs, declared in `plugins.modules` — a gate of your own
export default function register(bus) {
  bus.on('pr.merged', (event) => metrics.count('merged', event.issue))
  bus.hook('beforeMerge', ({ issue }) => isChangeFreeze() ? { block: true, reason: `freeze: ${issue}` } : undefined)
}
```

## Also: the verification protocol

The same binary runs the single-run protocol the loop is built on — a frozen contract, executable checks bound
to the current revision, and an explicit human decision:

```bash
ak-harness plan approved --by human
ak-harness start
ak-verify run --json
ak-verify approve approved --by human --json
```

```json
{"status":"passed","criteria":["api-behavior"]}
```

Every check's final output line is JSON mapping to the outcome ids it proves. Evidence is bound to a committed
Git `HEAD`; any source, configuration or contract change moves the run to `STALE`. Runs append a hash-chained
`events.ndjson` — verify one with `ak-harness events verify [run-id]`.

Runnable example: [`examples/minimum-profile.mjs`](examples/minimum-profile.mjs) (after `pnpm build`).

## More

- **[harness.agentskit.io](https://harness.agentskit.io)** — concepts, guides, examples, and the generated
  reference for every config path, command and event.
- [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) · [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) ·
  [docs/LOOP.md](docs/LOOP.md)
- Decisions: [ADR-0027](docs/ADR-0027-keep-pushing-loop.md) (the loop) ·
  [ADR-0032](docs/ADR-0032-loop-stages-as-state-machines.md) (stages) ·
  [ADR-0035](docs/ADR-0035-definition-of-done-two-lists.md) (definition of done) ·
  [ADR-0037](docs/ADR-0037-cost-policy-ceilings-and-levers.md) (cost)
- [CONTRIBUTING.md](./CONTRIBUTING.md) · [CHANGELOG.md](./CHANGELOG.md) · [MANIFESTO.md](./MANIFESTO.md)

## Release

The `publish` job in [`.github/workflows/release-harness.yml`](.github/workflows/release-harness.yml) publishes on a merge to `main`,
through npm Trusted Publishing (GitHub OIDC) — no `NPM_TOKEN` anywhere. It lives in the same workflow as the
checks and `needs` every one of them, so a commit cannot publish past a red gate; a version not yet on the
registry is the trigger. That file holds the checks as well as the publish: npm Trusted Publishing authorises
by repository and workflow **filename**, so renaming it breaks releases until the npm setting matches. The
candidate checklist and any open blocker live in
[`release/manifest.json`](release/manifest.json) and [`release/notes.md`](release/notes.md).

Free and open source under MIT. See [LICENSE](./LICENSE).

## AgentsKit ecosystem

- [AgentsKit](https://www.agentskit.io)
- [Registry](https://registry.agentskit.io)
- [Chat](https://chat.agentskit.io)
- [Doc Bridge](https://doc-bridge.agentskit.io)
- [Code Review](https://code-review.agentskit.io)
- [Harness](https://harness.agentskit.io)

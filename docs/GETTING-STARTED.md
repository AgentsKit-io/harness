# Getting started

Install the package, then run the included consumer example:

```bash
pnpm add -D @agentskit/harness
pnpm build
node examples/minimum-profile.mjs
```

The example uses a fake profile in YOLO mode, a coding-agent adapter, a local
Doc Bridge index, adversarial code review, and a dry-run tracking adapter. It
prints a structured result and never performs a network mutation.

For a real project, keep phase decisions in the kernel, select a named profile,
and provide integrations through adapters. Start with `mode: "dry-run"`, inspect
the evidence, then move to `safe` or `yolo` only after the preflight contract is
current.

## The keep-pushing loop, from nothing to a first tick

Four commands, in this order. Each one is safe to run again, and nothing before the
last one touches your repository, your tracker or your schedule.

### 1. `ak-harness loop init`

```bash
npx ak-harness loop init
```

It asks only what a preset cannot answer — the repository, the project name, the
Linear team and workspace, whose queue this machine drains — and writes
`loop.config.yaml` from one of five presets (`web-app`, `library`, `monorepo`,
`data-pipeline`, `mobile`). Everything the preset already says is left out of the
file, so the config diff shows what *this* project decided.

Use `--dry-run` to see the file it would write, `--preset <name>` to skip the
question, and `--global` to also create `~/.agentskit/harness.yaml` (providers,
binaries and notification channels, shared by every project on this machine — see
[ADR-0033](ADR-0033-four-config-layers-and-presets.md) for the four layers).

### 2. `ak-harness loop doctor`

```bash
npx ak-harness loop doctor
```

Nothing is dispatched. It checks Orca and its version, the provider CLIs and their
remaining usage, the routing decision for each role, this machine's free slots, the
Linear queue, the review CLI, the installed agents your registry points at, and the
flow profiles your rules reference. **Read this output before anything else** — it is
the answer to "why isn't it working" about nine times out of ten. Exit code 1 means
at least one check failed.

Then rehearse a tick without touching anything:

```bash
npx ak-harness loop tick --dry-run --max 1
```

It prints exactly what it would do: which issue, which contract, which worktree and
which model — and writes nothing.

### 3. `ak-harness loop install`

```bash
npx ak-harness loop install
```

The guided install: the doctor checks again, an optional dry-run rehearsal, an offer
to create `loop.config.local.yaml` for this machine, and then — after you confirm —
the Orca automations that run `loop stage tick` and `loop stage deliver` on the
schedule in `schedule.*`. It is idempotent by name, so running it again reconciles
rather than duplicates. `--dry-run` shows the exact `orca` argv and creates nothing;
`--yes` accepts every prompt for a non-interactive install.

### 4. The first real tick

The schedule will do this by itself from now on; running it once by hand is how you
watch it happen:

```bash
npx ak-harness loop tick --max 1     # contract → (plan → vote) → dispatch one issue
npx ak-harness loop watch --once     # what each in-flight issue is doing
npx ak-harness loop deliver          # PR → checks → review → definition of done → merge
```

Do not run `tick`/`deliver` by hand on a project whose automations already run them:
that races the scheduled run and can double-dispatch. Once installed, use the
read-only commands instead — `loop debrief` (what is the loop doing right now),
`loop observe` (anomalies and metrics), `loop retro --since 7d` (how it has been
doing), `loop paused` (what it stopped on).

The worker writes three files into its worktree at `.ak-loop/` — `plan.md`,
`verify.json` and `dod.json` — and the loop advances on those rather than on what a
terminal said. A missing one comes back to the worker as a fix round naming the file
([ADR-0035](ADR-0035-definition-of-done-two-lists.md)).

Full reference, including Orca automations, Doc Bridge and `agentskit-review` wiring:
[`LOOP.md`](LOOP.md). When something is stuck: [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md).

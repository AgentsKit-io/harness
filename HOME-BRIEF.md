# AgentsKit Harness — Home Page Design Brief

Hand this to a design session. It covers the hero animation and every section below it. The home page is the only
part of the site being designed separately; the docs shell, content and reference pages are built
separately.

## 1. What this page is

The home of `harness.agentskit.io`, a sibling of agentskit.io / registry.agentskit.io / doc-bridge.agentskit.io.
It must belong to that family visually while having its own gesture.

**Product, in one sentence:** the harness runs your software delivery loop unattended — a vague objective becomes
a PRD, a design, issues, worked code, a reviewed pull request, a merge, and a release — and a human acts in
exactly five places.

**Audience:** engineers and engineering leads who already use coding agents and are tired of babysitting them.
They are sceptical of autonomy claims. Precision converts them; enthusiasm does not.

**The one thing a visitor must understand in five seconds:** requirements go in at the top, shipped code comes out
at the bottom, and it loops.

## 2. Voice

Declarative and specific. Every claim checkable. No adjectives that cannot be verified, no "revolutionary", no
"seamless". Where the product has a limit, say the limit — the limits are the credibility. Sentence case for
headings, no exclamation marks.

## 3. Design tokens

Inherit the ecosystem's dark-first, GitHub-derived palette.

| Token | Value |
|---|---|
| Accent | `#F778BA` — the harness's slot in the ecosystem palette |
| Background / surface / border | `#0D1117` / `#161B22` / `#30363D` |
| Foreground / muted | `#E6EDF3` / `#8B949E` |
| Semantic | blue `#58A6FF`, green `#2EA043`, red `#F85149` |
| Display type | Space Grotesk, `letter-spacing: -0.02em` |
| Body | Inter |
| Mono | JetBrains Mono |
| Signature microcopy | mono, `11px`, uppercase, `tracking-[0.2em]` — every section eyebrow and every label |
| Radii / motion | `0.375rem`–`1rem`; `120ms / 200ms / 320ms`, `cubic-bezier(0.4, 0, 0.2, 1)` |

Section anatomy, repeated throughout: mono uppercase eyebrow → large display `h2` → one muted sentence → the
visual.

## 4. Global constraints

- **Static export.** No server, no live data. Any number on this page is baked at build time from a file in the
  repository, or it does not appear.
- **No invented metrics.** No fake dashboards, no adoption counts, no "10× faster". If we cannot prove it, we do
  not draw it.
- **`prefers-reduced-motion` is honoured everywhere**: every animation resolves to a complete, legible final frame.
- **Every animated figure has a visible play/pause control** and a screen-reader description, because the
  animation carries meaning.
- **Keyboard navigable.** Every diagram node that links somewhere is a real `<a>`.
- **Technique:** HTML elements for boxes and text (real, selectable, accessible); an SVG overlay for connectors
  only, using `preserveAspectRatio="none"`, `pathLength={100}`, `vectorEffect="non-scaling-stroke"`. CSS keyframes
  for the diagrams; Motion (framer) only for scroll reveals.

---

## 5. Section 1 — Hero

### Copy

- Eyebrow: `THE KEEP-PUSHING LOOP`
- `h1`: **AgentsKit Harness**
- Subhead (display, large): **The keep-pushing loop for your SDLC.**
- Body: *From a vague objective to production without babysitting an agent — interview, plan, votes, worker,
  review, merge, release. Every transition is the machine's decision over an explicit state. A human acts in five
  places, and only where something touches the world.*
- Primary CTA: copy-block `npx @agentskit/harness loop init`
- Secondary: **Read the docs** · Tertiary: **See a run** (anchors to section 4)

### The animation: a vertical factory

Requirements enter at the top, descend through levels, transform at each one, and leave as shipped code. A thin
return stroke climbs the edge and restarts the cycle — the loop is shown by the return path, not by a circle.

**Two overlapping effects on every connector.** The stroke itself pulses (short `stroke-dasharray` with animated
`stroke-dashoffset` — the travelling-dots idiom from agentskit.io). Riding the same path, an ~18px glyph moves via
`offset-path: path(…)` + `offset-distance`. The stroke says *something is flowing*; the glyph says *what*.

| Level | Node | Glyph that descends from it |
|---|---|---|
| 0 | The vague objective, as typed text | `¶` text lines |
| 1 | A document assembling itself — `PRD` · **human gate** | document |
| 2 | A technical design (linked boxes) · **human gate** | blueprint |
| 3 | **The fan-out**: 2–4 parallel assembly lines, each a shimmering terminal | issue card, one per line |
| 4 | Convergence into one thick integration branch, review stamp | `</>` code |
| 5 | Production · **human gate** · a green pulse floods the final bar | merged check |

**The return.** From level 5 a thin stroke climbs the edge carrying a `↻` glyph, reaching level 0. This is not
decoration: it is the retro tuning the next cycle, which is how the product actually works. When it arrives, **the
objective text at the top changes to a different one**, reinforcing that any objective enters here.

### Beat sheet — about 10s, then the return, then restart

| t | Beat |
|---|---|
| 0.0s | A caret types the level-0 objective |
| 1.0s | The sentence contracts; connector 0→1 pulses, the text glyph descends |
| 1.8s | The PRD document draws itself line by line. Human glyph lights, **everything stops**, check, resume |
| 2.8s | The document glyph descends; the design assembles. Human gate, pause, check |
| 4.0s | **Fan-out** — the single stroke opens into N branches, each carrying an issue card |
| 4.8s | The assembly lines work in parallel, terminals shimmering slightly out of phase |
| 6.0s | Each line emits `</>`. **One of them goes back up one level**, takes a fix-round stamp, and only then descends |
| 7.5s | The branches converge; the integration line thickens |
| 8.5s | Final human gate, pause, then the green pulse runs to "production" |
| 9.5s | The return stroke climbs with `↻`; the top objective changes; restart |

**The three pauses at the gates are the product's whole argument** — they are not dead time, they are the message.
**The line that goes back once** is what separates this from magical marketing. Neither may be cut for smoothness.

**Rotating objectives** (level 0, one per cycle): *"let ops see whether the service is alive"* · *"cut the checkout
timeout"* · *"add SSO to the admin app"* · *"stop the nightly job from double-charging"*.

**Responsive:** 4 assembly lines on desktop, 3 on tablet, 2 on mobile; the fan-out is the only element that
changes count. The return stroke moves from the right edge to a short curved arrow at the bottom-left on mobile.

**Reduced motion:** every level drawn at once, glyphs resting at their nodes, the return stroke static with an
arrowhead.

**Each node links** to its concept page (`/docs/concepts/stages/plan`, `…/tick`, `…/deliver`, `…/release`), so the
hero doubles as the site's index.

---

## 6. Section 2 — What it costs you

- Eyebrow: `THE HUMAN PART`
- `h2`: **Five places where you act. Nowhere else.**
- Body: *Everything that touches the world keeps a person in front of it. Everything else is the machine's
  decision over an explicit state.*

Five numbered cards, each with its exact command:

| # | Gate | Command |
|---|---|---|
| 1 | The PRD is approved | `loop plan approve <id>` |
| 2 | The technical design is approved, after 2 of 3 agents agree | `loop plan approve-design <id>` |
| 3 | An issue enters the queue (`Todo → Ready`) | a gesture in your tracker |
| 4 | A pull request is approved — only if the flow asks for it | on GitHub |
| 5 | A release batch is promoted and deployed | `loop release approve` |

Beside them, the hero figure reused in `mode="gates"`: the factory dims, the five gate points light, and payloads
visibly **stop** at each until hovered.

*Angle: invert the usual pitch. Everyone else says "look how much it does". Lead with how little you have to do,
and be exact — vagueness here reads as a lie.*

---

## 7. Section 3 — Inside one issue

- Eyebrow: `PER ISSUE`
- `h2`: **A plan, voted on, before any worker starts.**
- Body: *The planner writes the plan and three agents vote on it — in the harness, headless, before a worktree
  exists. The model produces the plan and the votes; the machine counts them and decides.*

A horizontal track: **planner → 3 voters (fan-out, fan-in) → build → verify → review → Definition of Done → PR**.
The vote node shows 2 of 3 approving; a retry edge loops back, labelled *"max 3 cycles, then it's a human's
problem"*.

Three supporting facts as small mono lines beneath:

- *A rejecting vote must carry a concrete objection. One that cannot be answered is discarded, not counted.*
- *Both Definition of Done lists — the project's and the issue's — are proven on the PR before it merges.*
- *Three models disagreeing three times is an ambiguous requirement, not a retry.*

---

## 8. Section 4 — See a real run

- Eyebrow: `EVIDENCE`
- `h2`: **This is the actual output.**
- Body: *Recorded from a real run. Nothing here is a mock-up.*

A terminal card (three dots, filename, play/pause pill) replaying a captured session with a typing cursor:
`loop stage tick` → contract frozen → worker dispatched → PR opened → review clean → merged. About 40 seconds,
scrubbable.

Implementation: a `<pre>` driven by `requestAnimationFrame` over a typed array of recorded lines — no xterm
dependency. Under reduced motion, the full transcript renders instantly.

**Honesty rule:** any line not actually captured must be visibly labelled as reconstructed. This should be the
longest dwell time on the page; it is the only section that proves the thing runs.

---

## 9. Section 5 — Same engine, priced differently

- Eyebrow: `FLOW PROFILES`
- `h2`: **Not every change deserves the same ceremony.**

Three selectable cards — **enterprise · poc · incident**. Selecting one **re-prices the hero figure live**: vote
nodes appear or vanish, the CI node lights or dims, gates switch on or off.

| | enterprise | poc | incident |
|---|---|---|---|
| Plan votes | 3 | 1 | skipped |
| CI babysitting | on | off | off |
| Human PR approval | yes | no | no |
| Fix rounds | 2 | 1 | 2 |

Below: *`merge.requireChecks: false` is the difference between an enterprise flow and a POC one.* — shown as a
one-line diff.

*This is the most interesting interaction on the page: one control, and the whole picture changes.*

---

## 10. Section 6 — The night shift *(optional; cut this before cutting anything else)*

- Eyebrow: `WHILE YOU SLEEP`
- `h2`: **It keeps pushing.**

A 24-hour band. Dispatches, reviews and merges appear along it as time advances; the 02:00–06:00 stretch is
marked. At 09:00 the band shows what is waiting: merged pull requests, and the one item that needs a person.

*No product in this ecosystem has a visual about time, and time is exactly what this one sells.*

---

## 11. Section 7 — Connectors

- Eyebrow: `SEAMS`
- `h2`: **It does not name your vendor.**

| Interface | Implementations |
|---|---|
| `TrackerConnector` | Linear |
| `ScmConnector` | GitHub |
| `RunnerConnector` | Orca · **local** |

Callout on the local runner: *git worktree + tmux + the system crontab. No daemon, no Orca. An interface with one
implementation is a guess.*

Visual: a static flow (engine → interfaces → implementations). Static is correct here; it is a type diagram, not a
process.

---

## 12. Section 8 — For agents

- Eyebrow: `MACHINE SURFACES`
- `h2`: **Readable by the things that will read it.**

Three compact links: `/llms.txt` · raw Markdown for every page · the CLI's JSON contract (`--json` on every
command). One line: *Every command that reports also reports as JSON, and every page has a raw Markdown twin.*

Small, but it signals the ecosystem's posture and costs almost nothing.

---

## 13. Section 9 — Final CTA and footer

- `h2`: **Start the loop.**
- The install command again, **Read the docs**, **GitHub**.
- Then the shared ecosystem bar (loaded from `https://www.agentskit.io/ecosystem-bar.js`, `data-current="harness"`),
  then the site footer built from the local `ecosystem.json`.

---

## 14. Component inventory

| Component | Used by |
|---|---|
| `<LoopFactory/>` — the hero, with `mode: 'flow' \| 'gates' \| 'profile'` | sections 1, 2, 5 |
| `<PipelineTrack/>` | section 3 |
| `<RunReplay/>` | section 4 |
| `<NightShift/>` | section 6 (optional) |
| `<InstallCommand/>` — tabbed, copy button | sections 1, 9 |
| `<FadeIn/>` / `<Stagger/>` | all section reveals |

Three components carry the page. Everything else is layout.

## 15. What not to do

Fake dashboards. Invented numbers. Stock AI imagery — no brains, no neural meshes, no glowing orbs.
Gradient-on-gradient. Motion without meaning: if an element moves, the movement must say something the static
frame cannot.

---

## 16. Open questions

1. **Licence and price.** The siblings are MIT and free; the harness is not published yet. Until answered, the
   page states nothing about licensing.
2. **Is there any true number for a stats band?** The siblings expose `/api/stats.json`. The only provable facts
   today are the version, the licence and the test count. Without more, the band does not exist.
3. **Is "The keep-pushing loop for your SDLC" final as the subhead?** Fixed by the roadmap; treated as final.
4. **The recorded run for section 4 does not exist yet.** Only read-only commands can be genuinely captured; the
   dispatch and merge lines will be labelled as reconstructed unless a real write run is authorised.

# ADR-0033: Four configuration layers, and why the project outweighs the global

## Status

Accepted

## Context

One person runs the loop on several repositories from one machine; one repository is
run by several people, on machines that differ. A single `loop.config.yaml` forces
either machine details into the repository (a path that only exists on one laptop) or
project decisions into a personal file (invisible to everyone reviewing the repo).

## Decision

Four layers, merged in order and validated **once, as one config**
(`composeLoopConfig`):

1. `~/.agentskit/harness.yaml` — the person and the machine's defaults: providers,
   binaries, notification channels.
2. `loop.config.yaml` — the project. Versioned, reviewed, the same for everyone.
3. `loop.config.team.<key>.yaml` — what diverges inside one repository per team.
4. `loop.config.local.yaml` — this machine, gitignored.

**The project outweighs the global layer.** A decision the repository states — the
verification command, the base branch, the definition of done, the protected paths —
is a decision a reviewer approved; a personal default must never quietly override it
on one contributor's machine. The machine layer comes last because it describes
facts about this machine, not about the work.

`loop init` writes the project layer from one of five presets (`web-app`, `library`,
`monorepo`, `data-pipeline`, `mobile`). A preset is a set of defaults, not a
template to fill in: everything the preset already says is left unsaid in the file
that is written, so a config diff shows only what this project decided differently.

## Consequences

`loop validate` prints the effective config, which is the only one that matters, and
`loop doctor` reports which layers were found. Two configs that look different on
disk can be identical in effect, so every report quotes the effective value rather
than the file. A layer nobody uses costs nothing: an absent file is not an error.

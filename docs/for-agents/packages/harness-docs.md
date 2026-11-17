---

type: package
package: harness-docs
editRoot: docs
checks: [pnpm docs:generate --check]
---

# harness-docs

`docs` — Repository design docs, ADRs, stability records and the agent handoffs.

## Change rules

- Keep changes inside `docs` scoped to the ticket; regenerate any derived artifact in the same change.
- Add a `changelog.d/<ticket>.md` fragment instead of editing `CHANGELOG.md`.

## Check

`pnpm docs:generate --check`

---

type: package
package: harness-experimental
editRoot: experimental
checks: [pnpm typecheck]
---

# harness-experimental

`experimental` — Experimental cycle, discovery and pilot code kept outside the stable API.

## Change rules

- Keep changes inside `experimental` scoped to the ticket; regenerate any derived artifact in the same change.
- Add a `changelog.d/<ticket>.md` fragment instead of editing `CHANGELOG.md`.

## Check

`pnpm typecheck`

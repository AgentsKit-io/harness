---

type: package
package: harness-capabilities
editRoot: capabilities
checks: [pnpm test:capabilities]
---

# harness-capabilities

`capabilities` — Generated public-surface capability manifest.

## Change rules

- Keep changes inside `capabilities` scoped to the ticket; regenerate any derived artifact in the same change.
- Add a `changelog.d/<ticket>.md` fragment instead of editing `CHANGELOG.md`.

## Check

`pnpm test:capabilities`

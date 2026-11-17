---

type: package
package: harness-compatibility
editRoot: compatibility
checks: [pnpm test]
---

# harness-compatibility

`compatibility` — Compatibility manifest, report and migration/rollback notes.

## Change rules

- Keep changes inside `compatibility` scoped to the ticket; regenerate any derived artifact in the same change.
- Add a `changelog.d/<ticket>.md` fragment instead of editing `CHANGELOG.md`.

## Check

`pnpm test`

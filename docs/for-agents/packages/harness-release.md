---

type: package
package: harness-release
editRoot: release
checks: [node scripts/verify-release-evidence.mjs]
---

# harness-release

`release` — Release manifest, notes and qualification evidence.

## Change rules

- Keep changes inside `release` scoped to the ticket; regenerate any derived artifact in the same change.
- Add a `changelog.d/<ticket>.md` fragment instead of editing `CHANGELOG.md`.

## Check

`node scripts/verify-release-evidence.mjs`

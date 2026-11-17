---

type: package
package: harness-examples
editRoot: examples
checks: [node scripts/verify-harness-examples.mjs]
---

# harness-examples

`examples` — Runnable loop configs and minimum-profile samples.

## Change rules

- Keep changes inside `examples` scoped to the ticket; regenerate any derived artifact in the same change.
- Add a `changelog.d/<ticket>.md` fragment instead of editing `CHANGELOG.md`.

## Check

`node scripts/verify-harness-examples.mjs`

---

type: package
package: harness-skills
editRoot: skills
checks: [pnpm test:loop]
---

# harness-skills

`skills` — Agent skills shipped with the harness (loop skill).

## Change rules

- Keep changes inside `skills` scoped to the ticket; regenerate any derived artifact in the same change.
- Add a `changelog.d/<ticket>.md` fragment instead of editing `CHANGELOG.md`.

## Check

`pnpm test:loop`

---
type: package
package: ecosystem-manifest
editRoot: ecosystem.json
checks: [node scripts/verify-ecosystem-public-outputs.mjs]
---

# Ecosystem manifest

`ecosystem.json` is the shared product catalog: the AgentsKit products, their navigation order, metadata and
public URLs. `ecosystem-claims.json` holds the verifiable public claims (counts and their evidence) for each
product; it is wired in as the claims file of the Documentation Standard check. The manifest feeds the site shell.

## Who reads it

- `apps/docs/lib/shell.ts` imports `ecosystem.json` and builds the products shown in the site bar, tour and
  footer (the ones with `navigation.showInBar`).
- `apps/docs/components/home/ecosystem.tsx` renders the ecosystem section of the home page from that product list.
- `scripts/build-docs-artifacts.mjs` reads it when writing the machine-readable site surfaces.
- `scripts/generate-doc-bridge-config.mjs` names it as the `ecosystemContract` manifest for the Documentation
  Standard check.

## Change rules

- Keep the header order `agentskit → registry → agentskit-chat → doc-bridge → code-review → harness`; Playbook
  stays catalogued with `navigation.showInBar: false`.
- Do not add private or unreleased products. The verifier rejects public AKOS metadata.
- A claim needs evidence in `ecosystem-claims.json`; do not raise a number without it.

## Check

`node scripts/verify-ecosystem-public-outputs.mjs` validates the header order, the Playbook and Code Review
navigation flags, and the public outputs that mention the products.

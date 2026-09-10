# Repository organization

This is a TypeScript library and CLI, not an Angular application. We adopt the
Angular team's Conventional Commits standard and a capability-first layout so
the repository stays navigable without speculative layers.

```text
.
├── src/
│   ├── index.ts          # supported package API
│   ├── cli.ts            # ak-harness / ak-verify commands
│   ├── adapters/         # optional integrations
│   └── <capability>.ts   # contract, evidence, delivery, runtime, metrics...
├── test/                 # deterministic tests and fixtures
├── scripts/              # real CLI, packaging, and repository checks
├── docs/                 # ADRs and this organization contract
├── .codex/               # verification contract and local run state
└── .github/              # CI and release workflows
```

## Boundaries

- Import internal modules with explicit relative paths; only `src/index.ts`
  is supported for consumers.
- Add a directory when a capability has multiple cohesive modules. Do not add
  a layer for one file.
- Adapters may depend on the kernel; the kernel must not depend on adapters or
  external providers.
- Tests may use internal modules when exercising a boundary, but consumer
  checks must import the package entry point.
- Generated output belongs in `dist/` and is ignored by Git; npm generates it
  during the release gate.

## Naming

Use kebab-case filenames, PascalCase exported types/classes, camelCase
functions, and descriptive test names that state behavior and condition.

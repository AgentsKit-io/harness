# Repository organization

This is a TypeScript library and CLI, not an Angular application. We adopt the
Angular team's Conventional Commits standard and a capability-first layout so
the repository stays navigable without speculative layers.

```text
.
├── src/
│   ├── index.ts          # supported package API
│   ├── cli.ts            # ak-harness / ak-verify commands
│   ├── kernel/           # deterministic contracts and decisions
│   ├── execution/        # filesystem, runtime, evidence, and run plumbing
│   ├── context/          # context contracts and provider slot
│   ├── delivery/         # delivery gates and PR projection
│   ├── profiles/         # configuration profiles
│   └── adapters/         # optional integrations
├── test/                 # deterministic tests and fixtures
├── scripts/              # real CLI, packaging, and repository checks
├── capabilities/         # generated public-surface capability manifest
├── docs/                 # ADRs and this organization contract
├── .codex/               # verification contract and local run state
└── .github/              # CI and release workflows
```

## Boundaries

- Import internal modules with explicit relative paths; only `src/index.ts`
  is supported for consumers.
- Keep deterministic decisions in `kernel/`; execution mechanics and external
  effects live behind the other capability boundaries.
- A single-file capability may use an `index.ts` boundary when it has a
  distinct public contract; do not add speculative layers.
- Adapters may depend on the kernel; the kernel must not depend on adapters or
  external providers.
- Tests may use internal modules when exercising a boundary, but consumer
  checks must import the package entry point.
- Generated output belongs in `dist/` and is ignored by Git; npm generates it
  during the release gate.

## Naming

Use kebab-case filenames, PascalCase exported types/classes, camelCase
functions, and descriptive test names that state behavior and condition.

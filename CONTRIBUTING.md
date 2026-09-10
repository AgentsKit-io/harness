# Contributing to `@agentskit/harness`

The Harness is an enforcement engine, not a suggestion library. Changes must
preserve fail-closed behavior and produce criterion-level evidence.

## Repository layout

- `src/`: capability-oriented TypeScript modules and the public `index.ts`.
- `src/adapters/`: optional provider integrations.
- `test/`: deterministic unit and contract tests.
- `scripts/`: real CLI and packaging checks.
- `docs/`: ADRs and protocol decisions.
- `.github/`: CI and release automation.

See [docs/ORGANIZATION.md](./docs/ORGANIZATION.md) for the complete boundary
and naming rules.

## Change workflow

1. Start from an issue or explicit task contract.
2. Identify the outcome and executable validation it requires.
3. Keep the public API change in `src/index.ts` intentional.
4. Add or update criterion-level tests for behavior changes.
5. Update README, changelog, ADRs, or the verification contract when the
   protocol changes.
6. Run the complete local gate:

   ```bash
   pnpm typecheck
   pnpm test
   pnpm build
   pnpm pack --pack-destination /tmp/agentskit-harness-pack
   ak-verify run --config .codex/verification.json --json
   ```

Do not report completion while a required gate is unavailable, blocked, stale,
or awaiting approval.

## Angular Conventional Commits

Commit messages follow the Angular Conventional Commits format:

```text
<type>(<scope>): <imperative description>
```

Allowed types are `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `ci`,
`perf`, `chore`, and `revert`. Use a breaking-change footer when needed:

```text
feat(cli)!: reject incomplete evidence

BREAKING CHANGE: `run` now exits non-zero when evidence is missing.
```

Keep commits focused. Never commit secrets, generated `dist/`, verification
state, or residue from another task.

## Pull requests

PRs must state the contract change, affected states, evidence produced, exact
commands executed, and any unresolved blockers. A maintainer review is required
for public API, CLI, state-machine, security, or release changes.

## Releases

Version changes merge to `main` through a PR. The release workflow runs tests,
build, and pack, then publishes through npm Trusted Publishing (GitHub OIDC);
no `NPM_TOKEN` is used. Configure the npm trusted publisher for
`AgentsKit-io/harness` once before the first release.

## License

Contributions are accepted under the repository's MIT license.

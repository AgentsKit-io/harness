#!/usr/bin/env bash
# Checks that need the build: build, public API, pack dry-run and the repository's own contract run.
set -euo pipefail
pnpm build
pnpm check:public-api
pnpm pack --pack-destination "${RUNNER_TEMP:-/tmp}/agentskit-harness-pack"
# `--by human` on a machine: the repository's own contract re-enacted as a fixture to exercise the CLI end to end.
# The approval a human actually made is the one in `.ak-harness/verification.json`, in the tree, reviewed.
node dist/cli.js plan approved --by human --config .ak-harness/verification.json --json
node dist/cli.js start --config .ak-harness/verification.json --json
node dist/cli.js run --config .ak-harness/verification.json --json

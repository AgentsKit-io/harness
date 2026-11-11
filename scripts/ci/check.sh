#!/usr/bin/env bash
# Static checks: typecheck (cross-platform check + tsc for the package and the UI).
set -euo pipefail
pnpm typecheck

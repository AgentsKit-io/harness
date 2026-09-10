# Troubleshooting

## `STALE`

The source, contract, or context changed after verification. Run `ak-verify`
again; do not reuse the old evidence bundle.

## `BLOCKED` or `AWAITING_HUMAN_APPROVAL`

Inspect the structured run with `ak-harness status --json`. Resolve the listed
ambiguity, failed gate, missing evidence, or approval, then rerun verification.
YOLO only removes unnecessary pauses; it does not bypass a required safety or
provenance gate.

## Missing adapter telemetry

Return `status: "unknown"` for measurements you cannot observe. Unknown values
are excluded from improvement claims and can block a configured quality gate.

## Runtime failures

Use the process runtime for a local shell-free boundary or the Docker runtime
when isolation is required. Both report timeout, cancellation, output-limit,
and non-zero-exit failures as structured evidence.

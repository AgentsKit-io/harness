# Compatibility migration rehearsal

The manifest pins package versions and source revisions before an integration
run. Execute each component's `testCommand` and `evalCommand` from a clean
checkout, then attach the output to `compatibility/report.json` and compare it
with the declared previous version and no-Harness baseline.

This file is the reproducible procedure; it is not evidence of a successful
upstream run by itself. Missing or stale command output remains `unknown` and
blocks the compatibility gate.

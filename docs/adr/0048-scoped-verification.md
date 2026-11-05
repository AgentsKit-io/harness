# ADR-0048: Verify the criterion touched, not the whole contract

- Status: accepted
- Date: 2026-11-05
- Source: `AGENTS.md`, section "Verification contract" (`scope:` house convention)

## Context

`.ak-harness/verification.json` has 22 checks. Running all of them on every
edit was the largest source of wasted time and tokens in this repository.
The `test:*` scripts and the contract's criteria are not one-to-one.

## Decision

A task carries an explicit scope and runs the narrow script or test that covers
what it touched. Only the PR that closes an issue runs the complete contract
(`ak-verify run --config .ak-harness/verification.json --json`).

## Consequences

Faster iteration. Picking the script is a judgement call. A failed, stale,
blocked or approval-pending full run still means the work is not complete.

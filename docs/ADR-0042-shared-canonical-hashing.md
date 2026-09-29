# ADR-0042: Shared canonical hashing

**Status:** Accepted

## Context

The Harness duplicated SHA-256 and JSON hashing. `JSON.stringify` preserves key
insertion order, so equivalent objects could produce different fingerprints.
Harness state and signed evidence bundles also contain hashes written by older
releases.

## Decision

Use `@agentskit/core/hash` for SHA-256 and RFC 8785 canonical JSON. Newly written
artifact, event, status, manifest, and evidence-bundle fingerprints use canonical
JSON. Readers accept both canonical hashes and the previous `JSON.stringify`
hashes. Persisted identity keys and the existing `artifactDigest` helper keep the
old algorithm until their state/API format has a versioned migration.

## Consequences

The Harness adds `@agentskit/core` as a runtime dependency. Canonical hashes no
longer depend on object insertion order. The small legacy hashing path remains
to preserve stored IDs and validate existing state; remove it after a versioned
state migration.

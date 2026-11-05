# ADR-0002: Kernel stays provider-neutral

- Status: accepted
- Date: 2026-11-05
- Source: `AGENTS.md`, section "Boundaries"; related: `docs/ADR-0026-kernel-adapters-boundary.md`

## Context

The package enforces SDLC contracts. Coupling it to a tracker, SCM or model
provider would make gates depend on external services.

## Decision

The kernel takes no direct dependency on Linear, GitHub, Orca, Doc Bridge or a
model provider. Integrations live in `src/adapters/` and must not weaken
kernel gates. Required gates fail closed; missing evidence is not success.

## Consequences

Providers are swappable and gates are deterministic. Integrations need an
adapter, which costs a little extra code.

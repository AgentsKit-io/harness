# ADR-0028: MCP is an adapter-only boundary

## Status

Accepted — 2026-09-11.

## Context

MCP (Model Context Protocol) is a useful integration surface for read-only
inspection and, later, gated tool calls. The keep-pushing loop and kernel must
remain usable without any MCP host, SDK, or network dependency. MODULE-BOUNDARIES
and ADR-0026 already classify MCP as an adapter concern; 0.6.0 needs an
explicit decision before any public bridge ships.

## Decision

1. **Adapter-only.** MCP lives under `src/adapters/mcp.ts` (and future adapter
   modules). Kernel modules do not import MCP clients, hosts, or transports.
2. **Default-deny policy.** Every tool call goes through an allowlist
   (`allowTools`) and a `PolicyGate` (or compatible `evaluate`). Missing
   allowlist entry or non-`allow` decision returns `{ status: 'blocked' }`
   without invoking the underlying call.
3. **Read-only profile first.** The initial public surface is a policy-gated
   call bridge intended for read-only / inspection tools. Mutating MCP tools
   require a later ADR covering authorization, idempotency, and audit evidence.
4. **Harness works without MCP.** Default loop config keeps `mcp.enabled: false`.
   No MCP process is started by install, tick, or deliver.
5. **Not wired into loop tick/deliver in 0.6.0.** The bridge is exported for
   composition and future CLI/doctor use. Tick and deliver must not call it in
   this release.

## Consequences

- Consumers can plug MCP behind the same policy gate used by session tool
  recording without coupling the kernel to a vendor host.
- Loop automation remains deterministic and offline-testable when MCP is off.
- A later release may wire a read-only MCP profile into doctor or a dedicated
  CLI after eval coverage; mutating tools stay out until gated separately.

## Alternatives considered

- **Kernel MCP host:** rejected; violates ADR-0026 and forces an optional
  network dependency into deterministic gates.
- **Wire MCP into tick/deliver now:** rejected for 0.6.0; needs allowlist
  provenance, audit events, and eval coverage first.

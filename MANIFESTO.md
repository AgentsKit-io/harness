# Harness Manifesto

## The boundary

The Playbook explains good practice. The Harness makes the SDLC observable and
enforceable. Advice may be ignored; a required gate may not.

## The guarantees

1. A task starts from an explicit, frozen contract.
2. Ambiguities are surfaced with options and a recommendation; the Harness
   never invents product decisions.
3. Every required check produces structured evidence bound to source, config,
   and contract hashes.
4. A failed or missing gate blocks progression and remains auditable.
5. Recovery resumes from the journal without silently replaying uncertain work.
6. Integrations are replaceable adapters, not hidden kernel dependencies.
7. Measurements report what was observed, including unavailable data.

## Operating principle

Automate everything deterministic. Escalate only decisions that require human
judgment. Keep the smallest mechanism that proves the claim.

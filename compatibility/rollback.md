# Compatibility rollback rehearsal

Rollback is a clean checkout at the pinned `previousVersion`, followed by the
same adapter-boundary smoke and eval commands. Record the resulting revision,
commands, exit codes, and evidence digest in `compatibility/report.json`.

No external mutation is performed by the Harness. A missing rehearsal record
is `unknown` and blocks release rather than being inferred as a pass.

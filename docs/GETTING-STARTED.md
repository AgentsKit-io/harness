# Getting started

Install the package, then run the included consumer example:

```bash
pnpm add -D @agentskit/harness
pnpm build
node examples/minimum-profile.mjs
```

The example uses a fake profile in YOLO mode, a coding-agent adapter, a local
Doc Bridge index, adversarial code review, and a dry-run tracking adapter. It
prints a structured result and never performs a network mutation.

For a real project, keep phase decisions in the kernel, select a named profile,
and provide integrations through adapters. Start with `mode: "dry-run"`, inspect
the evidence, then move to `safe` or `yolo` only after the preflight contract is
current.

---
name: check-acp-typescript-sdk
description: Check the current official Agent Client Protocol TypeScript SDK reference implementation, including runtime behavior, lifecycle semantics, error handling, tests, and API patterns. Use when behavior must be compared with the latest TypeScript reference behavior or you need to understand how to use the TypeScript SDK. Do not use it as the source of truth for protocol schemas or specification text.
---

# Check the ACP TypeScript SDK

Use the official [Agent Client Protocol TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk) as the reference implementation for ACP runtime behavior.

The TypeScript SDK is implementation evidence, not the normative protocol specification. Use the separate specification skill for current documentation, RFDs, and protocol models or schemas. If the implementation and specification disagree, report the discrepancy instead of silently treating the TypeScript behavior as the protocol contract.

## Locate the repository

The `.repo` file next to this `SKILL.md` is gitignored and contains one absolute path to a local clone of the TypeScript SDK repository. Read and trim that path before doing any reference-implementation research.

If `.repo` does not exist, explicitly ask the user for permission to clone the repository and for their preferred clone location. Do not clone it until permission is granted. If the user grants permission without choosing a location, clone the repository as `acp-typescript-sdk` beside the current ACP checkout. After cloning, write the clone's absolute path to `.repo`.

If `.repo` exists but its value does not identify a usable Git checkout, report the problem and ask the user whether to correct the path or create a clone. Do not silently replace an existing checkout.

## Refresh before research

Before exploring or searching the local TypeScript SDK checkout, update it:

```bash
git -C "<absolute path read from .repo>" pull --ff-only
```

Run this on every use of the skill, even if the checkout was used recently. If the pull fails, report the failure and do not describe the checkout as current. Do not discard local changes, reset branches, or otherwise repair the checkout without the user's authorization.

After the pull succeeds, read the checkout's applicable `AGENTS.md` or other agent-guidance files before researching it, including more specific guidance in subdirectories you inspect.

## Check the reference implementation

Trace the complete TypeScript behavior relevant to the question rather than relying on similarly named types or isolated functions:

- Start at the public API or protocol entry point and follow control flow through the owning runtime and transport layers.
- Read focused tests alongside the implementation to confirm observable behavior, failure handling, cancellation, cleanup, and ordering.
- Check examples when the question concerns supported API usage or lifecycle wiring.
- Check model and serialization code (e.g. Zod schemas or TypeScript type definitions) when it directly affects how the reference implementation consumes or produces protocol data.

Compare externally observable semantics rather than translating TypeScript structure mechanically. Account for Promise, event loop, and async/await behavior, error propagation, and shutdown rules explicitly when they affect parity.

Report the upstream revision checked and cite concrete repository-relative files and lines. Distinguish behavior demonstrated by code or tests from interpretation, and note any relevant version constraints or untested paths.

---
name: check-acp-specification
description: Check the current Agent Client Protocol specification, including its documentation, RFDs, Rust models, and JSON schemas. Use when ACP protocol behavior or models must be verified against the latest upstream specification. Do not use it as a Rust reference implementation.
---

# Check the ACP specification

Use the official [Agent Client Protocol repository](https://github.com/agentclientprotocol/agent-client-protocol) as the source of truth for current ACP documentation, design decisions, Rust models, and JSON schemas.

## Locate the repository

The `.repo` file next to this `SKILL.md` is gitignored and contains one absolute path to a local clone of the specification repository. Read and trim that path before doing any upstream research.

If `.repo` does not exist, explicitly ask the user for permission to clone the repository and for their preferred clone location. Do not clone it until permission is granted. If the user grants permission without choosing a location, clone `agent-client-protocol` beside the current ACP SDK checkout. After cloning, write the clone's absolute path to `.repo`.

If `.repo` exists but its value does not identify a usable Git checkout, report the problem and ask the user whether to correct the path or create a clone. Do not silently replace an existing checkout.

## Refresh before research

Before exploring or searching the local specification checkout, update it:

```bash
git -C "<absolute path read from .repo>" pull --ff-only
```

Run this on every use of the skill, even if the checkout was used recently. If the pull fails, report the failure and do not describe the checkout as current. Do not discard local changes, reset branches, or otherwise repair the checkout without the user's authorization.

After the pull succeeds, read the checkout's applicable `AGENTS.md` or other agent-guidance files before researching it, including more specific guidance in subdirectories you inspect.

## Check the source of truth

Choose the authoritative upstream evidence that matches the question:

- Use documentation for stated public behavior and concepts.
- Use RFDs for design intent, tradeoffs, and protocol evolution.
- Use JSON schemas for wire names, shapes, required fields, optionality, nullability, and unions.
- Use Rust model definitions as another representation of protocol data types and serialization shapes.

Trace related evidence across these sources when the question spans semantics and wire representation. Treat schemas and normative documentation as protocol contracts. Do not infer runtime behavior, lifecycle semantics, or reference implementation details from the Rust models.

Report the upstream revision checked, cite concrete repository-relative files and lines, and distinguish confirmed specification requirements from RFD proposals or Rust model representation details. If authoritative sources disagree, surface the discrepancy instead of choosing one without explanation.

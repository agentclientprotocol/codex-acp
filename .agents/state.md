# ACP v2 Migration — Implementation State

> Maintained by the orchestrator only (see `.agents/prompt.md`). Updated immediately after each
> slice/milestone completes. This file, plus `plan.md`/`architecture.md`/`research/*.md`, must be
> enough to resume this work from a fresh orchestrator run with no other context.

## Current position in the sequencing plan

Phase: **Prerequisite — not started.**

Next action: bump `@agentclientprotocol/sdk` from the installed `1.4.0` to `1.5.0`+ (fixes the v2
`PromptResponse.messageId` gap topic 2 found), then re-diff other v2 types against `origin/main`
at that version as a sanity check before starting Phase 1. See `plan.md`'s "Sequencing
recommendation" section for the full phase breakdown.

## Per-topic status

| # | Topic | Status | Milestone in progress | Next milestone | Notes |
|---|-------|--------|------------------------|-----------------|-------|
| — | SDK dependency bump (prerequisite) | Not started | — | Bump to 1.5.0+, re-diff types | Blocks everything below |
| 1 | Capability negotiation & `initialize` | Not started | — | `agentProtocolRouter` + `initializeV2` skeleton | Foundational; nothing else can be wired end-to-end without this |
| 2 | Prompt lifecycle & turn state machine | Not started | — | Milestone (a): `session/prompt` response redesign | Long pole — start early per plan.md |
| 3 | Cancellation semantics | Not started | — | — | Depends on topic 2's `state_update` fork existing |
| 4 | Permission requests & approvals | Not started | — | — | Depends on topic 2's `state_update` fork existing |
| 5 | Session lifecycle (new/resume/list/close/delete) | Not started | — | — | Depends on topics 1, 9 |
| 6 | Tool calls, messages & terminal streaming | Not started | — | Milestone (a): tool-call upsert fork at `ACPSessionConnection.update()` | Depends on topic 1 |
| 7 | MCP config & client execution surface removal | Not started | — | — | Depends on topic 1 |
| 8 | Auth flow rename | Not started | — | — | Depends on topic 1 |
| 9 | Config options, modes & plans | Not started | — | — | Depends on topic 1; topic 5 depends on this one |

## Deviations from `architecture.md`

None yet.

## Open questions sent to a researcher subagent

None yet.

## Shared prerequisites not owned by a single topic

- `ACPSessionConnection` needs to know which protocol version its underlying connection was routed
  to by `agentProtocolRouter`, so the choke point at `src/ACPSessionConnection.ts:18-23` can fork
  notification shapes for topics 2, 6, and 9 alike. Treat as part of topic 1's dispatch-layer work
  — track its completion here once topic 1 starts.
- 5 call sites bypass `ACPSessionConnection.update()` today (`CodexElicitationHandler.ts:221,228,556`,
  `CodexAcpServer.ts:2538,3312`) — re-route these before/during topic 6 so the v2 fork stays
  centralized instead of needing 5 extra duplicates.

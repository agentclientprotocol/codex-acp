# Native subagent sessions

This document describes the draft [ACP subagent RFD](https://github.com/agentclientprotocol/agent-client-protocol/pull/1992) as implemented by `codex-acp`. The implementation is in [codex-acp PR #419](https://github.com/agentclientprotocol/codex-acp/pull/419). The Claude reference is [claude-agent-acp PR #1017](https://github.com/agentclientprotocol/claude-agent-acp/pull/1017).

## Capability negotiation

Subagents require bilateral capability negotiation during `initialize`.

- The canonical client field is `clientCapabilities.subagents: {}`.
- The agent returns `agentCapabilities.sessionCapabilities.subagents: {}`.
- Because released SDKs may strip the draft field, AIR clients can instead advertise `nativeSubagentSessions` in `_meta.jetbrains.air.capabilities`; this adapter always advertises that key in its initialize response.
- New clients and agents must prefer the canonical field.

## Lifecycle events

- The adapter sends `subagent_spawned` before any child output.
- It uses the child session ID for later messages, thoughts, plans, tools, permissions, and elicitations.
- It sends one `subagent_state_update` on the immediate parent.
- The adapter advertises an empty child capability object. It does not support targeted child cancel or close operations.
- Child permission and elicitation controls remain visible through the root session.

## Session load

`session/load` reconstructs the child tree from Codex history. It reports an orphan as `disconnected` when the history does not prove an outcome. Live timeout, `shutdown`, and `notFound` fallbacks currently use `failed`; this differs from the draft rule for an unknown outcome.

## Legacy fallback

Without native negotiation, subagent lifecycle stays an ordinary ACP tool call. Child permission and elicitation requests stay on the root session.

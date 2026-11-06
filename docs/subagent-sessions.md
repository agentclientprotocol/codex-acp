# Native subagent sessions

This document describes standard ACP subagent sessions and the legacy AIR bridge implemented by `codex-acp`. The standard contract follows the [ACP subagent RFD](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/rfds/subagents.mdx); see [live standard sessions](https://github.com/agentclientprotocol/codex-acp/pull/682), [history replay](https://github.com/agentclientprotocol/codex-acp/pull/684), and [direct child cancellation](https://github.com/agentclientprotocol/codex-acp/pull/688).

## Capability negotiation

For clients other than AIR:

- ACP v2 enables standard subagent sessions without a client capability marker.
- ACP v1 requires `clientCapabilities.subagents: {}`. The agent advertises `agentCapabilities.sessionCapabilities.subagents: {}`.

AIR uses the separate [legacy bridge](#legacy-air-bridge), including on ACP v2.

## Standard lifecycle events

- The adapter announces a child with `subagent_update` on its immediate parent before any child output.
- It uses the child session ID for later messages, thoughts, plans, tools, permissions, and elicitations.
- Foreground-work state is reported in `subagent_update.state` on the immediate parent. ACP v2 also sends `state_update` on the child session.
- A child keeps its identity across idle periods and later work. Work ending does not close the child conversation.
- Agent-owned child input is not presented as human user input.

## Standard child controls

The initial announcement has `capabilities: {}`. While verified live child work can be interrupted, a later `subagent_update` grants `capabilities.cancel: {}`; `cancel: null` withdraws that grant.

Send `session/cancel` with the advertised child session ID to interrupt its work and active descendant work. Ancestors and siblings are unaffected. The adapter reports the outcome from provider events; the request alone does not mark work cancelled. Raw provider IDs, foreign children, and stale grants do not authorize cancellation.

Child prompt, close, and configuration mutations are not supported. Permission and elicitation requests use the child session ID.

## Standard history replay

ACP v1 `session/load` and ACP v2 `session/resume` with replay reconstruct the retained child tree and transcripts. Children are announced through their immediate parents before their output, and recorded turn outcomes are replayed as foreground-work state. Unavailable history does not prove completion.

History alone does not resume child work, grant cancellation, or recreate live permission and elicitation requests. Cancellation requires verified current runtime ownership and a live grant.

## Standard subagent directories

On standard subagent connections, directory information is part of `subagent_update` on the immediate parent. This applies to both ACP versions. It does not change AIR's legacy subagent events.

A verified loaded-child read reports its absolute `cwd`, including a worktree directory. Known child settings changes update that value. Announcements do not reset directory fields while readback is pending. Omission preserves a retained override; `null` would explicitly restore inheritance from the immediate parent, not report an unknown directory. Readback does not block child output, and a superseded read cannot replace newer settings.

The adapter verifies the child's ID, parent, and loaded state before accepting readback. It does not report relative paths or infer directories from provider IDs. Codex does not expose an authoritative ACP additional-directory list for children, so the adapter omits that field. It does not copy parent roots or treat writable sandbox paths as workspace roots. `[]` would mean explicitly no additional directories, not unknown directories.

## Legacy AIR bridge

AIR can advertise `nativeSubagentSessions` in `_meta.jetbrains.air.capabilities` on either ACP version. On ACP v1, `clientCapabilities.subagents: {}` also selects this bridge for AIR. The adapter advertises `nativeSubagentSessions` to AIR. See [AIR extensions](air-extensions.md#native-subagent-sessions).

- The adapter sends `subagent_spawned` before any child output and one terminal `subagent_state_update` on the immediate parent.
- It uses the child session ID for later messages, thoughts, plans, tools, permissions, and elicitations.
- The bridge advertises an empty child capability object and does not support targeted child cancel or close operations.
- Child permission and elicitation controls remain visible through the root session.

The legacy load path reports an orphan as `disconnected` when history does not prove an outcome. Live timeout, `shutdown`, and `notFound` fallbacks use `failed`.

## Legacy fallback

ACP v1 clients without the standard capability marker, and AIR clients without an applicable bridge signal, keep subagent lifecycle as an ordinary ACP tool call. Child permission and elicitation requests stay on the root session.

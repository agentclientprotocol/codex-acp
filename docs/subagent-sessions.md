# Native subagent sessions

This document describes the draft [ACP subagent RFD](https://github.com/agentclientprotocol/agent-client-protocol/pull/1992) as implemented by `codex-acp`. The implementation is in [codex-acp PR #419](https://github.com/agentclientprotocol/codex-acp/pull/419). The Claude reference is [claude-agent-acp PR #1017](https://github.com/agentclientprotocol/claude-agent-acp/pull/1017).

## Capability negotiation

Subagents require bilateral capability negotiation during `initialize`.

- The canonical client field is `clientCapabilities.subagents: {}`.
- The agent returns `agentCapabilities.sessionCapabilities.subagents: {}`.
- Because released SDKs may strip the draft field, AIR clients can instead advertise `nativeSubagentSessions` in `_meta.jetbrains.air.capabilities`; this adapter advertises that key to AIR in its initialize response. See [AIR extensions](air-extensions.md#native-subagent-sessions).
- New clients and agents must prefer the canonical field.

## Lifecycle events

- The adapter sends `subagent_spawned` before any child output.
- It uses the child session ID for later messages, thoughts, plans, tools, permissions, and elicitations.
- It sends one `subagent_state_update` on the immediate parent.
- The adapter advertises an empty child capability object. It does not support targeted child cancel or close operations.
- Child permission and elicitation controls remain visible through the root session.

## Session load

`session/load` reconstructs the child tree from Codex history. It reports an orphan as `disconnected` when the history does not prove an outcome. Live timeout, `shutdown`, and `notFound` fallbacks currently use `failed`; this differs from the draft rule for an unknown outcome.

## Standard subagent directories

On standard subagent connections, directory information is part of `subagent_update` on the immediate parent. This applies to both ACP versions. It does not change AIR's legacy subagent events.

A verified loaded-child read reports its absolute `cwd`, including a worktree directory. Known child settings changes update that value. Announcements do not reset directory fields while readback is pending. Omission preserves a retained override; `null` would explicitly restore inheritance from the immediate parent, not report an unknown directory. Readback does not block child output, and a superseded read cannot replace newer settings.

The adapter verifies the child's ID, parent, and loaded state before accepting readback. It does not report relative paths or infer directories from provider IDs. Codex does not expose an authoritative ACP additional-directory list for children, so the adapter omits that field. It does not copy parent roots or treat writable sandbox paths as workspace roots. `[]` would mean explicitly no additional directories, not unknown directories.

## Legacy fallback

Without native negotiation, subagent lifecycle stays an ordinary ACP tool call. Child permission and elicitation requests stay on the root session.

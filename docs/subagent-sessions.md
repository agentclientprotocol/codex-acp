# Native subagent sessions

`codex-acp` reports Codex subagents as ACP child sessions through one of two contracts. A connection gets one contract, never both.

- The **standard contract** follows the ACP [subagent sessions specification](https://agentclientprotocol.com/protocol/v2/subagents): `subagent_update`, `session_message`, and `session` tool call content.
- The **AIR legacy contract** serves Air v1 clients with `subagent_spawned` and `subagent_state_update`.

ACP v2 always uses the standard contract, including for Air clients.

Without either contract, a subagent stays an ordinary tool call on the root session. See [Fallback](#fallback).

## Standard contract

### Capability negotiation

- A v1 Client opts in with `clientCapabilities.subagents: {}`. Without it, the adapter sends none of the updates below.
- A v2 Client needs no capability. Subagent updates are part of the v2 session model.
- There is no Agent-side capability. The `initialize` response to a standard Client does not contain `agentCapabilities.sessionCapabilities.subagents`.

### Cancellation

- On ACP v2, `session/cancel` stops the selected child and its foreground descendants. It preserves listed background work and its requests.
- On ACP v1, child `session/cancel` also stops descendant work. Both versions preserve parent and sibling work.
- On ACP v2, root `session/cancel` stops foreground work, including foreground descendants. It preserves listed background work and its requests.
- Root `session/close` stops child work and withdraws child requests. ACP v1 retains recursive root cancellation.

### Association updates

- The adapter sends `subagent_update` on the immediate parent before any update, permission request, or elicitation that bears the child's session ID. Ancestors are announced before descendants.
- A child keeps one session ID across assignments, idle periods, and replay.
- `title` comes from the Codex agent path or thread name.
- `description` is the role that Codex assigned to the child (`agentRole`). It is omitted when Codex reports no role. It never holds the task prompt.
- `capabilities.cancel` is advertised only while the child's current turn can be interrupted. `session/cancel` with the child's ID interrupts that work. On v2 it skips listed [background work](background-work.md); a child terminal with its own `capabilities.cancel` can be stopped with `terminal/cancel` without interrupting the child turn. Other client-initiated requests for a child session are rejected.
- `state` reports `running`, `requires_action`, `idle` with a `stopReason`, or `unknown` when observability is lost. A v2 Client also gets the same `state_update` on the child session. There is no terminal child state.
- `cwd` is reported as described in [Directories](#directories).

### Delegated tasks

The task a session gives a child is reported as `session_message`, not as a user message and not in `description`.

- **Incoming view.** A `userMessage` item in the child's Codex thread is reported on the child session, before the child's response. `messageId` is the Codex item ID. `recipientSessionId` is the child.
- **Outgoing view.** A completed `spawnAgent`, `sendInput`, `sendMessage`, or `followupTask` collaboration call with a prompt is reported on the sender's session. `messageId` is `<item id>:to:<receiver thread id>`. A failed or interrupted call reports no message.
- **Linking.** The two views are linked with `senderMessageId` and `recipientMessageId` when the same text was observed for the same recipient on both sides and identifies one waiting view. Repeated identical text with several waiting views is left unlinked. Whichever view is observed second carries the reference, and a metadata-only `session_message` adds the reference to the first.
- The incoming view names `senderSessionId` only when it is linked. Codex does not record the sender on the child's item, so an unlinked incoming view names only its recipient. Subagents recorded only as `subAgentActivity` items have no prompt on the parent side, so their tasks have no outgoing view and no sender.
- Neither view is derived from the other. A view is reported only when its Codex item was observed.
- Message IDs are the same live and on replay.

### Collaboration tool calls

- The `spawnAgent` call is not shown. The announcement and the task message report the delegation.
- Other collaboration calls (`wait`, `sendInput`, `closeAgent`, and so on) stay visible on the sender's session. Their `content` holds one `{ "type": "session", "sessionId": ... }` entry for each receiver that is already announced. `rawInput` still holds the Codex thread IDs.

### Session load

`session/load`, and v2 `session/resume` with `replayFrom`, replay each recorded child conversation once, before the response. Replay reports the same announcements, session messages, and session references as the live path. The latest recorded turn outcome is historical state on the parent's `subagent_update`, not a live `state_update` for the child. Replay grants no cancel capability.

On v2, the root and each announced child get exactly one `replay_complete`, including children with no retained content. A parent's marker separates historical child associations from current child state and capabilities reported on that parent. Live updates, state snapshots, and requests follow the boundary for their session. Root activation and child controls still wait for the successful resume response. A resume without `replayFrom` sends no replay boundary. V1 `session/load` uses the response as the freshness boundary.

V2 replay omits historical child configuration. Only a restored child's current configuration is reported. V1 load keeps recorded child configuration in history.

A missing or incomplete child transcript adds one advisory on the root session. On v1 this is a thought. On v2 it is a live notice after `replay_complete`, not retained history.

### Directories

Directory information is part of `subagent_update` on the immediate parent, on both ACP versions.

A verified loaded-child read reports its absolute `cwd`, including a worktree directory. Known child settings changes update that value. Announcements do not reset directory fields while readback is pending. Omission preserves a retained override. `null` would explicitly restore inheritance from the immediate parent, not report an unknown directory. Readback does not block child output, and a superseded read cannot replace newer settings.

The adapter verifies the child's ID, parent, and loaded state before accepting readback. It does not report relative paths or infer directories from provider IDs. Codex does not expose an authoritative ACP additional-directory list for children, so the adapter omits that field. It does not copy parent roots or treat writable sandbox paths as workspace roots. `[]` would mean explicitly no additional directories, not unknown directories.

## AIR legacy contract

This contract applies only to an ACP v1 client that declares `_meta.jetbrains.air`.
It does not use `subagent_update`, `session_message`, or `session` tool call content.
See [AIR extensions](air-extensions.md#native-subagent-sessions).

### Capability negotiation

- Air v1 opts in with `nativeSubagentSessions` in `_meta.jetbrains.air.capabilities`, or with `clientCapabilities.subagents: {}`.
- The adapter answers an AIR Client with `agentCapabilities.sessionCapabilities.subagents: {}` on v1 and lists `nativeSubagentSessions` in its own `_meta.jetbrains.air.capabilities`.

### Lifecycle events

- The adapter sends `subagent_spawned` before any child output. Its `task` field holds the prompt.
- It uses the child session ID for later messages, thoughts, plans, tools, permissions, and elicitations.
- It sends one `subagent_state_update` on the immediate parent, with `completed`, `failed`, `cancelled`, or `disconnected`.
- The adapter advertises an empty child capability object. It does not support targeted child cancel or close operations.

### Session load

`session/load` reconstructs the child tree from Codex history. It reports an orphan as `disconnected` when the history does not prove an outcome. Live timeout, `shutdown`, and `notFound` fallbacks use `failed`.

## Fallback

Without either contract, the subagent lifecycle stays an ordinary ACP tool call. Child permission and elicitation requests stay on the root session.

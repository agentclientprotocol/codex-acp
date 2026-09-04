# Background terminal tasks

Codex app-server owns shell commands that continue after their initial tool call. The adapter exposes these commands through the AIR async task extension.

## Negotiation

The client adds `asyncTasks` to `_meta.jetbrains.air.capabilities`. The adapter advertises the same capability in its `initialize` response.

The adapter emits no async task updates when the client does not advertise this capability.

## Lifecycle

The adapter uses `thread/backgroundTerminals/list` as the source of active processes. It maps each active process to `async_task_spawned`.

Before the spawn update, the adapter marks the command with `_meta.jetbrains.air.asyncTasks.backgrounded`. AIR can then keep the command card active without duplicating its output.

For a root command, the command item ID is both the async task ID and the related tool call ID. A child command prefixes its task ID with the child thread ID. The prefix keeps task IDs distinct across native subagent sessions. The related tool call ID remains the command item ID.

The adapter publishes a child command on its native subagent session. The app-server process ID remains an internal control handle.

The existing command card owns the command output. Therefore, a background terminal task sets `showInTranscript` to `false`.

When the command ends, the adapter emits `async_task_state_update` with `completed` or `failed`.

The active-terminal list repairs a lost completion event. The adapter reports `stopped` when an announced terminal disappears from that list.

Session loading restores root and child tasks after it replays their command history. A provider restart stops old tasks and moves task control to the new app-server client.

If the app-server exits, the adapter reports each unfinished task as `failed`.

## Stop request

The client sends `_session/async_task/stop` with the ACP session ID and async task ID:

```json
{
  "sessionId": "thread-id",
  "asyncTaskId": "command-item-id"
}
```

The adapter resolves the app-server process ID and calls `thread/backgroundTerminals/terminate`. It returns `{ "stopped": true }` after app-server accepts the termination.

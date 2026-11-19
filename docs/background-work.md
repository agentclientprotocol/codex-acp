# Background work

On ACP v2, each live `state_update` includes a `background` snapshot. It lists
known detached work independently of the session's foreground state. `[]`
means no known background work. During resume, `null` means the snapshot is
being synchronized. The final resume snapshot follows current announcements
for the listed entities and, if requested, follows `replay_complete`.

The adapter reports standard [child sessions](subagent-sessions.md) after
their parent releases them. A later Codex wait on a child makes it foreground
for as long as the parent waits. Children use their own `state_update` and
the immediate parent's `subagent_update`; a nested child's work is not listed
again at the root.

A shell process that outlives its Codex turn is listed by the existing display
`terminalId`, not by a process handle or a duplicate tool call. Codex's process
inventory also contains processes still serving foreground calls, so the
adapter uses the turn boundary to confirm detachment. A tool result with a
`session_id` also confirms that the matching process has yielded. It rechecks the list
while it has live terminals. A missing process gets an exit with an unknown
status if Codex didn't report the exit. List errors don't turn running
processes into exits.

`session/cancel` leaves listed work and its pending approvals running.
`session/close` stops the session's work, including background terminals and
descendants. A listed child can also be stopped with `session/cancel` on the
child if the parent has reported `capabilities.cancel` for it.

## Stop one terminal

The agent advertises `capabilities.cancel: {}` on the `terminal_update` for a
background process that Codex can terminate. To stop it, use the session that
reported the terminal, including the child's ACP session ID for a child
terminal:

```json
{
  "jsonrpc": "2.0",
  "id": 12,
  "method": "terminal/cancel",
  "params": {"sessionId": "session-1", "terminalId": "command-1"}
}
```

- `{}` means the stop was accepted. A `terminal_update` with `exitStatus`
  confirms exit and clears `capabilities.cancel`. The terminal stays in the
  transcript.
- `-32602` means the terminal is unknown, has exited, or is not independently
  cancellable. `-32002` with `data.sessionId` means the session is unknown or
  inactive. A runtime failure returns a request error, not a successful stop.
- This request does not interrupt the turn or another terminal. The adapter
  does not advertise `tool_call/cancel`; Codex does not expose an independent
  stop operation for arbitrary model tool calls.

ACP v1 does not have these updates or this method. The [AIR async task
extension](air-extensions.md#async-tasks) remains available on ACP v1.
On ACP v2, its Stop method remains an alias for standard terminal cancellation.

Code-mode `exec` and `wait` calls appear as ordinary tool calls on ACP v1 and v2.
A yielded cell appears in the ACP v2 background list as `{type: "tool_call", toolCallId}`.
A final `wait` result removes the cell. Late output updates its tool call without reopening the cell.
Code cells advertise no cancellation control. Native Codex exposes no cell control method.

The adapter requests raw events when it creates a native thread.
A warm resume keeps the existing raw subscription.
Native Codex does not expose this option for cold resume or fork. Those threads cannot report code cells.
Native history also omits code cells. Air retains the tool calls that it already received in its own history.

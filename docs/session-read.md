# Read-only session history

`_session/read` streams a stored Codex session's history as ordinary `session/update`
notifications without calling `thread/resume`, acquiring the thread's exclusive writer lock,
starting MCP servers, or leaving the session open on the adapter.

Clients can use `_session/read` to preview a session that is currently open in another Codex
client (such as the Codex desktop app, CLI, or another IDE), where `session/load` and
`session/resume` fail with `thread_active_writer`, or to inspect stored/archived sessions
without taking ownership.

## Capability

The adapter advertises `_session/read` in the `initialize` response on both ACP v1 and v2:

```json
{
  "_meta": {
    "sessionRead": { "supported": true }
  }
}
```

## Request

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "_session/read",
  "params": {
    "sessionId": "019c6e27-e55b-73d1-87d8-4e01f1f75043",
    "cwd": "/work/project"
  }
}
```

- `sessionId` is required and must be a non-empty string. Subagent child session IDs are
  rejected with `-32602` (`Invalid params`), matching `session/load` and `session/resume`;
  recorded child histories are replayed as part of their parent session.
- `cwd` is optional (and may be `null`). When provided, it must be an absolute path; relative
  paths fail with `-32602` (`Invalid params`). When omitted or `null`, the adapter uses the
  `cwd` recorded on the Codex thread for file-citation link resolution.
- `_meta` is optional and may be `null`.

## Replay behavior

The adapter reads the thread metadata and items through the read-only Codex App Server API
(`thread/read` and `thread/items/list` for paginated history, or `thread/read` with
`includeTurns: true` for legacy history) and replays them through the same item renderer used by
`session/load` and `session/resume`:

- User messages, assistant messages, reasoning, tool calls, plans, compactions, review boundaries,
  session title (`session_info_update`), and recorded subagent histories are emitted as
  `session/update` notifications for `sessionId` (and any replayed child sessions).
- Session cursors (`cursor_update`) are emitted when supported by the client, with `fork`
  capability only (`rewind` requires an open session).
- On ACP v2, updates run inside the standard replay envelope and finish with
  `{ "sessionUpdate": "replay_complete" }` before the response resolves.
- Live runtime state (`state_update`, `available_commands_update`, live background terminal
  recovery, and live subagent subscriptions) is not attached. When the response `{}` arrives,
  all replay delivery state on the connection is cleared, so a later `session/load` or
  `session/resume` starts cleanly.

## Outcomes and errors

| Outcome | Meaning |
| --- | --- |
| `{}` | All retained history updates have been sent. The session remains closed on this connection. |
| `-32002` (`Resource not found`) | Codex has no thread with `sessionId` (unless the AIR `sessionIndex` capability is enabled and the error explicitly reports an archived restriction). |
| `-32600` (`Invalid request`, `data.reason: "session_already_open"`) | `sessionId` is already open, opening, closing, or being read on this ACP connection, or was opened/closed concurrently during the read. |
| `-32602` (`Invalid params`) | `sessionId` is empty, refers to a restricted subagent child session, or `cwd` is not an absolute path. |
| `-32800` (`Request cancelled`) | The request was cancelled by the client before replay completed. |

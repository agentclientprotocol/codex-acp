# Client-set session titles

The adapter supports the unstable ACP `session/set_title` method on v1 and v2.
It advertises `agentCapabilities.sessionCapabilities.title: {}` on v1 and
`capabilities.session.title: {}` on v2. No Client capability or AIR extension
is required.

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "session/set_title",
  "params": {
    "sessionId": "thread-id",
    "title": "Investigate timeout"
  }
}
```

`sessionId` and `title` are required strings. The session can be active or saved.
The adapter collapses whitespace, trims the title, and caps it at 256 UTF-16 code
units, including a trailing ellipsis when truncated. It does not split a
surrogate pair at the truncation boundary.

On success, the result is `{"title": "Investigate timeout"}` with the normalized
title. The response is sent only after Codex persists it. Later `session/list`
results report that title. Active sessions also receive a `session_info_update`
with it. Saved sessions are not loaded just to rename them.

Missing, `null`, non-string, or blank titles fail with `-32602`. Titles cannot
be cleared through this method. Unknown sessions fail with `-32002` and
`data.sessionId`. Codex may refuse to rename an archived, unpersisted, or
externally locked session. Storage and process failures remain errors, not
successful title changes.

A successful request suppresses the adapter's automatic title writes, including
generation already in flight. It does not stop later user-initiated renames.
The existing AIR `_session/rename` extension uses the same implementation and
keeps its empty result and capability gate.

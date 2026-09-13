# Session rewind extension

Standard ACP can fork a session, but it cannot remove a transcript suffix from the same provider session. The experimental AIR session rewind extension adds that operation without creating another session.

## Capability negotiation

The adapter advertises `sessionRewind` in its `initialize` response:

```json
{
  "_meta": {
    "jetbrains": {
      "air": {
        "version": 1,
        "capabilities": ["sessionRewind"]
      }
    }
  }
}
```

A client must send `_session/rewind` only when the adapter advertises this capability. The leading underscore identifies a method outside standard ACP.

## Request and response

The request names the current ACP session and the first user message to remove:

```json
{
  "sessionId": "thread-1",
  "beforeMessage": {
    "messageId": "user-message-2",
    "messageFingerprint": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "messageOccurrence": 1
  },
  "resumeAtMessage": {
    "messageId": "assistant-message-1",
    "messageFingerprint": "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    "messageOccurrence": 1
  }
}
```

`beforeMessage` is excluded from the retained history. `resumeAtMessage` identifies the last visible assistant message to retain. It is absent when the client rewinds the first user turn.

Each history point contains the ACP message ID, the SHA-256 fingerprint of its complete text, and the one-based occurrence of that fingerprint for its role. The adapter uses the message ID first. It uses the fingerprint occurrence when restored provider history has different message IDs.

The adapter returns `{ "rewound": true }` only after Codex accepts the rewind. A false response or an error leaves the client transcript unchanged.

## Codex mapping

The adapter reads the existing Codex thread history and resolves `beforeMessage` to its containing turn. It then calls `thread/revert` with that turn as the exclusive boundary.

The Codex thread ID remains the ACP session ID. The adapter does not call `thread/fork`, create a thread, or add a session-list entry. `resumeAtMessage` is not needed for this mapping because Codex reverts at a turn boundary.

After a successful response, the client can remove the same transcript suffix and place the selected user text in its editor.

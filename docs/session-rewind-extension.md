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

Each history point contains the ACP message ID, the SHA-256 fingerprint of its complete text, and the one-based occurrence of that fingerprint for its role. The adapter uses the message ID first and verifies the selected message fingerprint. It uses the fingerprint occurrence when restored provider history has different message IDs. Repeated fingerprint fallback requires a current `resumeAtMessage` boundary; fallback is refused when visible text omits attachment identity. A supplied retained boundary must identify the last retained assistant message. Reload rather than guessing when a point is stale.

The adapter returns `{ "rewound": true }` only after Codex accepts the rewind and a native history read verifies the same thread ID and retained prefix. Errors after mutation dispatch can have an unknown outcome: the client must load the session to reconcile before retrying or sending. The adapter blocks further prompt/rewind requests until that load succeeds. It never retries a mutation automatically.

## Codex mapping

The adapter reads the existing Codex thread history and resolves `beforeMessage` to its containing turn. Rewind is rejected when the selected message is a steer inside an existing turn because Codex cannot remove only that suffix. For paginated history, the adapter calls `thread/revert` with the containing turn as the exclusive boundary; legacy history uses the equivalent turn-count rollback operation.

The Codex thread ID remains the ACP session ID. The adapter does not call `thread/fork`, create a thread, or add a session-list entry. `resumeAtMessage` validates the retained boundary and disambiguates repeated fingerprint fallback.

After a successful response, the client can remove the same transcript suffix and place the selected user text in its editor.


## Lifecycle and compatibility

An active prompt is cancelled only after the target validates; the adapter waits for prompt cleanup before native mutation. A pending turn/start registration is rejected, because an unacknowledged native start could write after the rewind. Competing lifecycle/settings/steering/runtime operations are fenced. Provider replacement waits for an existing rewind.

`thread/rollback` is used only when native history explicitly reports `legacy`. It is a separately typed compatibility request for old `CODEX_PATH` binaries, not part of current generated API types. Unknown history mode, arbitrary errors, malformed responses and `thread/revert` failures never trigger rollback.

History rewind does not restore files. See [native session extensions](native-session-extensions.md) for the separate, previewed single-tool Git patch reversal.

The interface and original implementation come from [Nikita Ashikhmin's PR #508](https://github.com/agentclientprotocol/codex-acp/pull/508), preserved as four commits in this branch. This local integration merges current main and adds validation/lifecycle safeguards; it is not a new incompatible rewind protocol.

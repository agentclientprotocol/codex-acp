# Session cursors

Status: Experimental

A session cursor is a position of a session that a method can act at, as the unstable ACP session cursors RFD defines.
The adapter announces them with `cursor_update` and accepts them in `session/fork` and, for AIR, in [`_session/rewind`](air-extensions.md#session-rewind).

## Cursors

The adapter announces one kind: the position before a turn.
Codex cuts whole turns, so a cursor lies at a turn boundary.

- `cursorId` is `before:<turnId>`. Codex stores the turn id, so the id is the same live, in every replay and after a restart. The adapter keeps no cursors of its own.
- ACP v1 clients opt in with `clientCapabilities.session.cursors`. A client that does not declare it gets none. ACP v2 clients always get them.
- `capabilities` is `{ "fork": {} }`. A declared v1 AIR client with `sessionRewind` gets `{ "fork": {}, "rewind": {} }` on the cursors of a session whose thread has paginated, non-ephemeral history. ACP v2 has no `rewind`.

A turn gets a cursor when it starts with a visible user message and is not the first turn. These turns get none:

- the first turn of the session: nothing is before it. A session that is resumed without a replay counts as new until its first prompt or until a turn that Codex starts itself completes, so a prompt before either gets no cursor on v1 and v2, whatever the thread holds;
- a steer: a user message inside a turn, or a prompt that joins a turn that already runs, starts no turn;
- a command turn, such as `/compact`;
- a turn whose first message the client does not see: a hidden message (such as the plan implementation prompt), or a turn that starts with something else than a user message, such as a goal continuation that Codex starts on its own.

## Where the adapter announces them

- Replay (`session/load` on v1, `session/resume` with a replay on v2): right after the first visible user message of the turn, anchored `before` that message.
- Live, v1: v1 does not report the prompt that the client sent, so the cursor is anchored `after` the last entity that the client holds: an agent message or thought, a tool call, a compaction or a user message with an id. If the client holds none, the prompt gets no cursor. A replay resets the entities, so after a load the anchor is the last replayed entity.
  When a turn reports no entity (it was cancelled or failed before any output), the next prompt's cursor has the same `after <entity>` anchor, with a different `cursorId`: the client uses the latest.
- Live, v2: when the user message is inserted, anchored `before` it.

## Fork at a cursor

`session/fork` takes the `cursorId` of the standard request. The fork contains every turn before the cursor's turn.
The request fails with `-32602` for:

- a `cursorId` that is not a cursor of the session: an unknown id, an id that is no cursor, the cursor of the first turn, of a turn without a visible first user message, or of a turn that is still running (or follows one that is);
- a `cursorId` together with a `jetbrains.air.fork` [fork point](air-extensions.md#session-fork-point);
- a session id that names a native subagent's child session.

Without a `cursorId`, the fork behaves as before.

# Session compaction

The adapter implements the [ACP session compaction RFD](https://agentclientprotocol.com/rfds/session-compaction) for ACP v1. Clients opt in during initialization:

```json
{
  "clientCapabilities": {
    "session": {
      "compaction": {}
    }
  }
}
```

For these clients, both automatic compaction and `/compact` produce `session/update` notifications with `sessionUpdate: "compaction_update"`. A Codex `contextCompaction` item starts an `in_progress` entity; its completion updates the same `compactionId` to `completed`. A failure or interruption closes an unfinished entity as `failed` or `cancelled`. Successful compactions stay completed if the surrounding turn subsequently fails or is interrupted.

The adapter uses Codex's item ID as the compaction ID. It suppresses duplicate completion signals, including the older `thread/compacted` notification. If only that older notification is available, it emits a completed entity with an ID derived from the turn. That legacy signal cannot distinguish multiple compactions within one turn.

Loading a session replays each persisted compaction as one completed update in its history position. Current Codex paginated history preserves the live item ID. Older legacy histories can reconstruct item IDs, and Codex does not persist failed or interrupted compaction items, so those entries are not available for replay.

Codex's app-server compaction items expose lifecycle identity without a user-displayable summary. The adapter therefore omits `summary` and does not emit `compaction_summary_chunk`. It does not extract internal replacement history or encrypted compaction data. Context utilization continues to arrive separately through `usage_update`.

When the client omits `session.compaction` or sets it to `null`, the adapter preserves its existing synthetic tool-call and text-message fallback.

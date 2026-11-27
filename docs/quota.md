# Account quota

Codex reports the account's rate limits as numbers through an interim extension that follows the [quotas & limits RFD](https://github.com/agentclientprotocol/agent-client-protocol/pull/2316). When the RFD lands, the same snapshot moves to the standard `quota_update` session update.

Check for `quota: {}` in the `_meta` of the `initialize` response (v1 and v2). The object carries no payload, and the client sends nothing: it only listens for `_quota/update`.

When the rate limits Codex reports for a session change (the app-server `account/rateLimits/updated` push, which follows model responses), the adapter sends `_quota/update` with the session's `sessionId` and a full snapshot. Each update replaces the previous one for that session. An unchanged snapshot is not sent again.

```json
{
  "sessionId": "sess_abc123",
  "updatedAt": "2026-10-06T13:10:00.000Z",
  "pools": [
    {
      "id": "codex",
      "meters": [
        {"id": "primary", "usedPercent": 42, "window": "PT5H", "resetsAt": "2026-10-06T18:00:00.000Z"},
        {"id": "secondary", "usedPercent": 17, "window": "P7D", "resetsAt": "2026-10-11T09:00:00.000Z"}
      ]
    },
    {
      "id": "credits",
      "label": "Credits",
      "state": "available",
      "meters": [{"id": "balance", "remaining": {"value": "118.5", "unit": "credits"}}]
    }
  ]
}
```

The mapping is the RFD's Codex mapping:

| Pool | From | Meters |
| --- | --- | --- |
| One per rate-limit bucket, with `id` = `limitId` and `label` = `limitName` when it differs | each bucket the account reports | `primary` and `secondary` windows: `usedPercent`, `window` (ISO 8601 duration), `resetsAt` (RFC 3339); `status: "exceeded"` at 100 % |
| `credits` | credits and the per-user spend cap | `balance` as `remaining` in `credits` (omitted when unlimited); `spend_cap` with `used`, `limit`, `usedPercent` and `window: "P1M"` |

A bucket's pool has `state: "exhausted"` when Codex reports that its usage limit was reached; the `credits` pool is `exhausted` when credits are depleted or the spend cap is reached, and `available` when the account has credits. Values Codex does not report are left out; none are computed.

`updatedAt` is when the adapter learned the data. It never decreases within the adapter process, so a client keeps the snapshot with the greatest `updatedAt`.

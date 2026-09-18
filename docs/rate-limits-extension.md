# Rate limits extension

Status: Experimental

The agent pushes the usage windows of the account this connection bills to, so
a client can show how much of a window is spent and, when a turn is refused for
a spent window, knows when that window clears. It is the account-level
companion of the `authStatus` push and has the same shape of contract: push
only, connection-scoped, nothing for the client to request.

## Why

Codex refuses a turn on a spent window with `codexErrorInfo:
"usageLimitExceeded"`, and that error carries no reset time. The reset is
reported on the app-server's `account/rateLimits/updated` notification, which
the agent received but did not forward: it only fed the `/status` command's
text. A client that wants to park the session and resume it when the window
clears — instead of guessing or retrying blind — needs the structured value.
The two arrive as separate messages; a client should treat the latest pushed
windows as the reset to schedule against and not depend on either arriving
first.

## Capability

The `initialize` response advertises the push under
`agentCapabilities._meta.rateLimits` as an empty object. Its presence means
"this agent pushes `_account/rate_limits_update`". It never carries a payload
and gates nothing the client sends.

```json
{
  "agentCapabilities": {
    "_meta": {
      "rateLimits": {}
    }
  }
}
```

## Notification

Method: `_account/rate_limits_update`

```json
{
  "rateLimits": {
    "limitId": "codex",
    "limitName": "Codex",
    "normalModelSlug": null,
    "primary":   { "usedPercent": 100, "windowDurationMins": 300,   "resetsAt": 1789511479 },
    "secondary": { "usedPercent": 41,  "windowDurationMins": 10080, "resetsAt": 1789841013 },
    "rateLimitReachedType": "rate_limit_reached",
    "planType": "plus"
  }
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `limitId` | string | Stable id of the limit; `"codex"` for the account's ordinary usage limit. |
| `limitName` | string \| null | Human-readable name, when the backend names it. |
| `normalModelSlug` | string \| null | For a model-specific limit, the model whose quota these windows are; `null` for the account's ordinary limit. |
| `primary`, `secondary` | window \| null | The rolling windows; `null` when the backend did not report one. |
| `window.usedPercent` | number | Share of the window already spent, 0–100. |
| `window.windowDurationMins` | integer \| null | Window length in minutes: `300` for the 5-hour window, `10080` for the weekly one. |
| `window.resetsAt` | integer \| null | Unix time in **seconds** at which the window clears. |
| `rateLimitReachedType` | string \| null | The reached state as reported on the latest update: non-null when the backend reported that it is refusing turns on this limit, and why (`rate_limit_reached`, the workspace credit and usage variants); `null` when the latest update reported none. Clients tolerate values they do not recognise. |
| `planType` | string \| null | Vendor plan string, not normalised. |

Field names and units follow codex app-server's `RateLimitSnapshot`.

## When it is pushed

On every app-server `account/rateLimits/updated` whose merged payload for that
`limitId` differs from the last one pushed for it. That notification is sparse —
the app-server asks clients to merge available values into the most recent
snapshot — so the agent merges first, against a connection-level baseline kept
per `limitId`, and pushes the complete picture; a client never needs
`account/rateLimits/read`. `limitName`, `planType` and the other account
metadata carry forward through the merge; the windows are taken as reported
(a `null` window means the update did not report one). Duplicates are
suppressed per `limitId`, including the copies produced when an account-level
notification reaches several open sessions.

A push replaces the client's state **for that `limitId`**. An account can have
more than one limit (each is pushed and deduplicated separately), so a client
keeps a map keyed by `limitId` rather than a single value; `normalModelSlug`
says which model a limit belongs to.

The agent observes the app-server notification once, at the connection,
before it reaches the per-session handlers, so the number of open sessions
neither duplicates nor reorders pushes.

## Account changes

The windows belong to the signed-in account. On a logout, or an `authStatus`
push that reports a different account, the agent drops its baseline and
duplicate filter, so the first update for the new account is pushed even when
its values equal the previous account's. A client should drop the windows it
holds when `authStatus` changes and wait for the next push.

## Which reset to schedule against

`primary.resetsAt` / `secondary.resetsAt` are the rolling usage windows and are
the reset for `rateLimitReachedType: "rate_limit_reached"`. The workspace
variants (`workspace_owner_usage_limit_reached`,
`workspace_member_usage_limit_reached`, and the credit-depletion variants) are
spend controls, not usage windows: this payload carries **no** reset for them,
and a client must not derive one from the rolling windows. Their state remains
readable through the `/status` command.

## What is not forwarded

Credit balances, spend controls and the individual spend limit are billing
state rather than usage windows and are left out. They remain readable through
the `/status` command.

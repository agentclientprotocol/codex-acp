# Goal extension

This document defines a provider-neutral experimental ACP extension implemented by `codex-acp`. It is intentionally shaped like a possible future first-class ACP API: implementations publish `_meta.goal`, not provider-specific metadata such as `_meta.codex.goal`.

## Capability negotiation

An agent advertises support in its `initialize` response:

```json
{
  "_meta": {
    "goal": {
      "version": 1,
      "controlMethod": "_session/goal",
      "actions": ["set", "pause", "resume", "clear"]
    }
  }
}
```

`actions` is the implementation-supported subset of `set`, `pause`, `resume`, and `clear`. Clients must not infer support for an action that is not advertised. The control request contains `sessionId` and `action`; `set` additionally requires a non-blank `objective`.

## Session state

The current snapshot is published in `session_info_update._meta.goal`. Clearing a goal publishes `goal: null`.

```json
{
  "objective": "Ship the change",
  "status": "active",
  "createdAt": 1710000000000,
  "updatedAt": 1710000012000,
  "tokenBudget": null,
  "tokensUsed": 42,
  "timeUsedSeconds": 12,
  "controlMethod": "_session/goal"
}
```

Common statuses are `active`, `paused`, `blocked`, `limited`, and `complete`. Optional fields allow implementations to report budgets, usage, iteration count, and the last continuation reason. Timestamps are Unix milliseconds.

## Lifecycle architecture

A goal belongs to the ACP session, not to an individual `session/prompt` request. Goal activity and prompt activity are independent:

- `status: active` means the persistent objective can drive more work; it does not mean an ACP prompt is currently executing.
- A prompt completes when its current backend turn reaches a quiescent boundary, even when the goal remains active.
- A later autonomous cycle may publish more session updates outside that completed prompt.
- While a turn is running, clients use steering or prompt queueing when advertised. While the session is quiescent, clients may send an ordinary `session/prompt`.

This separation prevents a persistent goal from monopolizing the session's prompt slot and lets clients model “working now” independently from “objective remains active.”

## Codex mapping and compatibility

Codex `thread/goal/*` notifications map into the neutral snapshot. Provider statuses `usageLimited` and `budgetLimited` map to `limited`; Codex second-based timestamps are converted to Unix milliseconds. `/goal` remains the user-facing way to set, pause, resume, or clear a goal.

`_codex/session/goal_control` remains accepted as a legacy alias, but new clients discover and use `_session/goal`. The alias is not advertised and no provider-specific goal metadata is emitted.

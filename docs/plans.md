# Plans

Codex produces two kinds of plans:

- **Checklist plans** from the `update_plan` tool (`turn/plan/updated`). Each update
  replaces the whole list. A session has at most one, so it always uses the
  `planId` `codex-structured-plan`.
- **Markdown plans** that Codex writes in plan mode (the `plan` item). The
  `planId` is the Codex item id.

The adapter follows the [ACP plan operations](https://agentclientprotocol.com/protocol/v1/agent-plan).
On v1, a client opts in to `plan_update` with `clientCapabilities.plan: {}`. On v2,
every client gets `plan_update`, and no capability is needed.

## With plan updates

A checklist update is an `items` plan:

```json
{
  "sessionUpdate": "plan_update",
  "plan": {
    "type": "items",
    "planId": "codex-structured-plan",
    "entries": [
      {"content": "Read code", "priority": "medium", "status": "completed"},
      {"content": "Change code", "priority": "medium", "status": "in_progress"}
    ]
  }
}
```

Codex has no step priority, so every entry has `priority: "medium"`.

A Markdown plan is sent as `markdown` snapshots while Codex writes it, at most
one every 150 ms. The last snapshot has the text of the completed item.
Session replay sends one snapshot for each saved plan.

```json
{
  "sessionUpdate": "plan_update",
  "plan": {"type": "markdown", "planId": "item-id", "content": "# Plan\n\n1. Read."}
}
```

AIR clients with `planContentDelta` get the appended text instead of whole
snapshots; see [AIR extensions](air-extensions.md#plan-content-delta-and-plan-review).

## Without plan updates

A v1 client without `clientCapabilities.plan` gets:

- checklist plans as the legacy `plan` update with the same `entries`;
- each Markdown plan as one `agent_message_chunk` with the item id as
  `messageId`, when the plan item completes. Replay sends the same chunk.

## Removal

An explicit empty checklist from `turn/plan/updated` clears
`codex-structured-plan`. Clients with plan updates (opt-in on v1, baseline on v2)
receive an empty `items` update, then `plan_removed`. A v1 client without `plan`
receives only the legacy `plan` with empty `entries`.

Completion does not remove a plan. Codex has no equivalent removal event for
Markdown plan items. Markdown plans omit `path` because Codex streams plan text
rather than reporting a plan file. The schema no longer defines a `file` plan
type. Codex's `explanation` of a checklist update is not sent.

# Session steering

Steering delivers a message into a running Codex turn, so a client can adjust the agent
mid-task instead of queueing until the turn ends or cancelling it. The method is
`_session/steering`, a pre-standard ACP extension also shipped by claude-agent-acp; the
standardization proposal is
[agent-client-protocol PR #1261](https://github.com/agentclientprotocol/agent-client-protocol/pull/1261).

## Capability

The adapter advertises steering in the `initialize` response as
`_meta.steering = {supported: true}`. The flag covers the method in general; it does not
distinguish support for a specific optional behavior, so clients check the adapter version.

## Request

```json
{
  "sessionId": "session-id",
  "prompt": [{ "type": "text", "text": "Adjust the plan" }],
  "_meta": { "steering": { "idleBehavior": "promptRequired" } }
}
```

- `prompt` uses the same content blocks as `session/prompt`. Image blocks are rejected with
  `invalidRequest` when the active model has no image input support.
- `_meta` is optional and may be `null`.
- An `idleBehavior` value other than `"promptRequired"` is rejected with `invalidParams`.
- Steers for one session are serialized in arrival order; steers for different sessions run
  concurrently.

## Outcomes

| Outcome | Meaning |
| --- | --- |
| `injected` | The prompt joined the running turn. |
| `startedNewTurn` | No turn was running, and the adapter started one with the steer content. The response arrives once the turn is running; the turn's output follows the usual session updates, and its completion, usage, and failure reporting belong to that turn, not to this response. |
| `promptRequired` | Returned with `reason: "noRunningTurn"` when the client opted into `idleBehavior: "promptRequired"` and no turn can accept the input, including while the original prompt is waiting for plan approval. The input is not consumed and no turn is started. |
| `failed` | The steer could not be applied due to an unexpected error. Errors the protocol defines are thrown as JSON-RPC errors instead. |

## Host-owned idle fallback

Without the opt-in, a steer that finds no running turn falls back to `startedNewTurn`: the
adapter starts the turn itself. A client that wants to keep the normal prompt lifecycle
opts in:

```json
{ "_meta": { "steering": { "idleBehavior": "promptRequired" } } }
```

With the opt-in, an idle steer returns `promptRequired` and leaves the input with the
client. The client keeps the input queued, answers any pending permission request, and
waits for the original `session/prompt` response before sending the queued input through
its normal `session/prompt` lifecycle. That request owns completion, usage, and failure
reporting. `promptRequired` does not cancel an active prompt or answer its permission
requests.

## Examples

`examples/steering.ts` drives a multi-step turn and injects a steer part-way through it.

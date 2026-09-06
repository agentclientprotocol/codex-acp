# Asynchronous user questions

Codex can ask a question and continue working before the user answers. The adapter exposes these questions through the AIR `asyncQuestions` extension.

The client receives a request that waits for the user's answer. The running turn and session updates continue while that request is pending. The adapter sends the answer to Codex as new user input.

## Negotiation

The client adds `asyncQuestions` to `clientCapabilities._meta.jetbrains.air.capabilities` during `initialize`:

```json
{
  "clientCapabilities": {
    "_meta": {
      "jetbrains": {
        "air": {
          "version": 1,
          "capabilities": ["asyncQuestions"]
        }
      }
    }
  }
}
```

The adapter advertises the same capability in `initialize.result._meta.jetbrains.air.capabilities`. This uses the shared AIR extension version and capability check.

Without negotiation, the adapter displays the question as ordinary text. The user can answer in chat. Standard ACP elicitation support does not enable this extension.

## Question request

The adapter sends `_session/async_question/request` to the client:

```json
{
  "sessionId": "thread-id",
  "turnId": "turn-id",
  "itemId": "call-id",
  "questions": [
    {
      "id": "[\"request_user_input_async\",\"call-id\",0]",
      "title": "Is there a YouTrack issue for this fix?"
    },
    {
      "id": "[\"request_user_input_async\",\"call-id\",1]",
      "title": "Which component?",
      "options": ["Platform", "Plugin"]
    }
  ]
}
```

The client displays all questions together. It always allows free text; `options` are suggestions. It must not submit a preselected option automatically.

The client associates the form with the ordinary `agent_message_chunk` whose `messageId` equals `itemId`. It keeps processing session updates and other input while the request waits. Normal turn completion does not close the form.

Question IDs are opaque strings. The client returns them unchanged. `turnId` identifies the originating turn, not necessarily the turn that receives the answer.

## Answer response

The client returns one nonblank string answer for each question:

```json
{
  "status": "answered",
  "answers": [
    {"id": "[\"request_user_input_async\",\"call-id\",0]", "answer": "Create an issue"},
    {"id": "[\"request_user_input_async\",\"call-id\",1]", "answer": "Platform"}
  ]
}
```

Answer order is not significant. Missing answers, unknown or duplicate IDs, non-string values, and blank answers invalidate the whole response. Closing the form returns `{ "status": "dismissed" }` and sends no input.

The client records the submitted answer in its UI. It must not also send `session/prompt` or `_session/steering` for that answer. The adapter owns delivery; the question RPC response does not acknowledge that Codex consumed the answer.

## Input delivery

The adapter reads live `item/completed` events with `agentMessage.delivery: "async"` and a nonempty `questions` array. It sends the client request without blocking the event queue.

After a valid response, it constructs a user message in the observed Codex desktop format:

```text
<send_user_message_question_reply>
[{"questionItemId":"[\"request_user_input_async\",\"call-id\",0]","question":"Is there a YouTrack issue for this fix?","answer":"Create an issue"},{"questionItemId":"[\"request_user_input_async\",\"call-id\",1]","question":"Which component?","answer":"Platform"}]
</send_user_message_question_reply>
```

This wrapper is a Codex compatibility detail. The client does not construct it.

The existing steering queue sends the message through `turn/steer` when a turn is active. Otherwise it waits for prompt cleanup and starts a new turn. If the active turn finishes during delivery, the existing steering fallback starts a new turn.

Answers share the queue with other steering requests. A new turn streams ordinary ACP updates even when no client `session/prompt` request is outstanding. Clients advertising this extension must support that lifecycle.

Synchronous Codex `item/tool/requestUserInput` still uses standard ACP elicitation and returns its answer to the waiting tool call.

## Cancellation and failure

There is no answer timeout. Session cancellation, close/delete, provider replacement, and Codex process exit cancel pending question RPCs through ACP `$/cancel_request`. The client closes the form and settles its request. Late responses are ignored, and cancelled answers waiting in the steering queue cannot start work. Input already accepted by Codex cannot be retracted by dismissing the form.

Request errors, invalid responses, and failed delivery produce a visible message asking the user to answer in chat. The adapter does not automatically retry an uncertain delivery.

## Session load

Repeated live events with the same item ID create at most one request per loaded session. Sessions track their questions independently.

Loading or forking history displays question text without reopening forms. Pending forms are not restored after adapter restart or session close/reopen. Durable recovery and delivery acknowledgements are outside this version of the extension.

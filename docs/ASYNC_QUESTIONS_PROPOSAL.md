# Proposal: asynchronous user questions over ACP

Status: experimental provider extension, version 1, implemented by `codex-acp`.
This document proposes a client contract; it does not add a standard ACP method.

## Problem and intended behavior

Codex can ask a question and continue working before the user answers. For example,
it asks for a YouTrack issue number while investigating a fix. The user answers
“create an issue” in a question form, and Codex receives that answer as new user input.

The ACP client receives one ordinary request/response RPC for the question. The RPC
waits for the user, but neither the session notification queue nor the running Codex
turn waits for it. Answering after the original turn finishes can start another turn.

This is separate from synchronous Codex `item/tool/requestUserInput`, which continues
to use standard ACP elicitation and returns a tool response to the waiting Codex call.

## Capability negotiation

A client opts in through `initialize.params.clientCapabilities._meta`:

```json
{
  "clientCapabilities": {
    "_meta": {
      "codex.asyncQuestions": { "version": 1 }
    }
  }
}
```

The provider advertises its implementation in
`initialize.result.agentCapabilities._meta`:

```json
{
  "codex.asyncQuestions": {
    "version": 1,
    "requestMethod": "_codex/requestUserInput"
  }
}
```

Version must be the number `1`. Missing, malformed, or unsupported versions receive
ordinary question text without an extension request. Standard form elicitation
support does not implicitly enable this feature. No environment setting is needed.

## Provider-to-client question request

```json
{
  "jsonrpc": "2.0",
  "id": 42,
  "method": "_codex/requestUserInput",
  "params": {
    "sessionId": "session-1",
    "turnId": "turn-1",
    "itemId": "call-1",
    "questions": [
      {
        "id": "[\"request_user_input_async\",\"call-1\",0]",
        "title": "Is there a YouTrack issue for this fix?"
      },
      {
        "id": "[\"request_user_input_async\",\"call-1\",1]",
        "title": "Which component?",
        "options": ["Platform", "Plugin"]
      }
    ]
  }
}
```

The client should:

- Present all questions together, associated with the specified session and item.
- Always allow free text. `options` are suggestions, not an enum restricting answers.
- Omit automatic submission or selection. Preserve the user's submitted text.
- Keep rendering session updates and accepting other input while the RPC is pending.
- Keep the form available after the originating `session/prompt` completes.
- Associate the form with the ordinary `agent_message_chunk` whose `messageId` equals
  `itemId`, so the transcript and form do not appear to be unrelated questions.

Question IDs are opaque strings. Return them unchanged. `turnId` identifies the
origin of the question; it does not require the answer to reach that same turn.

## Client response

On submission, return exactly one nonblank string answer for each question:

```json
{
  "jsonrpc": "2.0",
  "id": 42,
  "result": {
    "status": "answered",
    "answers": [
      { "id": "[\"request_user_input_async\",\"call-1\",0]", "answer": "Create an issue" },
      { "id": "[\"request_user_input_async\",\"call-1\",1]", "answer": "Platform" }
    ]
  }
}
```

Order is not significant. Unknown or duplicate IDs, missing answers, non-string
values, and blank answers invalidate the entire response; nothing is submitted.
The client may instead close the form without sending user input:

```json
{ "jsonrpc": "2.0", "id": 42, "result": { "status": "dismissed" } }
```

The client records the submitted answer in its UI. It must not also send
`session/prompt` or `_session/steering` for that answer: the provider handles delivery.
The RPC result is not an acknowledgement that Codex has consumed the answer.

## Codex mapping and input delivery

The adapter observes live `item/completed` notifications with an `agentMessage`
whose `delivery` is `"async"` and whose `questions` array is nonempty. Each question
is mapped to the custom request above. There is no additional app-server request
to register: this is a completed message event, not `item/tool/requestUserInput`.

Codex's observed `request_user_input_async` call returns `{"accepted":true}` immediately.
The later answer is a user message with this payload:

```text
<send_user_message_question_reply>
[{"questionItemId":"[\"request_user_input_async\",\"call-1\",0]","question":"Is there a YouTrack issue for this fix?","answer":"Create an issue"},{"questionItemId":"[\"request_user_input_async\",\"call-1\",1]","question":"Which component?","answer":"Platform"}]
</send_user_message_question_reply>
```

The adapter constructs this payload from the original request and validated answers.
Clients do not construct it. This wrapper follows the observed Codex desktop format;
it is a Codex-specific compatibility detail, not a portable ACP standard.

The existing per-session steering queue delivers the input:

1. An active turn receives `turn/steer` with its current `expectedTurnId`.
2. If the turn has finished, the adapter waits for prompt cleanup and uses `turn/start`.
3. A “no active turn” race follows the existing steering fallback to a new turn.

Concurrent answers and other steering requests share the same queue. Output from a
new turn streams through ordinary ACP session updates even though no client
`session/prompt` request is outstanding. Clients opting in must support that lifecycle.

## Cancellation, history, and failure

- A pending question survives normal turn completion. There is no answer timeout.
- `session/cancel`, session close/delete, and provider replacement cancel outstanding
  question RPCs through ACP `$/cancel_request`. The client should close the form and
  settle its RPC. A late response to a cancelled question is ignored.
- Cancellation also prevents an answer still queued for delivery from starting work.
  Input already accepted by Codex cannot be retracted by dismissing the form.
- Repeated live events with the same item ID create at most one request per loaded
  session. Different sessions have independent question IDs and pending requests.
- Loading or forking history displays text only; it does not reopen historical forms.
  Pending forms are not persisted across adapter restart or session close/reopen.
- Without the capability, a completed async message is rendered as ordinary text,
  including messages that arrive without text deltas. The user can reply in chat.
- RPC errors, malformed responses, or failed answer delivery are logged and produce
  a visible request to send the answer in chat. There is no automatic retry that could
  duplicate an answer after an uncertain transport outcome.

## Implementation and validation

`AsyncQuestionExtension.ts` defines the wire types. `CodexAsyncQuestionHandler.ts`
owns pending questions across prompt boundaries. `CodexAcpServer.ts` connects live
events, session cancellation, and the existing `SteeringQueue`. `CodexEventHandler.ts`
provides ordinary text rendering for completed async messages without deltas.

Behavior tests in `src/__tests__/CodexACPAgent/async-questions.test.ts` cover capability
negotiation, nonblocking progress, deduplication, multiple questions and free text,
active-turn delivery, late-answer turn creation, cancellation, and invalid responses.
File snapshots record the ACP request and exact Codex input payload.

## Future standardization

A standard ACP proposal could generalize this request without exposing Codex-specific
IDs or the input wrapper. Version 1 deliberately leaves durable pending-question
recovery and explicit delivery acknowledgements for a future revision. Client-side
form rendering must be implemented by each ACP client before advertising support.

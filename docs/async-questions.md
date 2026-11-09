# Async questions

Codex's `request_user_input_async` tool lets the agent ask the user questions without waiting for
an answer. Unlike the blocking `request_user_input` of Plan mode, it is not an app-server request:
Codex emits an `agentMessage` item with `delivery: "async"` and `questions`, tells the model that
the questions were accepted, and the turn goes on.

## What the client sees

- The message text (the questions and their options) is sent as an ordinary agent message.
- If the client supports form elicitation, the adapter also sends a session-scoped
  `elicitation/create` with one field per question. A question with options offers them, plus an
  own answer the way Plan mode questions do. Fields are optional, since each question can be
  answered on its own. The request carries `_meta.codex.delivery: "async"`.
- The adapter does not wait for the elicitation. On ACP v2 it does not count as a user action, so
  the session state stays `running` while the form is open.

## Answers

- An accepted answer is steered into the turn that asked the question (`turn/steer` with that
  turn as `expectedTurnId`). It is not echoed as a live user message.
- Declining or cancelling sends nothing; the agent keeps its own default.
- When the turn ends, its open elicitations are cancelled with `$/cancel_request`. The same happens
  when the session closes or its app-server is lost.
- An answer that arrives after its turn ended is dropped, as in the Codex TUI. This includes an
  answer to a cancelled elicitation, and one that Codex rejects because a new turn has started. The
  adapter then sends a `warning` notice, where the client supports notices.

## Reply format and replay

Answers use the envelope that the Codex TUI and desktop app send, so Codex reads them the same way:

```
<send_user_message_question_reply>
[{"answer":"Staging","question":"Which environment?","questionItemId":"[\"request_user_input_async\",\"call_1\",0]"}]
</send_user_message_question_reply>
```

Codex stores this text as an ordinary user message. On `session/load` and `session/resume`, a user
message that is exactly one such envelope is replayed as each question in a quote followed by its
answer:

```
> Which environment?

Staging
```

The format follows Codex's `codex-rs/context-fragments/src/answered_question.rs`, and its parsing
follows `codex-rs/tui/src/async_question_reply.rs`.

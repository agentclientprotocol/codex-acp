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

- An accepted answer joins the current turn through `turn/steer`. If the session is idle,
  the adapter starts one new turn with the reply. The form summary shows the answer, without a second live user message.
- Declining or cancelling sends nothing; the agent keeps its own default.
- The form stays open after its turn ends. Closing the session or losing its app-server cancels it.
- A rejected answer produces a warning notice where the client supports notices.
- On ACP v2, request metadata lists Air's companion field IDs under
  `_meta.jetbrains.air.customAnswerFields`. The note stays part of its choice.

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

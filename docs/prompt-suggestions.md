# Prompt suggestions

This experimental extension lets any ACP client request a predicted next user Prompt without declaring AIR identity. The adapter uses the current Session's authentication, model and conversation. A prediction is optional and never executes tools.

## Negotiation

For ACP v1, declare `initialize.clientCapabilities._meta.promptSuggestions: {version: 1}`. The adapter advertises the same marker in `agentCapabilities._meta.promptSuggestions`.

For ACP v2, declare `initialize.capabilities._meta.promptSuggestions: {version: 1}`. The adapter advertises the marker in `capabilities._meta.promptSuggestions`.

Only version 1 is supported. Existing AIR clients retain their previous behavior when they do not declare this independent extension. A client declaring both uses this extension, with one prediction request at most.

## Per-Prompt consent and correlation

An opted-in client adds this metadata to `session/prompt`:

```json
{"_meta":{"promptSuggestions":{"enabled":true,"promptId":"opaque-client-prompt-id"}}}
```

`promptId` is an opaque, nonblank string, at most 1024 characters. The client must use a unique identifier for each Prompt in a live Session. The adapter echoes it without adding it to the model's conversation. It is independent of Codex's own Turn identifier.

Missing or malformed optional metadata, or `enabled: false`, disables generation for that Prompt. Changing the preference affects subsequent Prompts. A client hiding suggestions immediately must also discard already authorized predictions for the current Prompt.

## Updates

A prediction follows successful completion through `session/update`:

```json
{
  "sessionId":"agent-session",
  "update":{
    "sessionUpdate":"session_info_update",
    "_meta":{"promptSuggestions":{
      "version":1,
      "promptId":"opaque-client-prompt-id",
      "suggestions":[{"text":"Run the tests"}]
    }}
  }
}
```

An empty `suggestions` array clears the prediction for that same identifier. Starting another Prompt invalidates a sample in flight and clears the old prediction with its original identifier. Clients must reject updates for older identifiers or replaced Sessions.

No prediction is guaranteed. Plan mode, unsuccessful Turns, disabled generation, blank model output and inference errors can all produce none. Prediction work does not delay the user's Turn result. `CODEX_ACP_PROMPT_SUGGESTIONS=false` remains an authoritative opt-out.

Clients keep ghost text separate from their drafts. Acceptance fills an editable draft and does not send it automatically.

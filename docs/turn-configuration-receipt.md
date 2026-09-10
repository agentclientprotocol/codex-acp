# Turn configuration receipt

`codex-acp` returns transport-level model configuration evidence in each
`PromptResponse` that started at least one Codex turn:

```json
{
  "_meta": {
    "codex": {
      "turnConfiguration": {
        "version": 1,
        "turns": [
          {
            "threadId": "thread-id",
            "turnId": "turn-id",
            "requested": {
              "model": "gpt-5.6-sol",
              "effort": "xhigh"
            },
            "threadSettings": {
              "model": "gpt-5.6-sol",
              "effort": "xhigh",
              "modelProvider": "openai"
            },
            "modelReroutes": []
          }
        ]
      }
    }
  }
}
```

- `requested` is the exact model and effort sent by the adapter in
  `turn/start`. It is `null` for command-started turns such as `/review` and
  `/goal`, whose app-server request carries no model or effort fields.
- `threadSettings` is the latest `thread/settings/updated` value observed from
  the Codex app server when the prompt response is built. It is `null` when the
  app server has not reported settings for that thread.
- `modelReroutes` records every `model/rerouted` notification observed for the
  turn, in order.

One ACP prompt can start multiple Codex turns, for example when an approved plan
continues into implementation. Each turn gets its own entry. Cancelled and
typed-failure responses retain entries for turns that had already started.

This receipt replaces model self-report with transport-observed configuration
evidence. `requested` is authoritative only for fields explicitly sent on that
turn; `threadSettings` reports the app server's latest settings for command-started
turns. The receipt does not claim to be a backend execution attestation: the
current Codex app server protocol does not expose the final per-turn reasoning
effort after request processing.

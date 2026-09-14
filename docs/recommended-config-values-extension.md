# Recommended config values extension

`codex-acp` implements the experimental AIR `recommendedValue` extension for
the model and reasoning-effort session config selectors. It lets clients show a
Codex recommendation independently from the session's current selection.

## Capability negotiation

The client opts in during `initialize`:

```json
{
  "clientCapabilities": {
    "_meta": {
      "jetbrains": {
        "air": {
          "version": 1,
          "capabilities": ["recommendedValue"]
        }
      }
    }
  }
}
```

The adapter advertises `recommendedValue` in the corresponding capability list
of its initialize response. Without negotiation, config options retain their
existing shape and contain no recommendation metadata.

## Config option metadata

When a recommendation is available, the model or effort selector contains:

```json
{
  "_meta": {
    "jetbrains": {
      "air": {
        "version": 1,
        "recommendedValue": "medium"
      }
    }
  }
}
```

The recommended model is the available model marked `isDefault` by Codex. The
recommended effort is the current model's `defaultReasoningEffort`. A value is
emitted only when it is present among that selector's advertised options.

`recommendedValue` is independent from `currentValue`: explicit user choices
remain current. When the user switches models, the effort recommendation is
recomputed from the newly selected model.

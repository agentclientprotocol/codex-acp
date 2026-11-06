# Per-turn working directory

ACP `session/prompt` carries no working directory of its own: a session keeps the `cwd` it was
created or last loaded with, and neither ACP v1 nor v2 has an in-session primitive to move a live
session to another directory. A `session/resume` with a different `cwd` can be rejected with
`invalid_params`. Clients that let the user navigate folders between turns (a GUI file tree, a
workspace switcher) therefore cannot move a running session with the standard methods.

## Request

On `session/prompt`, a client may pass a per-turn working directory override through `_meta.cwd`:

```json
{
  "sessionId": "thread-1",
  "prompt": [{"type": "text", "text": "Where are the tests?"}],
  "_meta": {"cwd": "/Users/me/other-project"}
}
```

Both ACP v1 and v2 accept it. A prompt without `_meta`, with `_meta: null`, or with any other
`_meta` keys behaves exactly as before; `_meta.cwd: null` counts as absent.

## Validation

The adapter validates `_meta.cwd` before the prompt takes its turn-start slot, so an invalid value
rejects the prompt with the standard `invalid_params` error (`-32602`) and nothing is sent to
Codex:

- the value must be a non-empty string,
- an absolute POSIX or Windows path (never a file URI),
- an existing directory.

## Effect

The validated directory is sent as the `cwd` of the Codex `turn/start` request, which overrides
the working directory for this turn and subsequent turns. Once the turn starts, the adapter
updates the session's working directory, so the following turns, file citations, and turn diffs
resolve against it. `session/list` reflects the new directory through Codex's own thread cwd.

## Client support

Older adapters ignore unknown `_meta` keys, so sending `_meta.cwd` to one is harmless but has no
effect: the turn still runs in the session's original directory. A client that needs the override
should gate on the adapter version or detect the effect before relying on it.

# System prompt append extension

`codex-acp` supports appending client-owned, session-scoped instructions without replacing Codex's base/system prompt. The adapter maps the appended text to Codex `developerInstructions`, which is injected as a developer-role instruction layer.

## Capability

The adapter advertises the extension in the `initialize` response:

```json
{
  "_meta": {
    "systemPrompt": {
      "version": 1,
      "append": true,
      "maxBytes": 262144
    }
  }
}
```

`append: true` is the only supported mode. The adapter does not support replacing Codex's base instructions.

## Session requests

Clients append instructions with `_meta.systemPrompt.append`:

```json
{
  "cwd": "/workspace/project",
  "mcpServers": [],
  "_meta": {
    "systemPrompt": {
      "append": "Act as a database performance expert for this session."
    }
  }
}
```

The extension is accepted on `session/new`, `session/resume`, `session/load`, and `session/fork`:

- On `session/new`, the text configures the new Codex thread's developer instructions.
- On `session/resume` and `session/load`, supplied text is reapplied as the thread configuration override. Omitting the field leaves Codex's restored configuration unchanged.
- On `session/fork`, supplied text is applied to the fork. Omitting it leaves instruction inheritance to Codex.
- Ordinary `session/prompt` requests never repeat or modify the session-scoped instructions.

Blank append text is treated as absent. Non-string append values, unsupported fields, string-form `systemPrompt` overrides, and content larger than the advertised UTF-8 byte limit are rejected with `invalid_params` before session side effects.

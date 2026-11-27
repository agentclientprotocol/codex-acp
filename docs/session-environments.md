# Session environments

ACP v1 and v2 clients can select Codex execution environments when calling
`session/new`. No additional ACP capability negotiation is required; the adapter
enables the Codex experimental API during initialization.

Pass an `environments` array inside the request's `_meta`:

```json
{
  "method": "session/new",
  "id": 1,
  "params": {
    "cwd": "/local/project",
    "mcpServers": [],
    "_meta": {
      "environments": [
        {"environmentId": "devbox", "cwd": "/workspace/project"}
      ]
    }
  }
}
```

Each entry requires non-empty string `environmentId` and `cwd` fields. Use the
environment ID configured in Codex's `environments.toml`; the entry's `cwd` is a
path inside that environment. The top-level `cwd` remains the adapter's local
workspace directory.

The adapter forwards the list in order as `thread/start.environments`. Only
`environmentId` and `cwd` are forwarded. `runtimeWorkspaceRoots` and other extra
entry fields are ignored.

- An omitted or `null` `_meta`, or an omitted or `null` `_meta.environments`,
  leaves Codex's default environment selection in effect.
- An empty array is forwarded as `[]`, disabling environment access for the
  thread's turns unless Codex receives a turn override.
- A non-empty array selects the supplied environments; Codex uses the first as
  the current turn environment.
- Malformed arrays or entries return ACP invalid params (`-32602`) before
  `thread/start`. Environment lookup and connection errors are handled by Codex
  and follow the adapter's normal error handling.

The request returns the normal `session/new` response. This metadata option only
applies to session creation; it does not add environment overrides to prompts,
resume, load, or fork requests.

# Session options

Use `session/options` to populate a settings picker before opening a session. Check the capability in the initialize response before calling the method or sending initial values. The adapter omits the capability for JetBrains 2026.1 clients, which have session config options disabled.

| | ACP v1 | ACP v2 |
| --- | --- | --- |
| Agent capability | `agentCapabilities.sessionCapabilities.options: {}` | `capabilities.session.options: {}` |
| Preview result | `configOptions`, `modes` | `configOptions`, advisory `availableCommands` |
| Setup methods accepting initial values | `session/new`, `session/load`, `session/resume`, `session/fork` | `session/new`, `session/resume`, `session/fork` |

## Preview a session

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "session/options",
  "params": {"cwd": "/work/project", "additionalDirectories": ["/work/shared"]}
}
```

`cwd` is required. It and every entry in `additionalDirectories` must be absolute paths. An omitted or null directory list means no additional roots. Omit `sessionId` or pass null for a new session. To preview a restore or fork, pass the existing session's ID and workspace.

The adapter reads workspace configuration, the model catalog, and available thread settings. A preview leaves session history and `session/list` unchanged and emits no `session/update`. Supply MCP servers on the setup request only. The v2 preview includes built-in commands. Use the setup response and subsequent command updates for the session's full command list.

Codex exposes collaboration mode, permission profile, and service tier on live threads. For a detached thread, its read-only API omits those fields, so the adapter reads them from the local rollout and reuses the result while the file is unchanged. Codex resolves the model and reasoning effort again for the requested workspace on a cold resume.

If Codex can identify the thread but its saved settings are missing, unreadable, or unrecognized, the preview uses workspace defaults for the affected settings. A later preview picks up the saved settings when they become available again. If Codex itself cannot read the thread metadata, workspace configuration, or model catalog, the preview returns an error. The client can retry the preview or attempt setup directly. Sending only choices the user changed preserves the other values Codex restores. The setup response contains the actual values.

An invalid path returns `-32602` (Invalid params). An unknown session returns `-32002` (Resource not found). An archived session also returns `-32002` unless the client negotiated the AIR session index. With that capability, an archived session returns `-32600` (Invalid request) with `data.reason` set to `archived`.

## Apply initial values

Send the chosen entries in the order shown by the preview. This example uses ACP v2.

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session/new",
  "params": {
    "cwd": "/work/project",
    "configOptions": [
      {"configId": "model", "type": "id", "value": "gpt-5"},
      {"configId": "reasoning_effort", "type": "id", "value": "high"}
    ]
  }
}
```

Use each option's `id` in v1 or `configId` in v2 as the entry's `configId`. For a select option, send a string value ID. V1 lets you omit `type: "id"`. For a boolean option, send `type: "boolean"` and a boolean value. V1 clients receive boolean options when they advertise `clientCapabilities.session.configOptions.boolean: {}`.

An omitted, null, or empty `configOptions` list keeps the setup defaults. Restore requests apply entries on top of the restored settings, before any v2 history replay. Fork requests apply them to the new fork. The requesting client receives the final values in the setup response without a separate `config_option_update` for these entries.

- The adapter applies entries in order. Selecting a model can change the reasoning efforts and speed settings available to the next entry.
- An unknown option, a stale value, a supported value type that no longer matches the option, or a value refused by Codex is skipped. Later entries still apply.
- A malformed entry, a duplicate `configId`, or an unsupported v2 value type fails the setup request with `-32602`.
- If the Codex process exits while applying initial values, setup returns the process error and the adapter releases the incomplete session's local state.

See the upstream [Session options RFD](https://agentclientprotocol.com/rfds/session-options).

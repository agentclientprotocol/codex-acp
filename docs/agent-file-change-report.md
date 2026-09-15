# Agent file-change report

Standard ACP can describe a change from one tool call. It has no complete file list for one prompt turn.

This adapter supports the version-1 `agentFileChangeReport` extension. The client and adapter must both advertise it in `_meta.jetbrains.air.capabilities` during `initialize`.

The client adds this object to `session/prompt`:

```json
{
  "_meta": {
    "jetbrains": {
      "air": {
        "agentFileChangeReportRequest": {
          "version": 1,
          "requestId": "a-unique-request-id"
        }
      }
    }
  }
}
```

The request identifier has 1 to 128 characters. It can contain ASCII letters, digits, `.`, `_`, `:`, and `-`.

The adapter derives the report from Codex's final aggregated `turn/diff/updated` snapshot for the main turn. It does not run an additional model turn. In Codex 0.154, this snapshot tracks `apply_patch` mutations but can omit changes made through shell commands, version-control commands, generators, or child processes. The adapter therefore publishes these reports with `declaredComplete: false` and explains the limitation in `uncertainty`.

The adapter sends one `session_info_update` before the `PromptResponse`:

```json
{
  "sessionUpdate": "session_info_update",
  "_meta": {
    "jetbrains": {
      "air": {
        "version": 1,
        "agentFileChangeReport": {
          "version": 1,
          "requestId": "a-unique-request-id",
          "status": "reported",
          "paths": ["/workspace/src/App.ts"],
          "declaredComplete": false,
          "truncated": false,
          "uncertainty": "Codex turn diffs may omit changes made outside apply_patch, including shell commands, version-control commands, generators, and child processes."
        }
      }
    }
  }
}
```

Each path is an absolute normalized path in the working directory or an additional workspace directory. The report contains no file content, diff, line count, or path order guarantee.

The adapter sends at most 1,024 paths. Each path has at most 4,096 characters. The serialized report has at most 256 KiB. The optional uncertainty has at most 2,000 characters.

The adapter marks the result unavailable when the prompt is cancelled, the turn diff is invalid, no provider turn ran, or the provider failed. The corresponding reasons are `cancelled`, `invalidOutput`, `notReported`, and `providerError`. The `timeout` reason remains part of the version-1 wire contract for backward compatibility but is not produced by this implementation. Report-generation failures do not change the main prompt outcome; failures of the main provider turn still follow the normal prompt error behavior.

The client must match the request identifier. It must ignore a duplicate, stale, malformed, or unavailable report.

Rollback is outside this extension. This adapter does not advertise an `undo` or `rollback` command.

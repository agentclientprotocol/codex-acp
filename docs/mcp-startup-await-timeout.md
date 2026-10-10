# MCP startup await timeout

Status: Experimental

`session/new`, `session/resume`, and `session/fork` do not wait for the requested MCP servers to reach a terminal
startup state (`ready`, `failed`, or `cancelled`) before the request completes.
`_meta.mcpStartupAwaitTimeoutMs` lets a client enable that wait per request.

`session/load` is unaffected: it never blocks on MCP startup and does not read this field.

## Wire format

```json
{
  "cwd": "/workspace",
  "mcpServers": [
    {
      "name": "docs",
      "command": "npx",
      "args": [
        "docs-mcp"
      ],
      "env": []
    }
  ],
  "_meta": {
    "mcpStartupAwaitTimeoutMs": 3000
  }
}
```

| Value              | Behavior                                                                                                                              |
|--------------------|---------------------------------------------------------------------------------------------------------------------------------------|
| `<= 0` or ommitted | Do not wait. The request completes immediately once the session is created, before any requested MCP server reaches a terminal state. |
| `> 0`              | Wait up to that many milliseconds for a terminal state. If the timeout elapses first, the request completes without waiting further.  |

There is no built-in default timeout: an omitted field means do not wait

## Behavior after the request completes

Without the field, the adapter does not block `session/new` or `session/resume` on MCP startup. The request completes
as soon as the session is created. With the field, the wait ends when the startup completes or at the timeout,
whichever comes first. The adapter never cancels the startup.
It keeps tracking every requested server in the background.

A requested server whose name the Codex config already defines is not passed to Codex: Codex runs its own entry
instead. The wait leaves such a server out, because its startup events, if any, belong to the entry of Codex. A disabled
entry sends none. The adapter reports such a server with the other startup reports, in the same shape, with a text that
says the server was not started.

When the requested servers reach a terminal state, the adapter reports each of them that failed or was cancelled.
Each report is a `session/update` with a new `tool_call` in the `failed` status and the title `mcp__<server>__startup`.
A server that starts successfully gets no report. When a server fails because it needs authentication and the client
supports URL elicitation, the adapter first starts the MCP OAuth sign-in. It reports the server only if the sign-in fails.
The `session/new`, `session/resume`, and `session/load` sessions get these reports. The `session/fork` sessions do not.

To see the live status of every MCP server, send the `/mcp` command. `/mcp reconnect` reloads the MCP configuration and
restarts the servers that failed, stopped, or changed.

## Compatibility

This is a request-scoped ACP `_meta` extension. Clients that omit it get the adapter's default behavior — no wait at
all — so existing integrations are unaffected.
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

The adapter never blocks `session/new` or `session/resume` on MCP startup: the request completes as soon as the session
is created, before any requested MCP server reaches a terminal state. Startup itself is never cancelled or interrupted;
the adapter keeps tracking every requested server in the background and still publishes `session_info_update` MCP status
notifications for `session/new` and `session/resume` sessions as servers finish starting.

## Compatibility

This is a request-scoped ACP `_meta` extension. Clients that omit it get the adapter's default behavior — no wait at
all — so existing integrations are unaffected.
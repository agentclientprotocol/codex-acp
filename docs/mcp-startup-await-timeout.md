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
| `<= 0` or omitted | Do not wait for the requested MCP servers to reach a terminal state. |
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
`session/new`, `session/resume`, v1 `session/load`, and v2 `session/fork` get these reports.
If an MCP-over-ACP listener cannot open, setup continues with the other servers. The failed server is
reported through the same startup report (also on v1 fork) and is not included in the startup wait.
Invalid v2 declarations fail `session/new`, `session/resume`, or `session/fork` with `-32602`:
a repeated server name reports `{name}`, an unadvertised transport reports `{type}`, and a relative
`stdio` command reports `{name, command}`. Use an absolute executable path, such as `/usr/bin/server`,
`C:\tools\server.exe`, or `\\host\share\server.exe`. The adapter also rejects NUL, Windows paths
relative to the current drive, and server names that collide after whitespace is replaced with `_`.
Untagged v1 stdio declarations can still use a command on `PATH`.

On ACP connections, reports and OAuth sign-in for a newly created session wait until its `session/new` response
has been written. The optional startup wait does not wait for the sign-in.

For MCP sign-in, the adapter matches the native completion by `loginId` on the same connection.
An older Codex binary without login attempt IDs cannot complete sign-in through the adapter.
A URL elicitation forwarded from an MCP server is different: accepting it consents to open the URL.
Codex's `serverRequest/resolved` is not proof that the external interaction finished, so the adapter
does not send `elicitation/complete` on that event.

To see the live status of every MCP server, send the `/mcp` command. `/mcp reconnect` reloads the MCP configuration and
restarts the servers that failed, stopped, or changed.

## Compatibility

This is a request-scoped ACP `_meta` extension. Clients that omit it get the adapter's default behavior — no wait at
all — so existing integrations are unaffected.
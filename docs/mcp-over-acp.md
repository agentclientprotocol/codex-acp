# MCP-over-ACP

A client can serve MCP tools over its existing ACP connection. Check `agentCapabilities.mcpCapabilities.acp: true`
on ACP v1 or `capabilities.session.mcp.acp: {}` on v2. Register the server on that connection **before**
sending a session setup request: Codex can discover tools before the request returns.

```json
{
  "cwd": "/workspace",
  "mcpServers": [
    {"type": "acp", "name": "project-tools", "serverId": "project-tools:7a72"}
  ]
}
```

`name` is the server name in Codex. `serverId` is the provider's opaque registration ID; sessions on the same
connection can share it. The same declaration works on new, resume, fork, and v1 load. The usual rules for
[name conflicts, startup failures, and `/mcp` status](mcp-startup-await-timeout.md) apply.

Codex speaks HTTP to the ACP SDK's authenticated loopback bridge. The client does not need an HTTP listener.
Each operation arrives at the client as an `mcp/message` request with the `serverId`, a fresh logical `requestId`,
and the MCP method and parameters. Return `{ "result": ... }` or `{ "error": ... }` for the MCP outcome;
outer ACP errors indicate binding failures. Request-scoped `mcp/message` notifications go back to Codex.
The listener closes with the ACP connection, not with an individual session.

Codex starts with `server/discover`. Include the [discovery result](https://modelcontextprotocol.io/specification/2026-07-28/server/discover)
cache fields: for example, `ttlMs: 0` and `cacheScope: "private"` for an uncached result.
The bridge uses the ACP SDK defaults: 64 concurrent HTTP requests per connection, 1 MiB per request body,
and 1 MiB of buffered stream output for a slow reader.

Only `type: "acp"` servers must support MCP **2026-07-28**; the bridge does not accept legacy `initialize`.
You can use legacy stdio and HTTP servers alongside them. Codex's `mcp_2026_07_28` setting applies to
the whole thread, so Codex may try `server/discover` on ordinary HTTP servers too. A legacy server that
answers `Method not found` can then use `initialize`; an unresponsive discovery request may fail instead.
Threads without a bridged server keep their existing MCP setting. The adapter checks the running
Codex binary's feature list at initialization. If it cannot confirm `mcp_2026_07_28` support
(for example with an older `CODEX_PATH`), it does not advertise the ACP transport.

See the [MCP-over-ACP draft](https://agentclientprotocol.com/rfds/mcp-over-acp.md) for the wire contract.

# Codex thread tools MCP server

This directory contains the adapter-owned MCP server for Codex thread tools.

The server follows the Codex TUI implementation in these upstream files:

- `codex-rs/tui/src/dynamic_tools.rs`
- `codex-rs/tui/src/dynamic_tools_mcp.rs`

The port is based on the current Codex TUI thread tools.
Review these files when the `@openai/codex` dependency changes.

The server binds to `127.0.0.1` and uses a random bearer token. It shares the
existing app-server connection. The adapter adds its URL and token only to the
in-memory thread configuration under the reserved `codex_acp` MCP name.

The server keeps its HTTP endpoint during an app-server restart. It rejects
calls while suspended and reconnects before the adapter resumes ACP sessions.

The server provides the TUI thread tool set. It sends delegation through
`toolOutput`. It uses the paginated turn and item methods for reads. It does not
copy another thread into the current prompt.

The adapter keeps the full session config for recently loaded threads. A child
task inherits that config. The bounded cache holds up to 256 thread configs.
Resume and fork requests receive only the `codex_acp` MCP override. Legacy app
servers use the non-paginated history methods.

`catalog.ts` owns the public MCP schemas. `config.ts` checks the MCP namespace
and managed policy. `executor.ts` maps each tool to an app-server operation.
`thread-content.ts` maps thread data to tool results. `server.ts` owns the HTTP
transport and its lifetime. `output.ts` limits model content. `app-server-api.ts`
contains the new app-server calls until the stable generated SDK exposes them.

The runtime pins the Codex package used to generate the checked API schema.
`app-server-api.ts` isolates experimental calls that the stable schema omits.

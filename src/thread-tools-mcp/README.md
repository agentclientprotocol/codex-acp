# Codex thread tools MCP server

This directory contains the adapter-owned MCP server for Codex thread tools.

The server follows the Codex TUI implementation in these upstream files:

- `codex-rs/tui/src/dynamic_tools.rs`
- `codex-rs/tui/src/dynamic_tools_mcp.rs`

The port is based on OpenAI Codex commit `430d26b543b219049192de559987b8cf506efacf`.
Review these files when the `@openai/codex` dependency changes.

The server binds to `127.0.0.1` and uses a random bearer token. It shares the
existing app-server connection. The adapter adds its URL and token only to the
in-memory thread configuration.

The server provides the TUI thread tool set. It sends delegation through
`toolOutput`. It uses the paginated turn and item methods for reads. It does not
copy another thread into the current prompt.

The adapter keeps the full session config for each loaded thread. A child task
inherits that config. This includes custom providers, MCP servers, trust, and
workspace roots. Legacy app servers use the non-paginated history methods.

`catalog.ts` owns the public MCP schemas. `executor.ts` maps each tool to an
app-server operation. `thread-content.ts` maps thread data to tool results.
`server.ts` owns the HTTP transport and its lifetime. `output.ts` limits model
content. `app-server-api.ts` contains the new app-server calls until the stable
generated SDK exposes them.

The runtime uses the pinned Codex alpha that provides `toolOutput` and history
pagination. Generated types stay on the stable schema. `app-server-api.ts`
isolates the temporary type gap.

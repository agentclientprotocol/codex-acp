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

The server provides the TUI thread tool set. The current app-server SDK does not
provide the TUI `toolOutput` input. The server sends delegated prompts as text.
It does not copy another thread into the current prompt.

`catalog.ts` owns the public MCP schemas. `executor.ts` maps each tool to an
app-server operation. `server.ts` owns the HTTP transport and its lifetime.
`output.ts` limits content returned to the model.

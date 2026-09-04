# ACP adapter for Codex CLI

[![npm version](https://img.shields.io/npm/v/%40agentclientprotocol%2Fcodex-acp)](https://www.npmjs.com/package/@agentclientprotocol/codex-acp)

Use [OpenAI Codex](https://github.com/openai/codex) from [Agent Client Protocol](https://agentclientprotocol.com/) clients.

`codex-acp` is a stdio ACP agent server. It starts the Codex App Server, translates ACP requests into Codex operations, and maps Codex events back into the client.

## Features

- ChatGPT, API key, and client-provided custom gateway authentication.
- Model, reasoning effort, fast mode, approval, and sandbox mode configuration.
- Text prompts, embedded context, images, resource links, and additional workspace directories.
- Shell command, file change, [permission request](docs/permission-extension.md), MCP tool call, terminal output, reasoning, plan, web search, image generation, image view, token usage, and review events.
- [Native ACP subagent sessions](docs/subagent-sessions.md) (after capability negotiation) with separate child histories and root-routed permissions; a legacy tool-call fallback otherwise.
- [Background terminal tasks](docs/async-tasks.md) in AIR, with task status and targeted stop support after capability negotiation.
- Session-scoped long-running goals through the provider-neutral [goal extension](docs/goal-extension.md).
- A per-turn [agent file-change report](docs/agent-file-change-report.md) after capability negotiation.
- Client-provided MCP servers over command-based stdio config and HTTP transport.
- Slash commands: `/status`, `/mcp`, `/skills`, `/goal`, `/review`, `/review-branch`, `/review-commit`, `/compact`, and `/logout`, as well as configured skills.

## Installation

Run the published package directly:

```bash
npx -y @agentclientprotocol/codex-acp
```

Or install it globally:

```bash
npm install -g @agentclientprotocol/codex-acp
codex-acp --version
```

The npm package includes a compatible `@openai/codex` dependency. Set `CODEX_PATH` only when you want the adapter to run a different Codex binary:

```bash
CODEX_PATH=/path/to/codex npx -y @agentclientprotocol/codex-acp
```

To try changes that have landed on `main` but are not released yet, install from the
`preview` channel — every push to `main` publishes one. See
[docs/RELEASES.md](docs/RELEASES.md#preview-releases).

```bash
npx -y @agentclientprotocol/codex-acp@preview
```

## Authentication

The adapter advertises ACP auth methods during initialization. Clients can authenticate with:

- ChatGPT login. Set `NO_BROWSER=1` to hide this method in remote or browserless environments.
- API key via `CODEX_API_KEY` or `OPENAI_API_KEY`.
- A custom OpenAI-compatible gateway, when the client opts in to the gateway auth capability.

## Runtime options

- `CODEX_API_KEY` - API key used when the API-key auth method is selected. Takes precedence over `OPENAI_API_KEY`.
- `OPENAI_API_KEY` - fallback API key used when the API-key auth method is selected.
- `CODEX_PATH` - run a specific Codex executable instead of the bundled package dependency.
- `CODEX_CONFIG` - JSON object merged into the Codex session config.
- `MODEL_PROVIDER` - model provider to pass to Codex for new sessions.
- `DEFAULT_AUTH_REQUEST` - ACP auth request JSON used when Codex requires authentication.
- `INITIAL_AGENT_MODE` - initial mode id: `read-only`, `agent`, or `agent-full-access`.
- `NO_BROWSER` - hide browser-based ChatGPT auth when set.
- `APP_SERVER_LOGS` - directory for adapter logs.

## Development

```bash
npm install
npm run start
npm run typecheck
npm test
```

Build standalone binaries in `dist/bin` with:

```bash
npm run bundle:all
```

See [readme-dev.md](readme-dev.md) for local client configuration, binary packaging, and Codex type regeneration.

### Subagent sessions

Subagent sessions follow the draft [ACP subagent RFD](https://github.com/agentclientprotocol/agent-client-protocol/pull/1992) and are enabled only after bilateral capability negotiation during `initialize`. Without native negotiation, the subagent lifecycle stays an ordinary ACP tool call.

See [docs/subagent-sessions.md](docs/subagent-sessions.md) for the negotiation, lifecycle events, `session/load` reconstruction, and legacy fallback details.

### Background terminal tasks

Codex can keep a shell command running after a turn continues. AIR clients can show this work in the Async Tasks panel and stop one command.

See [docs/async-tasks.md](docs/async-tasks.md) for the capability, lifecycle events, and stop request.

## License

By contributing, you agree that your contributions will be licensed under the Apache 2.0 License.

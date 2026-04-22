# ACP Adapter for Codex CLI
[![npm version](https://img.shields.io/npm/v/%40jetbrains%2Fcodex-acp)](https://www.npmjs.com/package/@jetbrains/codex-acp)

An [Agent Client Protocol (ACP)](https://agentclientprotocol.org) server that bridges the [OpenAI Codex CLI](https://github.com/openai/codex) with JetBrains IDEs. It translates ACP requests from the IDE into Codex app-server JSON-RPC calls and streams events back.

## Installation

### Via npm

```bash
npm install -g @jetbrains/codex-acp
```

### Via binary

Download the pre-built binary for your platform from the [GitHub releases page](https://github.com/JetBrains/codex-acp/tags), then unzip:

```bash
unzip codex-acp-<platform>.zip
```

## Usage

The server runs as a child process managed by the IDE. Configure your IDE's ACP agent config to point to `codex-acp`.

### Run from npm

```json
{
  "agent_servers": {
    "Codex (app-server)": {
      "command": "codex-acp",
      "env": {
        "CODEX_PATH": "/path/to/codex"
      }
    }
  }
}
```

### Run from binary

```json
{
  "agent_servers": {
    "Codex (app-server)": {
      "command": "/path/to/codex-acp",
      "env": {
        "CODEX_PATH": "/path/to/codex"
      }
    }
  }
}
```

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `CODEX_PATH` | No | Path to the Codex binary. Defaults to the bundled `@openai/codex` binary. |
| `CODEX_CONFIG` | No | JSON string with Codex configuration overrides. |
| `DEFAULT_AUTH_REQUEST` | No | JSON string with a default auth request (pre-selects auth method). |
| `MODEL_PROVIDER` | No | Override the model provider. |
| `APP_SERVER_LOGS` | No | Path to a directory for Codex app-server log output. |

### Authentication

To authenticate manually (e.g. for ChatGPT login):

```bash
codex-acp login
```

## Development

See the **[Development Guide](readme-dev.md)** for setup, running from source, building binaries, and updating the Codex version.

## Release

See the **[Release Instructions](release.md)** for creating a new release.

## License

[Apache 2.0](LICENSE)

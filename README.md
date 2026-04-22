# ACP adapter for Codex CLI
[![npm version](https://img.shields.io/npm/v/%40jetbrains%2Fcodex-acp)](https://www.npmjs.com/package/@jetbrains/codex-acp)


## Overview

Codex ACP is an **ACP (Agent Communication Protocol) adapter** that bridges JetBrains IDEs and the Codex CLI tool.

It runs a local server that exposes Codex as an ACP-compatible agent, allowing IDE clients to drive AI-assisted coding sessions through a standardized protocol.

### Architecture

- **`index.ts`** — CLI entry point (login + server startup)
- **`CodexJsonRpcConnection`** — spawns and manages the Codex process via JSON-RPC
- **`CodexAcpServer`** — implements the ACP `Agent` interface, handles sessions and message routing
- **`CodexAcpClient`** — higher-level API over Codex (models, threads, MCP servers)

### Key Technologies

- **Language:** TypeScript, built with Bun
- **Protocols:** ACP (`@agentclientprotocol/sdk`), JSON-RPC (`vscode-jsonrpc`), MCP
- **Integration:** `@openai/codex` CLI binary

### Output

Single-file executables for 6 platforms (Linux/macOS/Windows × x64/ARM64), suitable for bundling inside IDE plugins.

## Documentation

- **[Development Guide](readme-dev.md)** - Setup, configuration, and building binaries
- **[Release Instructions](release.md)** - How to create a new release
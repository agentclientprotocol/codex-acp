# ACP adapter for Codex CLI
[![npm version](https://img.shields.io/npm/v/%40jetbrains%2Fcodex-acp)](https://www.npmjs.com/package/@jetbrains/codex-acp)


## Overview

Codex-ACP is an **Agent Communication Protocol (ACP) adapter** that bridges JetBrains IDEs with OpenAI Codex. It runs as a subprocess that receives ACP requests from an IDE via JSON-RPC over stdio, translates them into Codex app-server calls, and converts responses back to ACP format — enabling AI-powered code assistance inside JetBrains IDEs.

### Main components

| File | Role |
|------|------|
| `CodexAcpServer.ts` | ACP Agent implementation, session management, request routing |
| `CodexAcpClient.ts` | API bridge, authentication (API key / ChatGPT / gateway) |
| `CodexAppServerClient.ts` | Low-level JSON-RPC communication with Codex app-server |
| `CodexEventHandler.ts` | Converts Codex notifications → ACP updates |
| `CodexToolCallMapper.ts` | Maps Codex tool calls to ACP format |

### Tech stack

TypeScript + Bun, tested with Vitest, distributed as single-file binaries for Linux/macOS/Windows (x64 + ARM64).

## Documentation

- **[Development Guide](readme-dev.md)** - Setup, configuration, and building binaries
- **[Release Instructions](release.md)** - How to create a new release
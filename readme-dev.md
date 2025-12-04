### Quick start

1. Install dependencies `npm install`
2. Download or install codex binary
3. Adjust acp config for IDE
```json
{
  "agent_servers": {
    "Codex (app-server)": {
      "command": "npx",
      "args": [
        "npm",
        "run",
        "start",
        "--prefix",
        "/home/alex/work/codexacp/codex-acp/"
      ],
      "env": {
        "CODEX_PATH": "/home/alex/.codex/jetbrains/codex-latest"
      }
    }
  }
}

```

### Build binaries

Build single executables in `dest/bin` directory:

`npm run bundle:all`

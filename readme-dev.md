### Quick start from sources

#### Download or install codex binary 

Last checked version: `codex-cli 0.64.0-alpha.9`)

#### Adjust acp config for IDE

Run from sources
1. Install dependencies `npm install`
2. Adjust acp config for IDE
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
        "/path/to/project/"
      ],
      "env": {
        "CODEX_PATH": "/path/to/codex"
      }
    }
  }
}
```

Run from binaries
1. Download acp-server binary from https://github.com/JetBrains/codex-acp/tags
2. Adjust acp config for IDE
```json
{
  "agent_servers": {
    "Codex (app-server)": {
      "command": "/path/to/acp-server",
      "env": {
        "CODEX_PATH": "/path/to/codex"
      }
    }
  }
}
```

Optionally, set a path to log directory via env variable `APP_SERVER_LOGS`.

### Build binaries

Build single executables in `dest/bin` directory:

`npm run bundle:all`

### Generate codex-specific types

Generate files in `src/app-server/`: `npm run generate-types`
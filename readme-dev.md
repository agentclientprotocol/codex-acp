This package lists codex only as a dev dependency and requires the codex binary.
It may not work with versions other than the one specified in package.json.

### Quick start

#### Develop on Windows?
- Download and install [bun](https://bun.com/docs/installation#windows)
- Download and install [C++ redistributable package](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist?view=msvc-170#latest-supported-redistributable-version)

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
        "CODEX_PATH": "node_modules/.bin/codex",
        "APP_SERVER_LOGS": "optional/path/to/existing/log/directory"
      }
    }
  }
}
```

Run from binaries
1. Download acp-server binary archive from https://github.com/JetBrains/codex-acp/tags
2. Unzip the archive:
   ```bash
   unzip codex-acp-<platform>.zip
   ```
3. Adjust acp config for IDE
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

### Build binaries

Build single-file executables in `dist/bin` directory:

```bash
npm run bundle:all
```

Package binaries into zip archives:

```bash
npm run package:all
```

### Update supported Codex version

1. Update Codex dependency: `package.json`
2. Regenerate Codex types in `src/app-server/`: `npm run generate-types`
3. Ensure there are no type errors or failed tests: `npm run typecheck` and `npm run test`
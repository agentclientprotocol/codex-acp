This package uses the bundled `@openai/codex` dependency by default.
Set `CODEX_PATH` to run a different Codex binary; versions other than the one specified in `package.json` may not be compatible.

### Runtime environment

- `CODEX_API_KEY` - API key used when the API-key auth method is selected. Takes precedence over `OPENAI_API_KEY`.
- `OPENAI_API_KEY` - fallback API key used when the API-key auth method is selected.
- `CODEX_PATH` - run a specific Codex executable instead of the bundled package dependency.
- `CODEX_CONFIG` - JSON object merged into the Codex session config. `hooks` move to App Server startup (`-c hooks=...`) for AIR review; Codex rejects malformed hooks at startup and `initialize` reports its error.
- `MODEL_PROVIDER` - model provider to pass to Codex for new sessions.
- `DEFAULT_AUTH_REQUEST` - ACP auth request JSON used when Codex requires authentication.
- `INITIAL_AGENT_MODE` - initial mode id: `read-only`, `workspace-write`, `agent`, or `agent-full-access`.
- `NO_BROWSER` - hide browser-based ChatGPT auth when set.
- `APP_SERVER_LOGS` - directory for adapter logs.

### Quick start

#### Develop on Windows?

- Download and install [C++ redistributable package](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist?view=msvc-170#latest-supported-redistributable-version)

#### Adjust ACP client config

Run from sources

1. Install dependencies `npm install`
2. Adjust ACP client config

```json
{
  "agent_servers": {
    "Codex (app-server)": {
      "command": "npm",
      "args": ["run", "start", "--prefix", "/path/to/project/"],
      "env": {
        "CODEX_PATH": "node_modules/.bin/codex",
        "APP_SERVER_LOGS": "optional/path/to/existing/log/directory"
      }
    }
  }
}
```

Run from binaries

1. Download a `codex-acp-<platform>.zip` archive from https://github.com/agentclientprotocol/codex-acp/releases (`<platform>` is one of: `linux`, `darwin`, `win32`)
2. Unzip the archive:
   ```bash
   unzip codex-acp-<platform>.zip
   ```
3. Adjust ACP client config

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

### Reproduce native stdio E2E without credentials

Requires Node.js 24+, Python 3, Git, and the platform optional dependency installed
by `npm ci`. Run the same command on Windows or Linux:

```sh
npm ci
npm run test:native
```

For a standalone rewind/core change, use `npm run test:native -- --rewind-only`.
In PowerShell, use `npm.cmd run test:native -- --rewind-only` if `npm.ps1`
consumes the argument, or invoke `node scripts/native-e2e.mjs --rewind-only`
directly. `build.json` records `mode: "rewind-only"` so the selected scope is
verifiable. These entry points all rebuild before running.
This runs first/historical/latest rewind, cold restart with no resend, resend
context, stale/bad targets, duplicate identities and cancellation. It asserts
only the rewind capability; it does not call or require file-revert, runtime or
discovery extensions. Build/environment/process checks still apply. The default
suite includes all rewind checks plus the file checks below.

`test:native` builds the current checkout before each run. It resolves the native
executable from the installed `@openai/codex` platform package, creates a new
fixture under `tmp/native-e2e/run-*`, and uses real ACP/native stdio processes.
The only fake is a scripted Responses model bound to `127.0.0.1`; it returns the
actual advertised `apply_patch` tool call, which the native process executes.
No account, API key, saved user session, or globally installed Codex is needed.

The suite checks first-message, historical and latest rewind with the same session ID,
cold restart before resend, actual resend model context, duplicate identities,
bad-target non-mutation, active-turn rewind/cancellation, and explicit cancellation.
It also checks native file-change events and cold replay, read-only preview,
required/stale tokens, conflicts, successful patch reversal, preservation of
independent staged/unstaged/untracked files and exact Git index bytes, and
continuation without changing conversation history. A spawn observer records
the runtime native identity, `windowsHide: true`, and child exits without changing
spawn options. The Windows check requires `windowsHide` on runtime children;
the observer follows Node supervisors on Linux too. No client file/tool shim
stands in for native execution.

All subprocesses receive an environment whitelist with fresh HOME, CODEX_HOME,
profile/config/cache/temp directories and no inherited credentials. Runtime PATH
is narrowed to Node, Git and OS utilities. HTTP(S) proxies deny non-loopback
requests; the provider needs no authorization. This is an application-level
network boundary, not an OS firewall. The fixture uses full-access mode to make
native text patches portable without requiring a host sandbox installation.
Only synthetic fixture paths are provided to its scripted tool calls.

Each run writes `report.json`, `build.json` (source/build/native hashes),
`rpc-traces.json`, `model-requests.json`, `title-requests.json`, `spawns.jsonl`, native tool outputs and
stderr logs. Failures return nonzero and retain their evidence. Changes to source,
dist, or the native binary during the run fail verification; finish concurrent
edits first and rerun. There is deliberately no resume-old-fixture/skip-build mode.
The Linux/Windows CI matrix uploads these fresh fixture artifacts even on failure.

Ephemeral title-generation requests are recognized by their output schema and
title instruction, answered locally and recorded separately. They cannot consume
the expected user-turn request budget or satisfy a no-resend/context assertion.

Optional knobs (no runtime credentials are passed through):

- `node scripts/native-e2e.mjs --rewind-only --wrong-reply` deliberately changes
  the first loopback assistant response. The normal ACP reply assertion must
  fail with `Assistant reply mismatch`, `wrongReplyInjected: true` in the report,
  and exit code **1**. This is a negative control, not a passing test command;
  it does not force an exit or change production behavior.

- `npm run test:native -- --output <directory>` creates a unique run under that
  artifact parent directory; it never reuses an existing run.
- `NATIVE_E2E_PYTHON` selects a Python 3 executable (default `python` on Windows,
  `python3` elsewhere). Set it in the invoking shell if Python is not on PATH.

### Build binaries

Building standalone binaries requires [bun](https://bun.com/docs/installation).

Build single-file executables in `dist/bin` directory:

```bash
npm run bundle:all
```

Package binaries into zip archives:

```bash
npm run package:all
```

### Update supported Codex version

1. Update the `@openai/codex` version in `package.json` (under `dependencies`).
2. Regenerate Codex types in `src/app-server/`: `npm run generate-types`
3. Ensure there are no type errors or failed tests: `npm run typecheck` and `npm run test`

### Session notices

The adapter implements [Session Notices](https://agentclientprotocol.com/rfds/session-notices)
for Codex warnings, configuration warnings, deprecation notices, model rerouting, and the legacy
`thread/compacted` advisory when the client advertises `clientCapabilities.session.notices: {}`.
These are live `session/update` notifications with
`sessionUpdate: "notice"`, a severity, a plain-text title, and optional description.
They are not replayed from session history and repeated notices remain independent events.

Without that capability (including absent or null capability objects), the adapter preserves
the existing assistant/thought text or AIR `sessionFailure` advisory records. When notices are
enabled, they take precedence over AIR advisory records. Clients control their presentation;
the adapter does not rely on notices being displayed.

Command replies, review results, and terminal/retrying errors retain their existing response or
failure channels. Clients advertising session compaction support continue to receive the dedicated
compaction lifecycle instead of the legacy completion advisory.

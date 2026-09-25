This package uses the bundled `@openai/codex` dependency by default.
Set `CODEX_PATH` to run a different Codex binary; versions other than the one specified in `package.json` may not be compatible.

### Runtime environment

- `CODEX_API_KEY` - API key used when the API-key auth method is selected. Takes precedence over `OPENAI_API_KEY`.
- `OPENAI_API_KEY` - fallback API key used when the API-key auth method is selected.
- `CODEX_PATH` - run a specific Codex executable instead of the bundled package dependency.
- `CODEX_CONFIG` - JSON object merged into the Codex session config.
- `MODEL_PROVIDER` - model provider to pass to Codex for new sessions.
- `DEFAULT_AUTH_REQUEST` - ACP auth request JSON used when Codex requires authentication.
- `INITIAL_AGENT_MODE` - initial mode id: `read-only`, `agent`, or `agent-full-access`.
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

### AIR diff statistics

See the [diff statistics specification](docs/diff-statistics-extension.md) for the
`_meta.jetbrains.air.diffStats` payload and its compatibility rules.

### ACP v2 support

The agent speaks both ACP v1 and the unstable ACP v2 (Draft) protocol from the same process; the
version is negotiated on the first `initialize` request and fixed for the connection's lifetime.

The v2 chain registers: `initialize`, `session/new|list|close|delete|resume` (v2 folds `session/load`
into `session/resume` with `replayFrom`), `session/set_config_option`, `session/cancel`,
`auth/login|logout`, `session/prompt` (plus `$/cancel_request`), `session/fork`, and
`providers/list|set|disable`. Unstable extension methods on top of that: `_session/steering`,
`_session/goal` (set/pause/resume/clear), and `_session/async_task/stop`. `session/fork` drops the
v1 `modes` field (v2 removed the modes API in favor of config options), and forked sessions do not
get an `available_commands_update`, matching v1. There are no new environment/config knobs specific
to v2; it reuses the runtime environment variables above.

#### AIR v2 client contract

These are behaviors the AIR (JetBrains) ACP client relies on that aren't obvious from the wire
schema alone:

- On a failed prompt, read `sessionFailure` (`_meta.jetbrains.air.sessionFailure`) and `quota`
  (`_meta.quota`) from the idle `state_update` that ends the turn, not from a separate error
  channel. The same `_meta` v1 attaches to `PromptResponse` is copied onto the v2 idle update.
- Custom session updates are renamed on v2: `subagent_spawned`/`subagent_state_update` become a
  single `_subagent_update` (gated on the AIR `nativeSubagentSessions` capability; it will rename to
  `subagent_update` once the subagent RFD, spec PR #1992, lands), and
  `async_task_spawned`/`async_task_state_update` become `_async_task_spawned`/`_async_task_state_update`
  (gated on the AIR `asyncTasks` capability). Payload shapes are unchanged.
- The SDK client treats any `idle` state update as the stop of whichever prompt is pending, not just
  one paired 1:1 with a `session/prompt` call.
- A steer (`_session/steering`) shows up as a `user_message` once it actually lands in the turn.
- On cancel, any permission or elicitation request still waiting on a client response is withdrawn
  with `$/cancel_request`, not just the underlying Codex turn.
- Turns Codex starts on its own (goal auto-turns, e.g. after `session/resume` or `session/new`) are
  rendered the same as prompted turns (`running` then one `idle`) but with no corresponding
  `session/prompt` call — clients should not assume every `running`/`idle` pair has a matching
  outbound prompt.
- After a tool call streams terminal output as `terminal_output_chunk`s, completion does not resend a
  full `output` snapshot; the streamed chunks are the only copy of the output.

#### Known gaps

- After `providers/disable("openai")`, `providers/list` still reports native OpenAI routing as the
  current provider. The providers RFD says a disabled provider's `current` should be `null`; this is
  left as-is and documented here rather than fixed.
- Open question for AIR: AIR's fork points match Codex item ids, but on v2 a user message's
  rendered id is the client-minted `clientId` (when the client supplied one), not the Codex item id.
  A fork at a user message would not resolve. This is flagged for AIR, not fixed here.
- A session that never had its first turn before a provider restart has no rollout on disk yet, so
  `thread/resume` (and the `thread/read` fallback) fails during the restart's resume loop, and the
  session is left dead: `providers/*` reports a resume failure and the next `session/prompt` for
  that session fails with "thread not found". Not fixed here.

#### Verification

The ACP TCK (Technology Compatibility Kit) can run against either protocol version; see
`.agents/tck/HOW-TO-RUN.md` for the full setup and commands (run the v1 suite as-is, and the v2 suite
with `--protocol-version 2`).

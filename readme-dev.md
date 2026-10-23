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
- `CODEX_ACP_APP_SERVER_CRASH_LIMIT` - how many crashes of the Codex app-server in the crash window stop its automatic restart (default `5`).
- `CODEX_ACP_APP_SERVER_CRASH_WINDOW_MS` - the crash window in milliseconds (default `300000`, 5 minutes).

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

### Test suites

- `npm test`: unit tests with the Codex app-server mocked.
- `npm run test:integration`: real codex-acp plus a real `codex app-server`. The model is a local mock of the
  OpenAI Responses API (`src/__tests__/integration/mock-responses-server.ts`) reached through the `gateway`
  auth method, so no API key or network is needed. Tests script model replies with `textResponse`,
  `execCommandResponse` and `applyPatchResponse`.
- `npm run test:e2e`: real OpenAI model. Builds first and requires `RUN_E2E_TESTS=true` (set by the script)
  plus `OPENAI_API_KEY` or `CODEX_API_KEY` in the environment.

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


### App-server recovery

The adapter restarts the Codex app-server when it dies (for example, killed for lack of memory). Its code is in
`src/app-server-recovery/`.

- A request that was waiting on the dead app-server fails with error `1001` and the cause, such as "was killed by
  SIGKILL, which usually means it ran out of memory". A running prompt ends at once: open tool calls become `failed`,
  open permission dialogs are cancelled, and an AIR client gets the `transport_lost` session failure.
- An app-server that exits before its `initialize` handshake succeeded, such as one that rejects its startup config,
  fails the request with "Codex process has exited with code N:" and its stderr, and no promise of a restart.
- The next request starts a new app-server with the same `initialize` handshake and provider routing. A session that
  was open is resumed on its next use, with the model, mode and settings that the adapter kept.
- Codex writes a thread to disk only with its first message, so a session without messages cannot be resumed in a new
  app-server, after a crash or a provider restart. Its next use fails with "had no messages yet and was lost"; the
  client starts a new session. A provider restart still completes for the agent and the other sessions.
- After `CODEX_ACP_APP_SERVER_CRASH_LIMIT` crashes in the crash window the adapter stops restarting it and says so,
  with the stderr of the last crash.
  A session that the app-server died opening twice in 30 minutes is not opened again for the rest of that time, so
  one session that is too large for the memory cannot take the other sessions down with it.

### ACP v2 support

The agent speaks both ACP v1 and the unstable ACP v2 (Draft) protocol from the same process; the
version is negotiated on the first `initialize` request and fixed for the connection's lifetime.

The v2 chain registers: `initialize`, `session/new|list|close|delete|resume` (v2 folds `session/load`
into `session/resume` with `replayFrom`), `session/set_config_option`, `session/cancel`,
`auth/login|logout`, `session/prompt` (plus `$/cancel_request`), `session/fork`, and
`providers/list|set|disable`. Unstable extension methods on top of that: `_session/steering`,
`_session/goal` (set/pause/resume/clear), `_session/async_task/stop`, and the AIR session index
requests (`_session/rename`, `_session/archive|unarchive`, `_session/list/subscribe|unsubscribe`).
`session/fork` drops the
v1 `modes` field (v2 removed the modes API in favor of config options), and forked sessions do not
get an `available_commands_update`, matching v1. There are no new environment/config knobs specific
to v2; it reuses the runtime environment variables above.

#### Client system prompts

Both ACP versions advertise `systemPrompt: {}`: text-only `append` mode. Override and non-text
content are rejected with `-32602` before a session is created or a fork is made.
Text blocks are joined with a blank line and appended to the existing developer-instruction
baseline: AIR `customInstructions` when supplied, otherwise configured Codex developer instructions.
Codex's base instructions and workspace context remain intact. Requests without `systemPrompt`
keep the legacy AIR behavior.

New sessions use the instructions on their first turn. A changed prompt on an idle, persisted
session detaches and reloads that thread under the same session ID. **The retained model context
changes at the next compaction**, not immediately after resume; the adapter does not force a
compaction. Forks with changed instructions have the same deferred behavior.

Changed prompts are rejected while session work or background terminals are running, when a live
session has no saved rollout yet, or when Codex cannot confirm a reload. Existing work is not
cancelled. Retry after work finishes, or create a new session for immediate instructions.
New prompts, steering, and config changes cannot race an instruction reload.

Omitted/null prompts keep the instructions known to the currently open adapter session, including
through app-server recovery and provider restarts. After closing a session or restarting the
adapter, clients should resend their prompt on load/resume/fork; without it, Codex's retained
context and configured defaults determine the instructions.

#### Manual compaction

`/compact` finishes foreground work only after Codex reports `turn/completed` for the compact
turn. Item completion still reports compaction progress, but does not release the next prompt.
The v1 prompt response and v2 idle state wait for the turn to finish; v2's early prompt-acceptance
response is unchanged.

#### Standard subagent sessions

Non-AIR v1 clients opt in with `clientCapabilities.subagents: {}`. On v2, standard subagent
sessions need no feature marker. AIR retains its existing private opt-in, fallback, updates, and
generation-based identities; a connection receives one contract, not both. The v1 marker used by
older AIR clients also keeps that existing behavior.

Standard `subagent_update` associations appear in the immediate parent's session before any child
traffic. A child keeps its opaque ACP session ID across delegations, idle work, and replay.
Nested children are not flattened under the root; traffic without sufficient parentage is buffered
until the ancestor chain is known. Forked histories get a separate child identity namespace.

Work state is independent of conversation lifetime. An observed work ending reports `idle` with
its stop reason, not a permanently completed child. Lost observability reports `unknown`, not a
fabricated failure. On v2, the same state also appears on the child's own `state_update` stream.
Child work, plans, permissions, and elicitation can outlive the parent's foreground prompt.
Child item-rendering state is conversation-owned too, so a new parent prompt does not reset
an active child's terminal or streamed item tracking.
Child Markdown plans use completed snapshots rather than interim draft deltas.
Parent cancellation interrupts observed descendant work and withdraws child interactions; late
answers cannot restart finished work. Closing or replacing the runtime invalidates those scopes.

Children initially advertise empty capabilities. Client-initiated prompts, load/resume/fork,
cancel, close/delete, configuration changes, and private session mutations are not enabled.
Responding to child-scoped Agent-to-Client requests is still allowed. Replayed associations and
transcripts do not grant controls or confirm current activity; overlapping completed items are
deduplicated and fresh work snapshots follow the replay response. A copied history alone never
authorizes interrupting the original child runtime.
Restored child routes require provider-confirmed parentage through the verified ancestor chain.
Only already-loaded runtimes are rejoined; inactive owned children are not loaded just for replay,
but their routes can receive later live work. Foreign or unverified fork descendants stay history-only.
Child history uses the same traversal for both Codex spawn formats and reconciles completed
items with live tool tracking before suppressing overlapping notifications.
Load/resume attachment operations for the same standard parent are serialized. Fresh child
traffic follows the actual response write, including when the response is part of a batch;
overlapping attachments publish after the latest setup's response rather than interleaving
with its replay. Close and cancel remain independent, and a close invalidates queued setups.

Dedicated `session_message` reporting and optional child controls remain follow-ups. Ordinary
runtime tool reports remain available for operations such as waiting and follow-up tasks.

#### AIR v2 client contract

These are behaviors the AIR (JetBrains) ACP client relies on that aren't obvious from the wire
schema alone:

- Initial commands come from `availableCommands` in v2 `session/new`, `session/resume`, and
  `session/fork` responses, not an initial `available_commands_update`. Later command changes still
  use notifications. Text inputs use `type: "text"`, and AIR command actions and skill paths are
  preserved. Skill discovery is best-effort: setup succeeds without initial commands if it fails.
- Failed foreground work ends with `state: "idle"`, `stopReason: "error"` and a standard `error`
  object containing `code` and a user-facing `message`. Before insertion, the prompt also fails
  with a JSON-RPC error; after insertion, its successful `messageId` response is not revoked.
  Cancellation remains `cancelled`. Retries, individual failed tools, and idle background errors
  do not become terminal session failures. Raw process stderr and opaque error data are not sent
  in the standard error object.
- On a failed prompt, read `sessionFailure` (`_meta.jetbrains.air.sessionFailure`) and `quota`
  (`_meta.quota`) from the idle `state_update` that ends the turn, not from a separate error
  channel. The same `_meta` v1 attaches to `PromptResponse` is copied onto the v2 idle update.
- Custom session updates are renamed on v2: `subagent_spawned`/`subagent_state_update` become a
  single `_subagent_update` (gated on the AIR `nativeSubagentSessions` capability; this contract is
  retained independently of standard subagent sessions), and
  `async_task_spawned`/`async_task_state_update` become `_async_task_spawned`/`_async_task_state_update`
  (gated on the AIR `asyncTasks` capability). Payload shapes are unchanged.
- Foreground state is independent of prompt acceptance. `running` can precede the user-message
  echo, including while Codex runs hooks. A successful prompt response still waits for insertion.
- Every successful `session/resume` sends a current-state snapshot after any replay and before its
  response. An idle snapshot is not another completed turn and repeats no usage or failure metadata.
- Permission and elicitation requests affect aggregate foreground state: another runnable item keeps
  the session running, and answering one wait does not resume work that remains blocked. Withdrawing
  a request on cancellation does not resume the workflow; late answers cannot revive an ended turn.
- A steer (`_session/steering`) shows up as a `user_message` once it actually lands in the turn.
- On cancel, any permission or elicitation request still waiting on a client response is withdrawn
  with `$/cancel_request`, not just the underlying Codex turn.
- Turns Codex starts on its own (goal auto-turns, e.g. after `session/resume` or `session/new`) are
  rendered the same as prompted turns (`running` then one `idle`) but with no corresponding
  `session/prompt` call — clients should not assume every `running`/`idle` pair has a matching
  outbound prompt.
- After a tool call streams terminal output as `terminal_output_chunk`s, completion does not resend a
  full `output` snapshot; the streamed chunks are the only copy of the output.
- The AIR tool call contract (`docs/air-extensions.md`) does not apply on v2: every v2 client gets
  the standard tool call reports, so `rawInputRendering`, `planContentDelta` and `diffPatch` are not
  offered there. A read, search or list command has no terminal; its output arrives as `content`
  text when it completes. A file change sends one diff per file whose Git patch is built from the
  Codex diff.
- The AIR `sessionIndex` extension (`docs/air-extensions.md`, "Session index") works as on v1: a
  client that declares `sessionIndex` gets it, `session/list` reads `_meta.jetbrains.air.list`, and
  rows, `session_info_update`s and `_session/list/changes` carry the same `_meta`.
- Other AIR `_meta` keys (goal, message phase, mode kind, permission presentation) go only to AIR
  clients, as on v1. Every v2 permission request still gets its prompt `title` and `description`.

#### Models of a `providers/set` gateway

`providers/set` lists the models of the gateway (`GET {baseUrl}/models`, with the headers Codex sends to it)
before it responds. The models reported to the client are then only the Codex models whose `model` or `id` the
gateway lists, matched without case and date suffix. A session whose thread model the gateway does not list uses
the default of these models; a thread model that the gateway lists but Codex does not know is kept. A gateway that
lists none of the Codex models leaves no model option at all, and the session keeps the thread's model as current.
Sessions already open get the models of the new routing when the provider restart resumes them, after
`providers/disable` too. A 4xx answer means the gateway has no listing: `providers/set` succeeds and nothing is
narrowed. A failed listing (network error, a status other than 2xx or 4xx, malformed body, or the timeout) fails
`providers/set` with `internal_error` and keeps the current routing; a base URL that is not http(s) fails with
`invalid_params`. A listing that finishes after a newer `providers/set` or `providers/disable` was applied is
dropped. The `gateway` auth method and providers from
the Codex config are not listed.

#### Known gaps

- After `providers/disable("openai")`, `providers/list` still reports native OpenAI routing as the
  current provider. The providers RFD says a disabled provider's `current` should be `null`; this is
  left as-is and documented here rather than fixed.
- Open question for AIR: AIR's fork points match Codex item ids, but on v2 a user message's
  rendered id is the client-minted `clientId` (when the client supplied one), not the Codex item id.
  A fork at a user message would not resolve. This is flagged for AIR, not fixed here.

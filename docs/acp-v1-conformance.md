# ACP v1 conformance (acp-tck)

[`acp-tck`](https://github.com/EugeneTheDev/acp-tck) drives an agent through the ACP v1
protocol -- initialize, session lifecycle, prompt turns, cancellation, error handling,
transport hygiene -- and reports every requirement as `PASS` / `FAIL` / `SKIPPED` /
`NOT_TESTED` in one of four tiers. `MANDATORY` and `CAPABILITY` failures make the run
`NOT CONFORMANT`; `ADVISORY` and `INFORMATIONAL` never affect the verdict.

Current result: **CONFORMANT** -- 21/21 `MANDATORY`, 17/17 exercised `CAPABILITY`, 10/11
exercised `ADVISORY`. The single remaining `ADVISORY` failure is deliberate and explained
below.

## Running it

The TCK launches the adapter as a stdio subprocess, one fresh process per test:

```
npm run build
uv run acp-tck --agent-cwd /tmp/acp-tck-wd --timeout 90 --test-timeout 180 \
  --cancel-prompt "<something that keeps the model busy>" \
  --report-json report.json -- node dist/index.js
```

Most tests need a working prompt turn, so the adapter has to reach *a* model. Either sign in
normally, or -- to keep a conformance run off real credentials and off the network -- point a
throwaway `CODEX_HOME` at a local OpenAI-compatible stub:

```toml
# $CODEX_HOME/config.toml
model = "mock-model"
model_provider = "mock"
approval_policy = "never"
sandbox_mode = "danger-full-access"

[model_providers.mock]
name = "Mock"
base_url = "http://127.0.0.1:8099/v1"
wire_api = "responses"
env_key = "MOCK_API_KEY"
requires_openai_auth = false
```

The stub only has to stream a short assistant message over SSE (`response.created`,
`response.output_text.delta`, `response.completed`) -- and, for `--cancel-prompt`, drip that
message out slowly so `session/cancel` lands mid-turn. Pass the `CODEX_HOME` and API-key
variables through with `--agent-env`.

`--auth-method` is only needed when the adapter is not already authenticated; without it the
session-dependent tests report `SKIPPED (AUTH-GATED)` and the run cannot be scored.

## What the TCK found, and what was done

### Fixed: session methods failed on a session that had never been prompted

`ACP-DELETE-001` (CAPABILITY), `ACP-RESUME-001` (CAPABILITY), `ACP-LOAD-003` (ADVISORY)

Codex materializes a thread's rollout file lazily, on the thread's first user message.
`thread/resume` and `thread/archive` both read that file, so `session/new` immediately
followed by `session/resume`, `session/load`, or `session/delete` failed with
`-32603 Internal error / "no rollout found for thread id <uuid>"`.

The thread is still live in the app-server in that window, and `thread/read` answers for it:

- `CodexAcpClient.resumeThread` falls back to `thread/read` when `thread/resume` reports a
  missing rollout, and reports the session with empty history (`thread/turns/list` rejects an
  unmaterialized thread outright, and there is nothing to hydrate anyway). A thread id Codex
  has genuinely never seen fails both calls and still surfaces the original error.
- `CodexAcpClient.deleteSession` treats "no persisted thread under this id" as success --
  deleting is idempotent, and an unmaterialized thread has nothing left to archive.

### Fixed: `session/delete` rejected an unknown session id

`ACP-DELETE-002` (ADVISORY)

ACP session ids are opaque strings; Codex thread ids are UUIDs. `session/delete` on an id
Codex could not parse answered `-32603 … "invalid session id: invalid character…"`, where the
spec's SHOULD is that deleting an unknown or already-deleted session succeeds silently. The
same `deleteSession` change covers this: an unparseable id, an unknown id, and an
already-deleted id all resolve with `{}`. Any other archive failure is still reported.

### Fixed: a `session/update` could arrive after the `session/load` response

`ACP-LOAD-002` (CAPABILITY)

Title generation is fire-and-forget after a turn completes; it renames the thread, and Codex
echoes that back as a `session_info_update`. A generation still running when `session/load`
was served produced a notification *after* the load response, which contradicts "the replay
is complete when load returns".

`TitleGenerator.waitForIdle` exposes the in-flight generation, and `session/load` awaits the
generation belonging to the session state it is replacing (bounded at 10 s) before answering.

### Fixed: a `session/cancel` racing turn registration was dropped

`ACP-CANCEL-001`, `ACP-CANCEL-002` (both MANDATORY)

Not in the original TCK report -- it only reproduces when the first token arrives fast enough
for the client to cancel within milliseconds. `turn/interrupt` then fails with "no active turn
to interrupt", the adapter logged the error and did nothing else, and the turn ran to
completion and answered `stopReason: "end_turn"` -- which ACP forbids after a `session/cancel`.

`requestTurnInterrupt` now re-sends the interrupt on that specific error, with a short backoff
(25/50/100/200/400 ms) and only while the prompt is still in flight. Close is not retried: it
tears the session down anyway.

### Not fixed: non-`_meta` root fields on two spec result types

`ACP-SCHEMA-002` (ADVISORY) -- `session/new result: ['models']`, `session/prompt result: ['usage']`

Requirement 41 says custom data belongs under `_meta`. Two root fields are flagged, for
different reasons, and neither is worth the change:

- **`PromptResponse.usage` is not a custom field.** It is declared in the ACP v1 schema the
  adapter builds against (`@agentclientprotocol/sdk`, [`agentclientprotocol/typescript-sdk`],
  `schema/schema.json`), marked `**UNSTABLE**`. The TCK vendors its schema from
  [`zed-industries/agent-client-protocol`] instead, which has not picked the field up, so this
  is drift between two copies of v1 rather than the adapter inventing a field. Moving it would
  put the adapter *out* of step with its own SDK's type.
- **`NewSessionResponse.models` is a deliberate backwards-compatibility field.** It carries the
  pre-`configOptions` model picker (`LegacySessionModelState`, paired with the legacy
  `session/set_model` method) for clients that predate the standard mechanism. Current clients
  do not need it -- model and reasoning effort are already exposed as ordinary
  `configOptions` (`ModelConfigOption.ts`), which the TCK exercises and passes. Removing it
  from the root is the correct end state, but it breaks every client still reading it, so it
  belongs in a deliberate major-version deprecation rather than a conformance fix. Mirroring it
  into `_meta` as well would not clear the finding, since the root key would still be there.

`ACP-SCHEMA-002` is ADVISORY, so neither affects the verdict.

## Skips

- `ACP-AUTH-003` -- no `--auth-method` passed; the `authenticate` handshake is not exercised.
  Re-run with `--auth-method api-key` (plus a key in the environment) to cover it.
- `ACP-AUTH-005` -- not applicable, the adapter advertises `authMethods`.
- `ACP-PROMPTCAP-002` -- `promptCapabilities.audio` is not advertised, correctly skipped.

[`agentclientprotocol/typescript-sdk`]: https://github.com/agentclientprotocol/typescript-sdk
[`zed-industries/agent-client-protocol`]: https://github.com/zed-industries/agent-client-protocol

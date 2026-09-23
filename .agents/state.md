# ACP v2 Migration — Implementation State

> Maintained by the orchestrator only (see `.agents/prompt.md`). Updated immediately after each
> slice/milestone completes. This file, plus `plan.md`/`architecture.md`/`research/*.md`, must be
> enough to resume this work from a fresh orchestrator run with no other context.

## Current position in the sequencing plan

Phase: **Phase 2 — in progress.** Prerequisite and Phase 1 (topic 1) done; topics 9 and 7 done
(2026-09-24).

### Resume here (for a fresh orchestrator)

State as of the graceful flush (2026-09-24): **no agents in flight; all source work is committed**
(latest slice commits 9d22983, d4b64f3). Uncommitted, on disk only: `.agents/state.md`,
`.agents/prompt.md` (the TCK `-k` note), and 6 new research files under `.agents/research/`. The
user's `.agents/agents/*.md` edits were committed by the user in b2678b1, so there's no pre-staged
index content to avoid anymore (keep committing with explicit pathspecs anyway).

Done: prerequisite (SDK `~1.5.0`), topic 1 (1a, 1b; 1c dropped), topic 9 (9a, 9b), topic 7,
topic 5a. The v2 chain currently registers: `initialize`, `session/new|list|close|delete|resume`
(no replay), `session/set_config_option`.

**Next steps, in order:**
1. **Before briefing 2(a):** resolve the 6 open questions under "Codex insertion signal" (Open
   questions section). #1-#3 are product calls: ask the user. #4-#6 can go to a researcher or be
   answered by the 2(a) programmer's investigation if they're mechanical. Recommend asking the user
   #1-#3 in one `AskUserQuestion` batch.
2. **Topic 2(a)** (`session/prompt` on v2, idle case only): mint the `messageId` UUID → pass as
   `clientUserMessageId`; resolve the RPC with `{messageId}` + live `user_message` at the matching
   `userMessage` `item/started|completed` (not at `onTurnStarted`); keep turn execution in the
   background. Precedent: `startNewTurnFromExternalPrompt`. Include locally handled slash commands
   (adapter-inserted live-only `user_message`). Overlapping prompts can be rejected temporarily until
   2(c). Sources: `v2-prompt-lifecycle-and-turn-state-machine.md` (minus §7.4 option 1),
   `v2-queued-prompt-contract.md`, `v2-codex-prompt-insertion-signal.md`.
   - Can run in parallel as the next programmer slice if 2(a) is blocked on user answers:
     **topic 8** (auth: register `auth/login`/`auth/logout` on v2; `getCodexAuthMethodsV2`
     already exists from 1a) — tiny and unblocked.
3. Then 2(b) (`state_update` running/idle), 6(a) (message chunk `messageId` + `tool_call` re-tag,
   incl. MCP-startup `tool_call`s; add the "no unknown unprefixed sessionUpdate on v2" test
   guard), 5b, 10, 2(c) (queue), 3, 4 (incl. v2 `request_permission` + `elicitation/create` send
   paths), 6(b), 6(c). Phase 4: full TCK v1 + v2 from one process.
4. Run a **full** v1 TCK at the end of each topic (last full v1 run: slice 1a).


Topic 1 slice plan:
- **1a** — **Done (852f102, 6f2e88e).** Router + v2 chain (`initialize` only) + `initializeV2` +
  `getCodexAuthMethodsV2` + client-probe normalization. What landed:
  - `src/AcpAgentRouter.ts` (new): the v1 chain + zod parsers moved here verbatim from `index.ts`;
    `createAcpAgentRouter(createAgent)` returns `agentProtocolRouter().withV1(v1).withV2(v2)`.
    The v2 chain registers only `acpV2.methods.agent.initialize` → `initializeV2`.
  - `src/ACPSessionConnection.ts`: `AcpV2ClientConnection` type + `AcpV2Connection` wrapper class.
    `CodexAcpServer`'s constructor accepts `AcpClientConnection | AcpV2Connection` (detected via
    `instanceof`), sets `protocolVersion: 1|2` and private `v2Connection` (null on v1). On v2,
    `this.connection` = `extensionOnlyV1View()`: forwards only `_`-prefixed extension methods and
    rejects standard methods (e.g. `session/update`) with an internal error, so it fails loudly
    instead of sending v1 shapes. **1b must replace this for standard methods.**
  - `initializeExtensionsMeta()`: shared top-level `_meta` builder for both paths (v1 byte-identical).
  - `src/AcpV2ClientCapabilities.ts` `toV1ClientCapabilitiesView()`: the single normalization point;
    v2 caps → v1-shaped `this.clientCapabilities` (elicitation copied, `auth._meta` copied,
    `auth.terminal` → `auth.terminal: true`, `_meta` verbatim; `plan`/`session.*`/`subagents` absent).
  - Moot probes on v2: terminal output mode not resolved (constructor defaults stay);
    `booleanConfigOptionsSupported = true`; plan/compaction/notice readers currently return
    false on v2 (fixed in 9b: now true).
  - Tests: `src/__tests__/CodexACPAgent/initialize-v2.test.ts` + 3 file snapshots in `data/`.
  - TCK: v1 full = baseline (CONFORMANT, no regressions). v2 `-k test_initialize`: INIT-001/003/
    201/202/203/204 pass; **ACP-SCHEMA-001 fails** only because `session/new` isn't registered on v2
    yet (expected; clears with topic 5).
- **1b** — **Done (e9e898e, 2d822df).** What landed:
  - `src/AcpV2SessionUpdate.ts` (new): `toV2SessionUpdate(update): acpV2.SessionUpdate`, an
    exhaustive switch — **the single v1→v2 `session/update` fork point**. Later topics replace
    their fail-loud `case` with a real rendering; the return type makes the compiler check it.
    If topic 6's `messageId` minting needs session state, add a context param there (topic 6).
  - `ACPSessionConnection.ts`: `AcpV2Connection.updateSession(sessionId, update)` renders + sends
    via `acpV2.methods.client.session.update`; `extensionOnlyV1View()` now forwards
    `session/update` to it (other standard methods, e.g. `session/request_permission`, still
    rejected → topic 4 must add its v2 path); `AcpV2Connection.of(view)` (module WeakMap)
    lets `ACPSessionConnection` find the v2 handle; it exposes `protocolVersion: 1|2`. No caller
    changes (~25 `new ACPSessionConnection(this.connection, …)` sites).
  - Fail-loud error: `RequestError.internalError("'<variant>' session update is not supported on
    an ACP v2 connection yet")`, thrown before sending.
  - **SDK finding:** v2 `client.notify` does NOT validate/strip outbound params — the explicit
    cases in `toV2SessionUpdate` are the only shape guard.
  - Classification: pass-through = `plan_update`, `plan_removed`, `session_info_update`,
    `usage_update`, `notice`, `compaction_update`, `compaction_summary_chunk`. Fail-loud, owned:
    message chunks (messageId) / `tool_call` (re-tag) / `tool_call_update` (diff + terminal
    content) → topic 6; `plan` → `plan_update`, `current_mode_update` (removed in v2),
    `config_option_update` (`id`→`configId`) → topic 9; `available_commands_update` (v2
    `AvailableCommand.input` is a `{type:"text",…}`-tagged union, v1 untagged) → resolved, rendered
    in 9b; `subagent_spawned`/`subagent_state_update`/`async_task_*` → resolved (see Open
    questions), owned by topic 10.
  - Tests: `src/__tests__/CodexACPAgent/session-update-v2.test.ts` + 2 snapshots. TCK v1 targeted
    (`-k "test_prompt or test_session or test_cancel"`): 26 pass / 3 known skips, matches 1a.
  - `CodexAcpServer`'s private `v2Connection` field is still unused apart from being assigned.
- **1c** — **Dropped** (see Deviations).

**Topic 1 done.** Phase 2 order (one programmer at a time; researchers in parallel):
9a (config options) → 9b (plans) → 7 (MCP converter; needed before v2 `session/new` takes MCP
servers) → 5 (session lifecycle; makes the v2 TCK runnable end-to-end) → 2(a) (prompt response) →
8 (auth) → 10 (unstable/extension methods). Then Phase 3: 2(b), 2(c), 3, 4, 6.

- **9a** — **Done (072bc0c, db903cb).** What landed:
  - `src/AcpV2ConfigOptions.ts` (new) mapping shim; the builders stay v1-typed as the single
    source of truth. `toV2ConfigOption(s)`: `id`→`configId`, plus select-group `group`→`groupId`
    (SDK 1.5.0 types require it; research missed it). `toV1SetSessionConfigOptionRequest`: v2
    `{type:"id"}`→`{value}`, `{type:"boolean"}`→`{type:"boolean", value}`, else `invalidParams`.
  - `CodexAcpServer.setSessionConfigOptionV2` delegates to v1 `setSessionConfigOption`; registered
    on v2 in `AcpAgentRouter.ts` (comment explains why `session/set_mode` isn't).
  - **Topic 5 helper:** private `createSessionConfigOptionsResponseV2(sessionState)` → `{configOptions?}`
    (keeps `isSessionConfigEnabled()` gating; no `configOptions` for JetBrains 2026.1). Use
    `...this.createSessionConfigOptionsResponseV2(this.getSessionState(sessionId))`; no `modes`.
  - `toV2SessionUpdate`: `config_option_update` rendered; `current_mode_update` has its own
    rejecting case ("does not exist in ACP v2").
  - Fast mode is always boolean on v2. Known leniency: v2 `type:"id"` with `"on"/"off"` for fast mode
    is still accepted (shared `applyFastModeChange`); harmless.
  - Tests: `session-config-options-v2.test.ts` + 3 snapshots. TCK v1 `-k test_session`: 18 pass /
    2 known skips.
- **9b** — **Done (55093c8, 6c7d4c1).** Structured `plan` → `plan_update{type:"items",
  planId: STRUCTURED_PLAN_ID}` (constant `"codex-structured-plan"` exported from
  `AcpV2SessionUpdate.ts`; markdown plans keep the Codex item id as `planId`).
  `toV1ClientCapabilitiesView()` now always returns a view and synthesizes `plan: {}` +
  `session: {compaction: {}, notices: {}}`, so plan/compaction/notice readers are **true on v2**
  (supersedes the 1a note). Markdown plans are sent unconditionally on v2.
  `available_commands_update` rendered per research. Tests: `plans-and-probes-v2.test.ts` + 5
  snapshots. TCK v1 `-k "test_prompt or test_session"`: 24 pass / 3 known skips.
- **Topic 7** — **Done (7f5a814, dc798b0).** New `src/McpServerConfig.ts`: `AcpMcpServer =
  acp.McpServer | acpV2.McpServer`; `normalizeMcpServer()` → discriminated `NormalizedMcpServer`
  (stdio/http, defaults `[]`), `toCodexMcpServerConfig()`, `getMcpServerName()`,
  `WithAcpMcpServers<T>`. `createMcpSeverConfig` removed. `CodexAcpClient.newSession/
  resumeSession/loadSession/forkSession` take `WithAcpMcpServers<acp.XxxRequest>`, so topic 5 passes
  v2 `mcpServers` straight through. `newSession` has `?? []`. sse/acp/unknown types rejected with
  `invalidRequest` (v1 messages byte-identical). Dedup-before-normalize order is unchanged.
  **Still v1-typed:** `CodexAcpServer.tryCreateSession(request: acp.NewSessionRequest | …)`, so
  topic 5 must widen or adapt it. TCK v1 `-k test_session`: 18 pass / 2 known skips.
- **Topic 5a** — **Done (9d22983, d4b64f3).** v2 chain registers `session/new`, `list`, `close`,
  `delete`, `resume` (`AcpAgentRouter.ts`; comment explains why `session/load` isn't registered).
  `CodexAcpServer.newSessionV2` → `{sessionId, ...createSessionConfigOptionsResponseV2}`;
  `resumeSessionV2`: absent/`null` → v1 `resumeSession` path; unknown type → `invalidParams`
  ("Unsupported replayFrom type: <type>"); `"start"` → **temporary** `internalError` ("…not
  supported on an ACP v2 connection yet"). Both rejections happen before any Codex call.
  `getOrCreateSession`/`tryCreateSession`/`newSession`/`resumeSession` widened to
  `WithAcpMcpServers<…>` (type-only). Tests: `session-lifecycle-v2.test.ts` + 9 snapshots.
  TCK: v1 `-k test_session` 18 pass / 2 known skips (no regressions); v2 `-k test_initialize`
  7/7 pass (**ACP-SCHEMA-001 now passes**); v2 `-k test_session` 22 pass / 1 fail / 3 skip, all
  expected: RESUME-202 FAIL (5b + topic 2), RESUME-204 SKIP (topic 2 + 5b), DELETE-202 SKIP (needs
  a prompted session → topic 2), AUTH-205 SKIP (known). RESUME-205 passes only because replay is
  rejected → recheck in 5b.
  **Known v2 gaps it found (routed):**
  1. MCP startup failure/cancel → `publishMcpStartupStatus` sends `tool_call` → fail-loud (caught
     and logged; the v2 client never learns) → **topic 6(a)** must cover it.
  2. MCP OAuth re-auth → `connection.request(elicitation.create)` is rejected by the v2 view →
     **topic 4** (add the v2 `elicitation/create` request path alongside `request_permission`).
  3. Async tasks on resume (`asyncTasks.reconcile()` → `async_task_*`) → fail-loud when AIR
     `asyncTasks` is advertised → **topic 10**.
  Minor: some v2 test doc comments are stale (e.g. `session-config-options-v2.test.ts` says v2
  sessions can't be created). Fix opportunistically in a later slice.
- **Topic 5b** — after topic 6(a) and 2(a): swap the `start` rejection in `resumeSessionV2` for
  `getOrCreateSessionWithHistory` + `streamThreadHistory`; rerun RESUME-202/204/205. Also: `replayFrom: {type:"start"}` history replay; messageId on
  replayed messages = `userMessage.clientId ?? item.id` (see the Codex insertion research; ACP-RESUME-204/205); subagent replay / orphan
  `disconnected` mapping on v2.

## Per-topic status

| # | Topic | Status | Milestone in progress | Next milestone | Notes |
|---|-------|--------|------------------------|-----------------|-------|
| — | SDK dependency bump (prerequisite) | **Done** | — | — | Blocks everything below |
| 1 | Capability negotiation & `initialize` | **Done** | — | — | Foundational; nothing else can be wired end-to-end without this |
| 2 | Prompt lifecycle & turn state machine | Not started | — | Milestone (a): `session/prompt` response redesign | Long pole — start early per plan.md |
| 3 | Cancellation semantics | Not started | — | — | Depends on topic 2's `state_update` fork existing |
| 4 | Permission requests & approvals | Not started | — | — | Depends on topic 2's `state_update` fork existing |
| 5 | Session lifecycle (new/resume/list/close/delete) | In progress | 5a done | 5b after topics 6(a) + 2(a) | Depends on topics 1, 9 |
| 6 | Tool calls, messages & terminal streaming | Not started | — | Milestone (a): tool-call upsert fork at `ACPSessionConnection.update()` | Depends on topic 1 |
| 7 | MCP config & client execution surface removal | **Done** | — | — | Depends on topic 1 |
| 8 | Auth flow rename | Not started | — | — | Depends on topic 1 |
| 9 | Config options, modes & plans | **Done** | — | — | 9a + 9b landed |
| 10 | Unstable/extension methods on v2 (plan gap) | Not started | — | — | Not owned by plan.md topics: register `session/fork` and `providers/{list,set,disable}` via typed `acpV2.methods.agent.*`; `_session/goal`, `_session/async_task/stop` via `onRequest("_…", parser, h)`; outbound `_auth/status_update` via `client.notify`; subagent/async-task renderer cases (see Open questions). `_session/steering` is owned by topic 2(c). Depends on topic 1 |

## Deviations from `architecture.md`

- Topic 2(c) (user decision): overlapping v2 prompts are **queued** as new turns, not steered into
  the live turn. See "User decisions for later topics".

- Slice 1c (re-route the 5 bypass `connection.notify` call sites through `ACPSessionConnection`)
  was **dropped**. Since 1b, `extensionOnlyV1View` routes `session/update` from those sites
  through the same `toV2SessionUpdate` fork, so the fork is already centralized. Rerouting would
  only churn v1 code. The sites emit `tool_call_update` → topic 6 covers them via the renderer.
- The v2 fork point is `toV2SessionUpdate` in `src/AcpV2SessionUpdate.ts` (called from
  `ACPSessionConnection`), rather than logic inside `ACPSessionConnection.update()` itself.

- §3 cites `dual-version-agent.ts:139-141,171-179,251-264` at 1.4.0. At 1.5.0 those are: cancel
  handler 150-152, `cancelV2Turn` 182-190, cancelled catch 255-268; prompt handler 108-149.

## Open questions sent to a researcher subagent

- (2026-09-24) SDK version sanity re-diff: do the v2 types and router API at the latest published
  version match the spec and SDK `origin/main`? → `.agents/research/v2-sdk-version-sanity-check.md`.
  Status: **resolved.** 1.5.0 is the latest version; its v2 types match SDK `origin/main` (69fda37)
  and spec main (c245270, schema v2.0.0-alpha.5). The router and `acpV2.agent` API are as the
  architecture assumes. Implementation notes carried forward:
  - v2 `session/prompt` handler return type is `PromptResponse` (not `| void`) → must return
    `{messageId}`; the same id goes on the `user_message` update (either order vs. the response).
  - `SessionUpdate` gained an unstable `notice` variant → exhaustive switches need an explicit
    no-op case.
  - SDK v2 types come from `schema.unstable.json` (superset of stable): extra `acp` MCP variant,
    `McpCapabilities.acp`, `plan_removed`/`notice`/`compaction_*` updates, `SessionCapabilities.fork`,
    `nes`/`providers`/position encodings.
  - v2 `session/update` params type is `UpdateSessionNotification`; message chunks are `ContentChunk`.
  - Router is exported only from `@agentclientprotocol/sdk/experimental/v2`; the v2 chain needs its
    own `.onConnect` and a v2-typed connection (`ACPSessionConnection.ts:7` is typed against the v1
    `AgentContext`). Send via `ctx.client.notify(acpV2.methods.client.session.update, …)` /
    `ctx.client.request(acpV2.methods.client.session.requestPermission, …, {cancellationSignal})`.
    Reference: SDK `src/examples/dual-version-agent.ts:54-158` @1.5.0.
  - Deferred: the next SDK release adds a 32 MiB inbound message limit (`MessageTooLargeError`);
    revisit when we bump past 1.5.0.
  - User decision (2026-09-24): pin `~1.5.0` (latest 1.5.x patches, no minor bumps). Landed in
    3dde664. Note: HEAD already had `^1.5.0` in the lockfile since #531; only the local
    `node_modules` was stale at 1.4.0.
- (2026-09-24) Topic 1 placement of non-standard/unstable capabilities and extension probes on v2
  (fork, subagents, providers, auth logout/status meta, mcp acp/sse, client `_meta` probes), plus
  which non-baseline methods can be registered on a v2 chain →
  `.agents/research/v2-extension-capabilities-placement.md`. Status: **research done** — see the
  decision table at the end of that file. Key finding: the v2 SDK zod-parses both the inbound
  `initialize` request and our outbound response, silently stripping keys outside the (unstable)
  v2 schema; only `_meta` survives at every level. Spec-mandated rows are accepted as-is.
  Judgment-call rows are **approved by the user (2026-09-24)**, all as recommended:
  - agent-side `subagents` capability: dropped on v2 (AIR `nativeSubagentSessions` covers it);
  - `authStatus` marker → `capabilities.auth._meta.authStatus`;
  - steering/goal/`jetbrains.air` stay in top-level `InitializeResponse._meta` (same as v1);
  - client extension probes → same key under the renamed container's `_meta`
    (`capabilities.auth._meta.gateway`, `capabilities._meta.jetbrains.air.*`);
    subagent client probe on v2 = AIR key only;
  - `session/set_model`, `authentication/status|logout`, `session/load`, `session/set_mode` are
    NOT registered on the v2 chain.
- (2026-09-24) v2 emission of subagent/custom session updates →
  `.agents/research/v2-subagent-and-custom-session-updates.md`. Status: **resolved; user approved
  the recommendations (2026-09-24)**:
  - `subagent_spawned` → `_subagent_update` with RFD payload `{subagentSessionId, name, task,
    capabilities: {}}` (omit `state`, no `null`s); `subagent_state_update` → `_subagent_update`
    `{subagentSessionId, state}`. Gate on AIR `nativeSubagentSessions` only (stricter than the
    RFD's "assumed" rule on purpose; don't "fix" it). Rename to `subagent_update` when RFD PR #1992
    lands in spec `main`'s v2 unstable schema.
  - `async_task_spawned`/`async_task_state_update` → `_async_task_spawned`/`_async_task_state_update`,
    payloads unchanged, gated on AIR `asyncTasks`.
  - Owner: topic 10 (implemented as renderer cases in `toV2SessionUpdate`). AIR must adopt these
    names; that's a contract change outside this repo.
  - Open, owned by topic 5: how subagent replay / orphan `disconnected` synthesis
    (`CodexAcpServer.ts:2140-2233`) maps onto v2 `session/resume` + `replayFrom`.
  - Suggested test guard (from the report): a Vitest check that fails on any unknown unprefixed
    `sessionUpdate` tag in v2 frames. Add it in topic 6.
- (2026-09-24) `available_commands_update` v2 shape (1b escalation) →
  `.agents/research/v2-available-commands-update.md`. Status: **resolved**. The only difference is
  `AvailableCommand.input`: v2 needs `{...input, type: "text"}` for non-null input; `null` stays
  `null`, absent stays absent; everything else is unchanged. Test must assert `input.type === "text"`
  arrives, because the v2 client zod silently drops an untagged `input`. **Folded into slice 9b**
  (renderer case). Slash-command invocation parsing (`parseCommand`) is unchanged on v2.
  Handed to topic 2(a): locally handled slash commands still need the v2 insertion contract
  (`messageId` response + live `user_message`, `slash-commands.mdx:102-104`); whether
  `tryHandleCommand` takes v1 or v2 `ContentBlock`s. Handed to topic 6: `/status`, `/skills`,
  `/mcp`, `/logout` replies are `agent_message_chunk`s (need `messageId`).

## User decisions for later topics (2026-09-24)

- **Topic 2(c):** v2 `session/prompt` arriving while a turn is running is **queued**: accept it
  and run it as a new turn after the current one finishes. **Not** steering/injection into the live
  turn; steering stays a separate mechanism (`_session/steering`, unchanged). This replaces
  architecture §2's "route through `getSteerableTurnId` + `SteeringQueue`" design. Before
  implementing, a researcher must pin down the v2 insertion contract for a queued prompt: when the
  `{messageId}` response and the live `user_message` are sent, and what `state_update` sequence a
  queued prompt produces. **Research done** → `.agents/research/v2-queued-prompt-contract.md`.
  Spec-mandated (MUST): the `{messageId}` response means *inserted*, so for a queued prompt the
  request **stays pending until its turn starts**; do NOT resolve on receipt/queueing. This
  **invalidates** `v2-prompt-lifecycle-and-turn-state-machine.md` §7.4 option 1. At insertion:
  response + live `user_message` (same `messageId`, either order), then `running`. The report's
  recommended judgment calls, **all approved by the user (2026-09-24)**:
  - between turns: `idle`+stopReason(A) → insert B → `running` → `idle`+stopReason(B);
  - `session/cancel` drops all queued not-yet-inserted prompts (each gets JSON-RPC `-32800`, no
    `user_message`/`state_update`); one `idle`/`cancelled` for the running turn; `$/cancel_request`
    for a queued prompt drops only it; `session/close` acts like cancel;
  - local slash commands: live-only `user_message` at insertion, `running` → output →
    `idle`/`end_turn` (the SDK `readText()` and the TCK driver wait for `idle`); queued FIFO behind a
    running turn like any prompt;
  - FIFO, no queue limit.
  Notes: always include `stopReason` (the docs say MUST, the schema SHOULD); STATE-201/202/203 need
  a `running` before any `idle`+stopReason; the SDK reference agent rejects overlaps with
  `-32600` (also legal).
- (2026-09-24) Codex insertion signal + `messageId` source →
  `.agents/research/v2-codex-prompt-insertion-signal.md`. Status: **research done** (Codex
  `rust-v0.156.1` @ `81e8e29`, verified live). **Changes 2(a)'s design vs. architecture §2:**
  - **Insertion = the first `item/started`/`item/completed` for a `userMessage` item whose
    `item.clientId` equals a codex-acp-minted id.** Neither the `turn/start` response (where
    `onTurnStarted` fires today, `CodexAppServerClient.ts:302-303`) nor `turn/started` proves
    insertion. Both precede pre-turn compaction, MCP startup, hooks and `UserPromptSubmit`, and a
    blocking hook can yield no userMessage at all.
  - **`messageId` = a codex-acp-minted UUID** passed as `TurnStartParams.clientUserMessageId` (and
    `TurnSteerParams.clientUserMessageId`). Replay uses `userMessage.clientId ?? item.id`, which
    survives `thread/turns/list`, `thread/read` and reloads. The Codex item id is unstable (older
    rollouts renumber it `item-N`). Nothing in `src/` sets `clientUserMessageId` yet.
    `createUserMessageUpdates` uses `item.id`; `ResponseItemHistoryFallback` sends user chunks
    with no `messageId` and finds no user messages in 0.156.1 rollouts.
  - Edge cases: `/compact` and `/goal` turns emit **no** userMessage; `/review` emits one with
    `clientId: null` and `review/start` takes no `clientUserMessageId`. All three need an
    adapter-inserted live-only `user_message`. A failure after start still emits the userMessage
    first (it counts as inserted). A `turn/start` rejection returns a JSON-RPC error before
    insertion.
  - **Queue invariant:** `turn/start` on a busy thread silently *steers* into the running turn, so
    2(c)'s queue must not call `turn/start` for B until A's `turn/completed`.
  - `turn/steer` returns immediately, but the message lands only at the next model call; if the
    turn is interrupted first, the steered input is dropped silently (relevant to `_session/steering`).
  - **Open questions: decide (with the user where it's a product call) before briefing 2(a):**
    1. A turn starts but never inserts (blocking hook, early error): fail the prompt with an
       error, or insert an adapter-owned `user_message`?
    2. What replay shows for command prompts (`/review`, `/compact`, `/goal`) that Codex history
       doesn't record verbatim.
    3. Show the plan-implementation 2nd-turn and goal-continuation prompts as `user_message`?
    4. Is `ResponseItemHistoryFallback` still needed for user messages (it finds none in 0.156.1)?
    5. `/review`: `turn/started` carries the child turn's id; check the effect on
       `currentTurnId` and active-turn-completion detection.
    6. Should `_session/steering` also pass `clientUserMessageId`?
- **Slice 9b:** narrative markdown plans are sent as `plan_update{type:"markdown"}`
  **unconditionally** on v2 (no agent-message fallback).
- **Topic 6(c):** for file add/delete, **synthesize** a git-style add/delete `patch` from the raw
  content (don't omit `patch`).
- **Topic 5:** `session/resume` with an unknown `replayFrom.type` → **reject** with invalid params.

## Orchestration conventions

- Programmers commit with explicit pathspecs. The user has pre-existing staged edits to
  `.agents/agents/*.md` that must not be swept into slice commits.
- TCK: `-k` matches test module/function names (e.g. `-k test_initialize`), NOT requirement IDs;
  scoped runs always report NOT CONFORMANT/exit 1, so read the targeted rows. Prompt tests use
  real model tokens; a full v1 run is ~212 s. v1 baseline: CONFORMANT, 50 pass / 1 fail
  (ACP-SCHEMA-002, pre-existing advisory: root-level `models` on `session/new`, `usage` on
  `session/prompt`) / 5 skip; ACP-CLOSE-002 flips between SKIPPED and PASS.
- `bun` isn't installed locally; `bundle:all` needs a shim (see `.agents/tck/HOW-TO-RUN.md` or the
  prerequisite commit notes: `/tmp/bunshim/bun` → `npx -y bun@1.3.11`).
- TCK artifacts live under `.agents/tck/` (run instructions in `HOW-TO-RUN.md`). Per-slice
  verification uses targeted `-k` runs covering only the touched protocol parts; the full suite is
  for baselines, end-of-topic checks, and Phase 4 (see `prompt.md`).

## Shared prerequisites not owned by a single topic

- Version-aware `ACPSessionConnection` → **done in 1b** (`toV2SessionUpdate` fork point).
- The 5 bypass call sites (`CodexElicitationHandler.ts:221,228,556`, `CodexAcpServer.ts:2538,3312`)
  → not rerouted (1c dropped); they already reach the v2 renderer via `extensionOnlyV1View`.
- Still open: v2 `session/request_permission` send path. `extensionOnlyV1View` rejects it today;
  topic 4 must add it (the v2 `ctx.client.request(acpV2.methods.client.session.requestPermission,
  …, {cancellationSignal})`, via the `AcpV2Connection` handle).

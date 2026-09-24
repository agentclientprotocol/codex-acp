# ACP v2 Migration — Implementation State

> Maintained by the orchestrator only (see `.agents/prompt.md`). Updated immediately after each
> slice/milestone completes. This file, plus `plan.md`/`architecture.md`/`research/*.md`, must be
> enough to resume this work from a fresh orchestrator run with no other context.

## Current position in the sequencing plan

Phase: **Phase 2 — in progress.** Prerequisite and Phase 1 (topic 1) done; topics 9 and 7 done
(2026-09-24).

### Resume here (for a fresh orchestrator)

State as of the flush for a fresh orchestrator restart (2026-09-24): **no agents in flight; everything
is committed** in codex-acp (branch `eugenethedev/acp-v2`) and in the acp-tck fork (`main`, 4 local
commits, **not pushed** — the user said don't push). Keep committing with explicit pathspecs.

Done: prerequisite (SDK `~1.5.0`); topic 1 (1a, 1b; 1c dropped); topics 6, 7, 8, 9; topic 5a;
topic 2 slices 2(a1), 2(r), 2(b), 2(e), 2(h). The v2 chain registers: `initialize`,
`session/new|list|close|delete|resume` (no replay), `session/set_config_option`, `auth/login`,
`auth/logout`, `session/prompt`.

**acp-tck fork fixes (user-requested, done, `/Users/eugene/Documents/JetBrains/projects/acp-tck`):**
`1997552`, `473a1b5` (quiet-period checks only fail on replies), `b7cb958`, `e644ee7`
(reply-waiting checks skip agent-initiated lines). See "Open questions" TCK-U1 and
`.agents/tck/tck-fix-quiet-period.md`. With the fixed TCK, v2 BATCH-202, JSONRPC-003, EXT-201 pass;
v1 full is still 50/1/5 CONFORMANT. The expected v2 full-run fails are now: cancel rows (topic 3),
RESUME-202 (5b), EXT-202 (`capabilities.providers` placement; topic 1/10), and JSONRPC-001 +
BATCH-204/205 (omitted `params`, fixed by 2(u2)).

**Next steps, in order (one programmer at a time; researchers may run in parallel):**
1. **2(u2)** — **Done (9ff318c).** `withOmittedParamsWorkaround(agent)` in `src/AcpAgentRouter.ts`,
   passed only to `.withV2(...)`: a `TransformStream` on the inbound stream adds `params: {}` to
   `session/list`/`auth/logout` items (batch entries too) with no own `params` key; `null` and other
   methods untouched. Tests `omitted-params-v2.test.ts` (6, raw ndjson stream; pins v2 `null` →
   -32602, v2 `session/new` no params → -32602, v1 no params → -32602) + 2 snapshots. Suite
   850 / 26. TCK v2 `-k "test_batch or test_jsonrpc"`: JSONRPC-001, BATCH-204/205 now PASS (M 5/0,
   A 5/0, I 2/0/3 skip); v1 same `-k`: no fails (baseline).
2. **2(a2)** — split into milestones: **2(a2-i)** `/compact` + `/goal` command turns — **Done (427cdf8)**: `promptV2` rejects only
   `/review*` now; insertion = successful `thread/compact/start` / `thread/goal/set` response (research
   summary table) via new `onCommandAccepted` in `CommandHandleOptions` → `resolvePendingInsertion()`
   in `prompt()` (only when `insertion` is given; v1 call shapes unchanged); `runCompact`/`runGoalSet`
   gained `onAccepted`. 5 new tests in `prompt-v2.test.ts` + 6 snapshots. Suite 855 / 26. TCK v1/v2
   `-k test_prompt` baseline. Note for 2(a2-iii): `/goal resume` falling back to
   `GOAL_CONTINUATION_PROMPT` reuses the already-resolved insertion (no new minted id; untested) —
   that continuation needs its own minted `clientUserMessageId` + live `user_message`; **2(a2-ii)**
   `/review` — **Done (f4d1020)**: `runReview` gained `onAccepted` (fired on the `review/start`
   response, before `onTurnStarted`), wired via `onCommandAccepted`; `promptV2` no longer rejects any
   command. Reviewer message suppression needed no code: `CodexEventHandler` returns `null` for live
   `userMessage` items on both versions. 2(r)/2(h) machinery reused unchanged. 4 tests + 4 snapshots
   (old `prompt-v2-codex-turn-commands.json` removed). Suite 858 / 26. TCK v1 `-k "test_prompt or
   test_cancel"` 8/1, v2 `-k test_prompt` 9/1 (baseline). No live probe; **2(a2-iii)** synthetic prompts — **Done (2b12a51)**: `UserMessageInsertion.onSyntheticInserted`;
   `prompt()` has `pendingSyntheticInsertions` + `registerSyntheticInsertion()` (only when `insertion`
   is given → v2 only; v1 `turn/start` still has no `clientUserMessageId`). Minted ids on the
   plan-implementation follow-up turn and the `/goal` → `GOAL_CONTINUATION_PROMPT` fallback; live
   `user_message_chunk` on the matching userMessage item, inside the original running…idle pair.
   Harness gained `PromptSession.request(method, params)`. 2 tests + 2 snapshots; no v1 snapshot
   diffs. Suite 860 / 26. TCK v1/v2 `-k test_prompt` baseline. **Not covered (→ research TCK-Q3):**
   `startGoalContinuationIfCurrent` → `startNewTurnFromExternalPrompt` (`_goal/control`; also used by
   steering) can start a turn with no v2 `session/prompt` in flight → no minted id, no user message,
   no states;
   **2(a2-iv)** fallback title — **Done (335e2c1)**: `publishFallbackSessionTitle` in `prompt()`'s
   success path gated on `pendingInsertion === undefined` (always true on v1). Existing negative
   tests in `prompt-v2.test.ts` assert no `session_info_update`; `prompt-v2-not-inserted.json` lost
   its leaked title. Suite 860 / 26. TCK v1 `-k "test_prompt or test_session"` 24/0/3; v2 31/1
   (RESUME-202, expected)/4. Follow-up (not scheduled, minor): a non-inserted turn that completes
   still calls `titleGen.onTurnCompleted`, latching `generated = true` → may suppress the AI title for
   a later prompt; **2(a2-v)** overlap check + v2 rendering for
   `startNewTurnFromExternalPrompt` turns — blocked on research Q3. — Codex command turns (`/review`, `/compact`, `/goal`) and synthetic prompts
   (plan-implementation, goal continuation) on v2. Use the two-id tracking from 2(r), with no clientId matcher
   for reviews. On `review/start` success, send the response + live-only `user_message`, then
   `running`, then exactly one `idle`. Synthetic prompts get a minted `clientUserMessageId`. Also:
   fix the overlap check that misses goal-continuation/steering turns started via
   `startNewTurnFromExternalPrompt`, and fix the fallback title published for non-inserted prompts.
   Research: `v2-codex-insertion-followups.md`, `v2-review-cancel-window.md`; user decisions in
   "User decisions for later topics". It may need splitting into milestones.
3. **2(c)** — queue overlapping v2 prompts FIFO (`v2-queued-prompt-contract.md`).
   `_session/steering` passes a minted `clientUserMessageId` and emits `user_message` on landing.
4. **Topic 3** — cancellation:
   - `ctx.signal` / `$/cancel_request` and v2 `session/cancel`;
   - v1 cancel-retry option B (recompute the id per attempt; retry "expected active turn id P but
     found Y" with Y);
   - retry `Close`-named interrupts (`interruptLateStartedTurn`, `interruptSessionTurn(…,"Close")`).
5. **Topic 4** — permissions / `requires_action`: v2 `request_permission` and `elicitation/create`
   send paths (MCP OAuth, device-code login), plus a v2 device-code test.
6. **Topic 5b** — resume replay `replayFrom:start`:
   - replayed ids come from `clientId ?? item.id`;
   - the fallback's user chunks are never emitted;
   - deterministic ids for fallback agent chunks and review-mode history;
   - hide the reviewer prompt;
   - replay of interrupted reviews;
   - subagent replay.
7. **Topic 10** — unstable/extension methods (`session/fork`, providers, `_session/goal`,
   `_session/async_task/stop`; `_auth/status_update` push stays as is — user kept it and fixed the
   TCK instead) plus the subagent/async-task renderer cases.
8. **Phase 4** — full TCK v1 + v2 from one process. Document the AIR v2 contract in `readme-dev.md`
   and the docs: `sessionFailure` and quota on idle `_meta`, the subagent and async renames.
   Opportunistically fix stale v2 test doc comments.
- Run a **full** v1 + v2 TCK at the end of each topic, and targeted `-k` runs per slice. `-k`
  matches module or function names, not requirement IDs. How to run: `.agents/tck/HOW-TO-RUN.md`.
  `bundle:all` needs `PATH=/tmp/bunshim:$PATH`.

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
- **Topic 2(a1)** — **Done (99f13e7, 0e38d35).** v2 `session/prompt` → `CodexAcpServer.promptV2`:
  `toV1PromptRequest` (non-v1 content → -32602) → unknown session (v1 error) → closing (-32600) →
  overlap (-32600 "Session X is already processing a prompt"; checks new `v2PromptsInFlight` set,
  `activePrompts`, `pendingTurnStarts`) → Codex-turn commands (`/compact`, `/review*` w/ arg,
  `/goal <obj>|resume`) → temporary -32603 → mint `messageId`, call v1 `prompt()` un-awaited.
  `prompt()` gained optional 4th param `insertion?: UserMessageInsertion`
  (`{clientUserMessageId, onInserted}`); the session-event callback checks
  `isInsertedUserMessage` before the event handler; `sendPrompt` gained a trailing
  `clientUserMessageId` param (omitted when undefined → v1 `turn/start` unchanged). No insertion
  by end → -32603 "The prompt ended before Codex recorded the user message"; throw before
  insertion → v1 error mapping. New `src/AcpV2Prompt.ts` (`UserMessageInsertion`,
  `isInsertedUserMessage`, `toV1PromptRequest`). `CodexCommands.classifyPrompt()` mirrors
  `tryHandleCommand`'s switch (comment-only sync guard) → `localCommand` (insert + resolve before
  running) / `codexTurnCommand` / regular. Fail-loud renders during a v2 turn are caught/logged by
  `CodexAcpClient.enqueueSessionNotification`; they don't wedge the turn (tested).
  Tests: `prompt-v2.test.ts` (10) + 10 snapshots. TCK v1 `-k test_prompt` 6 pass / 1 skip
  (baseline); v2 `-k test_prompt` 9 fail / 1 skip, all timing out waiting for idle `state_update`
  (→ 2(b)); transcripts show `{messageId}` ~0.4 s after the request, matching chunks.
  Leftovers routed: `ctx.signal` / `$/cancel_request` before insertion + v2 `session/cancel` →
  topic 3; overlap check misses goal-continuation/steering turns started via
  `startNewTurnFromExternalPrompt` → 2(a2)/2(c); non-inserted prompts still publish the
  fallback session title from prompt text (minor; revisit in 2(a2)). Note for 6(a): v1
  `createTextEvent` agent chunks already carry `messageId: itemId`.
- **Topic 2(h)** — **Done (76ad33e, bafd17a).** All in `src/CodexAppServerClient.ts`:
  `runReview` tracks turn ids with an `enteredReviewMode` item; an `error{willRetry:false}` for P
  before that ends the wait with a synthesized `turn/completed{P, failed, error}` → existing failed
  `/review` path (agent text + `end_turn`; typed clients `sessionFailure`). `dropLeakedReviewError`:
  Codex 0.156.1 reports the *next* turn's `turn/completed` as `failed` with the stale error and no
  `error` notification (one turn only) → rewritten to `completed` when message + `codexErrorInfo`
  match and no fatal error came for that turn. Heuristic; shared, so v2 inherits it. Tests
  `review-turn-ids.test.ts` 12 (+5 snapshots). Suite 844 / 26. TCK v1 `-k "test_prompt or
  test_cancel"` 8/0/1 (baseline); v2 12 pass, cancel rows fail (topic 3), CANCEL-202 skip→fail and
  INFO-CANCEL-202 fail→pass are timing-only.
- **Topic 6(d)** — **Done (5aa5f0e, 3c4ffde).** `toV2TerminalUpdates` sets
  `terminalUpdate.command = stripShellPrefix(command)`; `terminal-v2.test.ts` + 1 snapshot line.
  Suite 840 / 26. **End-of-topic-6 full TCK** (`.agents/tck/6-full-v1-v2.md`, raw
  `/tmp/acp-tck-reports/6d-v{1,2}.*`): v1 CONFORMANT 50/1/5 (= baseline; SCHEMA-002 advisory;
  CLOSE-002 skipped). v2 NOT CONFORMANT, 103 tests 72 pass / 11 fail / 20 skip (997 s).
  Expected fails: CANCEL-201/203/204/205/206/207 + INFO-CANCEL-202 → topic 3; RESUME-202 (-32603
  replay not supported) → 5b; EXT-202 (advisory, `capabilities.providers` unknown root key in the
  TCK's stable schema — topic 1 placement choice; also advertised before topic 10 registers the
  methods). **Unexpected (→ research TCK-U1/U2):** **U1** `initializeV2` always pushes
  `_auth/status_update` right after the `initialize` response (`publishFirstAuthStatusAfterResponse`)
  → BATCH-202, JSONRPC-003 (mandatory), EXT-201 read it as a reply to a notification. **U2**
  `{"method":"session/list"}` with no `params` → -32602 "expected object, received undefined" →
  JSONRPC-001 (mandatory), BATCH-204/205. Skips: run-config (AUTH-203/204), n/a (AUTH-205/207,
  PROMPTCAP-002, BATCH-206/207/208), topic 3 (CANCEL-202), TCK prompt has no tool/plan/terminal
  (ENUM-201, PATCH-204..208), topic 4 (ENUM-203, PATCH-209, PERM-201), 5b (RESUME-204),
  DELETE-202 (fresh session without a prompt isn't listed; Codex lists saved threads only; no v1
  counterpart).
- **Topic 6(c)** — **Done (1bcd452, 317786a).** `toV2Diff` in `AcpV2SessionUpdate.ts`: one v2
  `diff` per file, one `changes[]` entry: add → `{operation:"add"}`, delete → `delete`, update →
  `modify`, update+`move_path` → `{operation:"move", oldPath, path}` (edit in the patch). Git-style
  patch generated from v1 `oldText`/`newText` with the existing `diff` dep (`structuredPatch`,
  context 3, `formatPatch`); bare absolute paths (no `a/`/`b/`); add/delete synthesized per user
  decision. Codex's own update diffs lack headers, so regenerated. v1 diff `_meta` (`kind`,
  `jetbrains.air.diffStats`) kept on v2. Move old path: `createFileChangeUpdate(item,
  protocolVersion)` adds private `_meta.diff_old_path` (`DIFF_OLD_PATH_META_KEY`) on v2 only,
  stripped by the renderer; call sites in `CodexEventHandler.ts` (live) and
  `CodexAcpServer.createHistoryUpdates` (replay) pass the version. Fail-loud: unknown/missing
  `kind`, non-string `diff_old_path`. Permission file-change prompts carry no diff content. Pure
  rename without edit dropped on both versions (pre-existing). Tests `diff-v2.test.ts` (6) + 6
  snapshots; guard catches leaked `diff_old_path`/relative paths. Suite 840 / 26. TCK unchanged;
  real-Codex scratch probe clean (move verified by unit tests only).
- **Topic 6(b)** — **Done (2d25cac, e37457a).** Design (a): render in the fork. New
  `toV2SessionUpdates(update): acpV2.SessionUpdate[]` (`AcpV2SessionUpdate.ts`) turns the private
  `_meta` keys on `tool_call`/`tool_call_update` into v2 updates, strips them (other `_meta` kept),
  emits terminal updates first, then the tool call update (dropped if nothing left).
  `AcpV2Connection.updateSession` renders all before sending any. Mapping: `terminal_info` →
  `terminal_update{terminalId, command (rawInput.command if string), cwd (only if absolute; create
  only)}`; `terminal_output`/`_delta` without exit → `terminal_output_chunk{data: base64}`;
  `terminal_exit` → `terminal_update{exitStatus:{exitCode|null, signal:null}}` (+ `output` snapshot if
  output in the same update). Malformed private meta → fail-loud. `terminal` content passes
  through. `initializeV2` fixes `terminalOutputMode="terminal_output_delta"`,
  `terminalOutputDeltaSupported=false` (v1 `_meta` probe ignored on v2);
  `createCommandOutputDeltaEvent` returns `null` on v2 for commands not in `terminalCommandIds`.
  Covers `ResponseItemHistoryFallback` replay too. Guard extended (private terminal keys, relative
  cwd, non-base64 data). Tests `terminal-v2.test.ts` (5) + 4 snapshots; no existing snapshots
  changed. Suite 835 / 26. TCK unchanged (PATCH-206/207 still skip: TCK prompt runs no command);
  scratch client vs real Codex clean; title-less tool call gone.
  **Resolved (`v2-terminal-snapshot-and-command.md`; user decisions 2026-09-24):** keep no
  snapshot after streaming (spec mandates nothing; `output` omitted = unchanged; snapshot would
  replace streamed bytes; Codex caps live deltas at 10,000 frames/command and `aggregatedOutput` is
  a 1 MiB head+tail buffer without the stdin echo — neither source is complete; accepted, same as
  v1; the architecture "always snapshot" line was advice, not spec). `command` →
  `stripShellPrefix(rawInput.command)` (→ slice 6(d)). Noted, not scheduled: mid-command joiners
  never get a snapshot; `stripShellPrefix` ignores PowerShell and leaves quote-escaping residue.
  **Original deviation:** after streamed deltas, completion carries only `exitStatus`, no
  `output` snapshot (v1 parity; avoids duplicate bytes, keeps stdin echo). Contradicts
  architecture/research "always send output at completion". Open Q2: `command` may include a shell
  wrapper (`/bin/zsh -lc '…'`) when Codex reports no command action — `stripShellPrefix`?
- **Topic 2(e)** — **Done (1e20ae9, 7027ed1).** In `promptV2`: every inserted prompt gets
  `running` then exactly one `idle` whether `prompt()` returns or throws. Returned response →
  `toV2IdleState(response)` (`src/AcpV2Prompt.ts`): `stopReason` + v1 `usage` (omitted if null) +
  v1 `_meta` unchanged (`quota`, `jetbrains.air.sessionFailure` for typed clients — usage-limit
  `limit`, `transport_lost` `connection`, `internal_error`). Throw path (untyped clients):
  usage-limit/auth text already sent by `createErrorEvent` is not re-sent (module-level WeakSet,
  `failureWasShownAsMessage()`); process exit → v1's "Codex process has exited with code N[: stderr]"
  as agent text; failing local command → "The '/<name>' command failed: <message>"
  (`PromptKind.localCommand` now carries `name`); other → message or "The prompt failed.". Then
  `idle/end_turn`. **Accepted deviation:** throw-path idle also carries session-state `usage` +
  `_meta.quota` (never `sessionFailure`; one-line revert in `failedPromptResponse`). Tests:
  `prompt-v2.test.ts` 16; harness gained `clientCapabilities`, `exitCode`, `setCodexResponse`.
  Suite 830 / 26 skip. TCK unchanged (v1 prompt baseline; v2 12/9/0). **TODO (Phase 4 docs):**
  document the AIR v2 contract (read `sessionFailure`/`quota` from idle `_meta`; subagent/async
  renames) in `readme-dev.md`/docs. Unverified live: usage-limit/auth errors always arrive after the
  userMessage item.
- **Topic 6(a)** — **Done (893a4a3, 8ee7b42).** All in `toV2SessionUpdate`; no change to
  `ContentChunks.ts` or call sites. Agent/thought chunks keep existing ids (item ids); id-less ones
  (turn error text, config/warning/compaction fallbacks, exited-review text, `/status`, `/skills`,
  `/mcp`, `/logout`, `/goal`, usage errors) get a fresh UUID at render time (each such call site
  sends a whole message as one chunk). User chunks without an id still fail loud. `tool_call` and
  `tool_call_update` → `sessionUpdate:"tool_call_update"`, no field remap (checked vs SDK 1.5.0);
  content items via an exhaustive switch. Still fail-loud: `diff` content (6(c)), `terminal`
  content (6(b)), id-less user chunks, `current_mode_update`, subagent/async-task (topic 10).
  Covers MCP-startup tool calls + the 5 bypass sites. 5b note: `ResponseItemHistoryFallback` agent
  chunks and `createReviewModeUpdate` history chunks would get random ids → 5b must supply
  deterministic ids. Tests: `tool-calls-and-messages-v2.test.ts`; guard
  `src/__tests__/CodexACPAgent/v2-session-update-guard.ts` (unknown unprefixed tags, SDK v2 guard
  failures, empty `messageId`) wired into all `*-v2` tests; `prompt-v2` setup moved into
  `v2-prompt-harness.ts`. Suite 825 pass / 26 skip. TCK v1 `-k test_prompt` baseline; v2
  `-k "test_prompt or test_patches or test_enums"` 12 pass / 9 skip / 0 fail (PROMPT-205 now with
  real chunks; PATCH-204/208 skip — TCK prompt makes no tool call; 206/207 skip — 6(b)).
  Known transient gap (orchestrator decision: leave to 6(b)): generic shell commands' create
  carries terminal content and is dropped, but later content-less updates reach the client → a
  tool call with no `title` (legal v2; would fail advisory PATCH-208).
- **Topic 2(b)** — **Done (9da450e, 7645580)**, one open gap. All states sent from
  `CodexAcpServer.promptV2`; `prompt()` unchanged. `running`: inside `onInserted`, after user chunks
  + `resolve({messageId})` and one `setTimeout(0)` (SDK reference agent does the same), awaited so
  later updates can't overtake. `idle`: once, when the background `prompt()` returns and the prompt
  was inserted; `v2PromptsInFlight` cleared just before it. `idle.stopReason` =
  internal v1 `PromptResponse.stopReason` (end_turn for completion/failed turn/typed failure/local
  commands; cancelled for interrupted/abort/close). v1 `_meta`/`usage` not copied (Q2). Send path:
  new `AcpV2Connection.updateState(sessionId, state)` + `ACPSessionConnection.updateState(state)`
  via the v2 `session/update` handle, bypassing `toV2SessionUpdate` (no v1 form; keeps v1 code
  from sending it); throws on v1; failed sends caught/logged. Pre-insertion failures: JSON-RPC error
  only, no states. No initial `idle` on `session/new`/`resume` (spec has none). Plan-impl 2nd turn
  stays inside the one running…idle pair (its permission → `requires_action`, topic 4).
  **Open gap (Q1):** `prompt()` throwing after insertion (usage-limit/auth for non-typed clients,
  process exit, local command reply that can't render, e.g. `/skills`) → `running` and no `idle`.
  Q2: should idle carry v1 `_meta` (quota, AIR typed terminal failure — v2 typed-failure clients
  currently never see it) and `usage`?
  **Resolved** (`v2-post-insertion-errors-and-idle-meta.md`; user decisions 2026-09-24):
  Q1 → show the error as agent message text, then `idle{stopReason:"end_turn"}` (no `_meta` error,
  no custom stopReason). Spec MUST: `idle` once a new prompt can be accepted (STATE-202); SDK
  example agent's no-idle is non-normative; `notice` is forbidden for fatal errors; `refusal` is
  wrong (Codex keeps the prompt). Usage-limit/auth text exists; Codex exit + local command failure
  need new text. Q2 → **option A**: copy v1 `PromptResponse._meta` (`quota` +
  `jetbrains.air.sessionFailure`, incl. synthetic `transport_lost`/`internal_error`) and `usage`
  (unstable `IdleStateUpdate.usage`) onto the idle unchanged; failure reported once. AIR contract
  change: AIR must read idle `_meta` on v2. Unverified: whether usage-limit/auth errors always
  arrive after the userMessage item. Slice **2(e)** implements both.
  Tests: `prompt-v2.test.ts` now 11; 3 snapshots updated (intended). TCK v1 `-k test_prompt`
  6/1 skip (baseline); **v2 `-k test_prompt` 9 pass / 1 skip** (PROMPTCAP-002 audio).
  PROMPT-205 passes only because unrendered agent chunks are dropped → recheck after 6(a).
- **Topic 2(r)** — **Done (1c46656, 3a1a93a).** Intentional v1 fix. `SessionState.currentTurnId`
  = **completion id** (set from `turn/start`/`review/start` response callbacks; `turn/started`
  sets it only if still `null` — general rule now, no longer overwrites). New
  `SessionState.interruptTurnId` = **interrupt id** (set by every `turn/started`, cleared on
  `turn/completed` and wherever `prompt()` clears `currentTurnId`). Helper
  `codexRunningTurnId(sessionState, turnId)` (`CodexAcpServer.ts`) → `interruptTurnId ?? turnId`
  for the current turn; used by `interruptSessionTurn` (cancel/close),
  `observePromptRequestCancellation` (previously sent P → -32600), `getSteerableTurnId`/steering
  `turnStillActive`. Fixes B1, B2, plus B3 (review retry warning never cleared), B4 (close marked
  child id stale). Pre-`turn/started` window keeps today's behavior (interrupt with P; test-pinned);
  2(a2) reads both ids directly.
  **Cancel-window research (`v2-review-cancel-window.md`, done):** S0 (~1-9 ms after response):
  any id → -32600 "no active turn" (already retried); S1 (~60-70 ms until `turn/started(C)`): **P
  accepted**, review aborted, one `turn/completed{P, interrupted}`, no `turn/started`; S2: P →
  -32600 "expected active turn id P but found C". Child can legitimately never start (resolve
  failure, abort in S1, reviewer sub-session failure) → don't defer until `turn/started`.
  **Recommended option B** (small v1 fix, not yet scheduled): recompute
  `codexRunningTurnId` on every retry attempt, and also retry "expected active turn id <P> but
  found <Y>" with Y when P is the current completion id, the prompt is active and Y is non-empty.
  v2 reuses it unchanged. **User: schedule all three v1 fixes (2026-09-24)**: option B and (2) →
  topic 3; (1) → its own `fix:` slice **2(h)** before 2(a2). Also found (v1): (1) **hang** — `/review-branch` in
  a non-git cwd: Codex sends `error{turnId:P, willRetry:false}` and then nothing; `runReview`
  waits forever and cancel can't help (discriminator: that error before any
  `enteredReviewMode(P)`), plus the stale error leaks into the next turn; (2) `Close`-named
  interrupts (`interruptLateStartedTurn`, `interruptSessionTurn(…,"Close")`) are never retried →
  general S0 race for plain `turn/start` too → **topic 3**; (3) replay of an interrupted review
  (empty interrupted C turn before P) → **5b**.
  Tests: `review-turn-ids.test.ts` (8) + 3 snapshots; no existing snapshots changed. TCK v1
  `-k "test_prompt or test_cancel"` 8 pass / 1 skip (baseline).
- **Topic 8** — **Done (11a1969, 5f9335b).** v2 chain registers `auth/login` →
  `CodexAcpServer.authenticateV2`, `auth/logout` → `logoutV2` (thin delegates; request shapes
  identical). `authentication/status|logout` not on v2 (pinned -32601 by test). Tests:
  `auth-v2.test.ts` + 4 snapshots. TCK `-k test_authentication`: v1 2 pass / 3 skip (baseline);
  v2 AUTH-201/202/206 pass, AUTH-203/204/205/207 skip (no `--auth-method`/`--allow-logout`; 205
  known). Known gap → **topic 4**: `chat-gpt-device-code` login on v2 fails (-32603) because
  `createUrlElicitationRequester` sends `elicitation/create` via the v2 view; add a v2
  device-code test once topic 4's `elicitation/create` send path exists.
- **Topic 5b** — after topic 6(a) and 2(a): swap the `start` rejection in `resumeSessionV2` for
  `getOrCreateSessionWithHistory` + `streamThreadHistory`; rerun RESUME-202/204/205. Also: `replayFrom: {type:"start"}` history replay; messageId on
  replayed messages = `userMessage.clientId ?? item.id` (see the Codex insertion research; ACP-RESUME-204/205); subagent replay / orphan
  `disconnected` mapping on v2.

## Per-topic status

| # | Topic | Status | Milestone in progress | Next milestone | Notes |
|---|-------|--------|------------------------|-----------------|-------|
| — | SDK dependency bump (prerequisite) | **Done** | — | — | Blocks everything below |
| 1 | Capability negotiation & `initialize` | **Done** | — | — | Foundational; nothing else can be wired end-to-end without this |
| 2 | Prompt lifecycle & turn state machine | In progress | 2(a1), 2(r), 2(b), 2(e), 2(h), 2(u2), 2(a2-i..iv) done | 2(a2-v) + 2(c) (blocked on Q3 probe + user J1-J7) | Long pole — start early per plan.md |
| 3 | Cancellation semantics | Not started | — | — | Depends on topic 2's `state_update` fork existing |
| 4 | Permission requests & approvals | Not started | — | — | Depends on topic 2's `state_update` fork existing |
| 5 | Session lifecycle (new/resume/list/close/delete) | In progress | 5a done | 5b after topics 6(a) + 2(a) | Depends on topics 1, 9 |
| 6 | Tool calls, messages & terminal streaming | **Done** | — | — | 6(a)-6(d); end-of-topic full TCK in `.agents/tck/6-full-v1-v2.md` |
| 7 | MCP config & client execution surface removal | **Done** | — | — | Depends on topic 1 |
| 8 | Auth flow rename | **Done** | — | — | 11a1969, 5f9335b |
| 9 | Config options, modes & plans | **Done** | — | — | 9a + 9b landed |
| 10 | Unstable/extension methods on v2 (plan gap) | Not started | — | — | Not owned by plan.md topics: register `session/fork` and `providers/{list,set,disable}` via typed `acpV2.methods.agent.*`; `_session/goal`, `_session/async_task/stop` via `onRequest("_…", parser, h)`; outbound `_auth/status_update` via `client.notify`; subagent/async-task renderer cases (see Open questions). `_session/steering` is owned by topic 2(c). Depends on topic 1 |

## Deviations from `architecture.md`

- Topic 2(c) (user decision): overlapping v2 prompts are **queued** as new turns, not steered into
  the live turn. See "User decisions for later topics".

- Slice 1c (re-route the 5 bypass `connection.notify` call sites through `ACPSessionConnection`)
  was **dropped**. Since 1b, `extensionOnlyV1View` routes `session/update` from those sites
  through the same `toV2SessionUpdate` fork, so the fork is already centralized. Rerouting would
  only churn v1 code. The sites emit `tool_call_update` → topic 6 covers them via the renderer.
- 2(a1): the live user message is sent as one `user_message_chunk` (with `messageId`) per prompt
  block, not a `user_message` upsert. Spec/research allow either (lifecycle research :82); it
  matches the shape 5b replay produces. Trade-off: an empty prompt emits no user message update.
- 2 ordering: 2(r) → 2(b) → 2(a2) (instead of 2(a) → 2(b)), so 2(b) builds on correct turn-end
  detection and unblocks the v2 TCK prompt rows before command turns are added.
- The v2 fork point is `toV2SessionUpdate` in `src/AcpV2SessionUpdate.ts` (called from
  `ACPSessionConnection`), rather than logic inside `ACPSessionConnection.update()` itself.

- §3 cites `dual-version-agent.ts:139-141,171-179,251-264` at 1.4.0. At 1.5.0 those are: cancel
  handler 150-152, `cancelV2Turn` 182-190, cancelled catch 255-268; prompt handler 108-149.

## Open questions sent to a researcher subagent

- (2026-09-24) **Q3** — agent-initiated turns on v2: `startNewTurnFromExternalPrompt` turns
  (`_goal/control` goal continuation via `startGoalContinuationIfCurrent`, steering fallback) can start
  when no v2 `session/prompt` is in flight. What `state_update`/`user_message` sequence does ACP v2
  allow/require for a turn the client didn't request; how should they interact with a v2 prompt that
  arrives meanwhile (overlap check / 2(c) queue)? → `.agents/research/v2-agent-initiated-turns.md`.
  Status: **research done; live probe in flight; user decisions J1-J7 pending.** Findings:
  - Callers: goal continuation (`_session/goal` set/resume when `runGoalSet` returns `null`,
    `CodexAcpServer.ts:586,611`) and steering fallback (`:1717-1734,1793`). The pending request is the
    extension request, not a `session/prompt`. Neither method is on the v2 chain yet (topic 10), so
    these callers are unreachable on v2 today.
  - **New:** Codex 0.156.1's goal extension auto-starts turns (no userMessage) whenever the thread
    idles with an active goal (after every turn end, `thread/goal/set`, `thread/resume`). Reachable
    on v2 now via `/goal`. codex-acp sends no states for them; the overlap check misses them.
  - Spec: `running`…`idle` with no prompt is allowed; required only if the turn counts as
    "foreground" (undefined → our call). `user_message` without a prompt is allowed. SDK: any
    `idle` while a client prompt is pending counts as that prompt's stop (`acp.ts:2845-2851`) → a
    queued B would stop early when an agent turn idles.
  - Overlap gaps: G1 window before `prompt()` registers; G2 goal turn during a pending
    `_session/goal`; G3 Codex self-started turns.
  - Recommendation: every agent-initiated turn → `running` at start + one `idle` at
    `turn/completed`; goal continuation and steering fallback mint `clientUserMessageId` + emit
    `user_message` on landing; Codex self-started turns → no `user_message`; one per-session
    FIFO/reservation for all codex-acp turn starters, taken before the first `await`; "busy" also
    counts Codex-reported running turns. Judgment calls: **J1** foreground (states) · **J2**
    `running` at turn start · **J3** no synthetic `user_message` for Codex self-started turns ·
    **J4** one shared FIFO in arrival order, re-check `canStart` on dequeue · **J5** v2
    session-level turn subscription independent of `prompt()` (sees auto turns, incl. after resume) ·
    **J6** whether v1 also uses the shared reservation (scheduling only) · **J7** mint the
    goal-continuation id on v2 only.
  - **Possible 2(c) blocker:** a queued B's `turn/start` right after `turn/completed` can race
    Codex's auto goal turn and get silently steered into it. → live probe (appending
    "Live verification" to the same file), in flight.
  - Pre-existing (v1 too): codex-acp's own goal continuation may collide with Codex's auto one;
    `prompt()` clearing `currentTurnId` (`:3101`) can hide a running Codex turn from cancel/steering.

- (2026-09-24) **TCK-U1** — v2 `_auth/status_update` pushed right after `initialize` fails
  BATCH-202/JSONRPC-003/EXT-201. Is the push allowed; what exactly do those checks accept; does v1
  push it; options (defer until first session request / accept)? →
  `.agents/research/v2-tck-auth-status-push.md`. Status: **resolved — TCK false positive.**
  BATCH-202/JSONRPC-003 (shared marker, `test_batch.py:66-78`) and EXT-201
  (`test_extensibility.py:117-135`) raw-read 2 s and fail on *any* line; spec + JSON-RPC forbid only
  replies to notifications (TCK's own BATCH-201 and single JSONRPC-003 ignore notifications). v1
  pushes identically (`CodexAcpServer.ts:418`, v2 `:478`); v1 rows pass only because v1 lacks those
  checks. Push is the only v2 identity source (pull not registered), pinned by
  `initialize-v2.test.ts:72-93`. Recommended (c): keep; patch TCK fork to ignore `method` lines;
  alternatives (a) defer to first session open, (a′) push before the first request's response —
  both change the documented contract. **User (2026-09-24): proper fix in the acp-tck fork**
  (`/Users/eugene/Documents/JetBrains/projects/acp-tck`, current branch, no worktree, no push,
  follow its AGENTS.md). **Blocking:** no codex-acp work until the TCK fix is verified and the user
  confirms continuing. **Done part 1:** acp-tck `1997552` + `473a1b5` on `main` (not pushed):
  shared `is_response_line`/`first_response_within` in v1+v2 `conformance/_helpers.py`; only a
  method-less object is a reply; agent requests skipped unanswered; req text of BATCH-202,
  JSONRPC-003, EXT-201 clarified; fixtures `pushes_status_notifications*.py` + cli self-tests.
  codex-acp v2: BATCH-202, JSONRPC-003, EXT-201 now PASS; v1 full 50/1/5 CONFORMANT. Note
  `.agents/tck/tck-fix-quiet-period.md`. **User: also fix now** the batch reply collectors
  (BATCH-203 `_collect_flattened_responses`, BATCH-204/205 take first line as reply) — same
  skip-`method` rule — **done** `b7cb958` + `e644ee7`: `is_agent_initiated` / `next_reply_line`
  helpers (v1+v2); an array is agent-initiated only if non-empty and every element has `method`
  (mixed arrays are judged as replies); BATCH-201/203/204/205, INFO-BATCH/PARSE/INVALIDREQ use it;
  new split-reply fixture + `tests/v2/test_helpers.py`; acp-tck suite 284 pass. codex-acp results
  unchanged vs part 1. **Resolved; user approved the flush and resuming codex-acp.**
- (2026-09-24) **TCK-U2** — v2 `session/list` with omitted `params` → -32602. Is omitted params
  valid per ACP v2 / JSON-RPC; is the rejection ours or the SDK router's; v1 behaviour; fix point?
  → `.agents/research/v2-tck-omitted-params.md`. Status: **resolved — real bug, SDK side, v1 too.**
  JSON-RPC §4 + v2 schema allow omitted `params`; affects registered v2 `session/list` and
  `auth/logout` (all-optional). SDK 1.5.0 passes `undefined` into a plain `z.object` → -32602
  (`jsonrpc.ts:595-614`); no fix on origin/main. v1 has the identical bug (live probe; v1 TCK always
  sends `{}`). Parser override for built-in v2 methods throws in the SDK. Recommended fix: an
  `AgentConnector` wrapper in `AcpAgentRouter.ts` whose stream `TransformStream` adds `params: {}`
  to `session/list`/`auth/logout` requests lacking params (incl. batch entries), + upstream SDK
  issue. **User (2026-09-24):** v2 only; missing `params` only (not `null`); no upstream issue (add a
  code comment noting the SDK bug). Fix slice **2(u2)** queued.

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
  - **User decisions (2026-09-24) on #1-#3, all as recommended:**
    1. Turn starts but never inserts → fail the pending `session/prompt` with a JSON-RPC error
       (no `user_message`, no `messageId`).
    2. Command-prompt replay: accept live-only `user_message` for `/compact`, `/goal`, `/review`
       (no persistence); on replay **hide** the `clientId: null` reviewer prompt.
    3. Plan-implementation 2nd turn / goal continuation: **show** live as `user_message`, passing a
       minted `clientUserMessageId` so live and replayed ids match.
    #4-#6 → researched: `.agents/research/v2-codex-insertion-followups.md` (resolved 2026-09-24):
    4. `ResponseItemHistoryFallback` (→ **5b**): keep for tool calls; use its user chunks only for
       merge ordering, **never emit** them; no `client_id` parsing. Replayed user ids come only from
       thread items (`clientId ?? item.id`). 5b open: fallback agent/thought chunks lack `messageId`
       (invalid on v2); how to identify the reviewer prompt to hide (`clientId: null` also matches
       legacy/foreign messages); fallback can resurrect rolled-back turns on v1 load.
    5. `/review` (→ **2(a2)**): `review/start` response = parent turn id; `turn/started` = child
       id; items, `error`s and the single `turn/completed` use the parent id; `turn/interrupt`
       needs the **child** id. v2 must track two ids per turn: completion id (review/start response)
       for end/errors/stopReason, interrupt id (latest `turn/started`). On `review/start` success:
       response + live-only `user_message`, then `running`; never surface the `clientId: null`
       reviewer message; exactly one `idle` on `turn/completed` for the completion id. Do NOT use
       the clientId insertion matcher for reviews (would hang). **Existing v1 bug** (not fixed):
       `CodexEventHandler` overwrites `currentTurnId` with the child id → B1 `completesActiveTurn`
       never true for reviews; B2 review errors treated as a foreign turn's (duplicate terminal
       failure for typed-failure clients; others lose error text; quota/auth errors don't fail the
       prompt). Trap: cancel works only because `currentTurnId` = child id.
    6. `_session/steering`: pass a fresh UUID as `TurnSteerParams.clientUserMessageId` on every
       steer (judgment call, harmless on v1); on v2 show a steer as `user_message` only when its
       userMessage item arrives. Response unchanged. **User approved (2026-09-24): emit on
       landing** (no messageId in the steering response). Owner: topic 2(c) (`_session/steering`).
    **User decision (2026-09-24): fix the v1 `/review` bug as its own slice ("2(r)")** —
    introduce completion-id vs interrupt-id tracking with v1 tests, shipped as a `fix:` commit
    (intentional v1 behavior change; cancel during review must keep working). Do it before 2(a2),
    which builds on the two-id tracking.
  - **Open questions (originally; #1-#3 now decided above):**
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
- Still open: v2 `elicitation/create` send path (MCP OAuth re-auth + device-code login) → topic 4.
- Still open: v2 `session/request_permission` send path. `extensionOnlyV1View` rejects it today;
  topic 4 must add it (the v2 `ctx.client.request(acpV2.methods.client.session.requestPermission,
  …, {cancellationSignal})`, via the `AcpV2Connection` handle).

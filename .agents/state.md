# ACP v2 Migration — Implementation State

> Maintained by the orchestrator only (see `.agents/prompt.md`). Updated immediately after each
> slice/milestone completes. This file, plus `plan.md`/`architecture.md`/`research/*.md`, must be
> enough to resume this work from a fresh orchestrator run with no other context.

## Current position in the sequencing plan

Phase: **Phase 4.** Prerequisite and topics 1-10 done (2026-09-25). Rough progress ~93%.

### Resume here (for a fresh orchestrator)

State as of the **fourth flush** (2026-09-25): **no agents in flight; everything is committed** in
codex-acp (branch `eugenethedev/acp-v2`; last code commit `1ac2e35`) and in the acp-tck fork
(`main` @ `b15c7bd`, 6 local commits, **not pushed**; the user said don't push). Keep committing
with explicit pathspecs (the user may have unrelated staged edits to `.agents/agents/*.md`). Suite:
**934 pass / 26 skip**. `bun` is missing locally: programmers use `npm run build` for the TCK (see
`.agents/tck/HOW-TO-RUN.md`). **Next slice: 10(b) `_session/goal` on v2** (see "Topic 10 slice
order" under Next steps; details in the fourth-flush block below).

**Standing user rules:** preserve v1 client-visible behavior (change v1 only to fix a real bug, with
nothing else v1-visible changing; the user decides v1-visible trade-offs); **always assume the
latest Codex** (pinned 0.156.1), never design for older Codex; prefer simple, maintainable logic
over workarounds. Protocol questions → researcher; judgment calls with v1 impact → ask the user.

**v2 chain registers:** `initialize`, `session/new|list|close|delete|resume` (incl. `replayFrom:
start` replay), `session/set_config_option`, `session/cancel`, `auth/login|logout`,
`session/prompt` (with `$/cancel_request`), `_session/steering`. Outbound on v2: `session/update`
(via `toV2SessionUpdate(s)`), `state_update`, `session/request_permission`, `elicitation/create`,
`elicitation/complete`, `_auth/status_update`.

**Latest TCK:** full run after topic 3 (`.agents/tck/3-full-v1-v2.md`): v1 CONFORMANT 50/1
(SCHEMA-002 advisory)/5; v2 81/2/20 — RESUME-202 (fixed since by 5b-1: RESUME-201..205 pass in
scoped runs) and EXT-202 (advisory, `capabilities.providers` placement → topic 10). Expected v2
full-run fails now: none (EXT-202 fixed in the TCK fork, see below).

**Fourth flush (2026-09-25); user resumed the same day. Topic 10 DONE. Now: Phase 4.**
**P4(a) done (87fdeca `docs:`):** `readme-dev.md` "ACP v2 support" (v2 method chain, no new
knobs), "AIR v2 client contract", "Known gaps" (Q3, Q6), "Verification" (→ HOW-TO-RUN). Stale
comments fixed in `session-config-options-v2.test.ts`, `prompt-v2.test.ts` (test renamed),
`providers-v2.test.ts`; no `.agents/` refs in `src/`. No code-vs-state mismatches. Suite 973 / 26.
**P4(b) live checks done** (`.agents/research/v2-phase4-live-checks.md`; real Codex 0.156.1,
snapshot @85c21c7, temp CODEX_HOME, logs `/tmp/p4live/logs/`): 1 goal turn after `session/new` PASS
(v1+v2); 2 cancel during a real approval PASS (v1+v2; known `running` between `requires_action` and
idle); 4 resume with an active goal PASS (v2 ±replay, v1 load). **3 provider restart with an active
goal FAIL on v2:**
- **D1 (10(f2) race, v2):** close-out pass (`CodexAcpServer.ts:1583-1589`) runs after all resumes;
  Codex's new goal turn (~3 ms after `thread/resume`) already overwrote `codexReportedRunningTurnId`
  (`trackCodexTurnStart` `:1096`) → `running, running, idle cancelled, content while idle, idle`.
  Fix: per session, drain the old client + close out **before** registering the tracker and resuming
  (old process already exited, `:1643`). → programmer slice **P4(c)** in flight.
- **D2 (v1+v2):** the cut-off turn's in-flight tool call stays `in_progress` forever (terminal
  open); the old process's `item/completed` is lost. → **user (2026-09-25): fix on v1 + v2** (mark
  in-flight tool calls `failed`, end terminals, in the restart close-out) → slice **P4(d)** after P4(c).
- **D3 (pre-existing on `main`, v1+v2):** `session/new` then `providers/set|disable` before the first
  prompt → `thread/resume` "no rollout found" → -32603 "Failed to resume 1 session(s)", next prompt
  "thread not found" (`:1546-1574`). → **user (2026-09-25): don't fix now**; leave a clear `FIXME`
  comment at the restart resume loop describing the problem + document it in `readme-dev.md` Known
  gaps → slice **P4(e)** (`docs:`), after P4(d). Then final full TCK → done.

**10(f2) done (37bbc23 `fix:`):** `SessionState.awaitingClientLoad` (true for `operation ===
"fork"`, false on load). `enqueueProviderUpdate` restart loop: captures `previousClient`; for every
non-`awaitingClientLoad` session registers the ready-gated baseline tracker before
`replacement.resumeSession` (settled session / `null`); second pass drains
`previousClient.waitForSessionNotifications` and, if `codexReportedRunningTurnId` is set, clears it +
`reportUnownedTurnState(idle, cancelled)` (v2-only by that helper's guard; no-op with a v2 prompt in
flight). Restart doesn't wait for unowned turns. **Deviation (bug fix, side effect):** unloaded forks
(`awaitingClientLoad`) are no longer re-resumed on restart (the old loop resumed them, contrary to
69ca755); their later `session/load` resumes them as usual. Harness: `v2-prompt-harness.ts`
`createReplacementCodexAcpClient()`, `PromptSession.agent`. Tests
`provider-restart-turn-tracking.test.ts` (6). Suite 973 / 26, no snapshot changed. **Full TCK**
(`.agents/tck/10-full-v1-v2.md`): v1 CONFORMANT 50/1 (SCHEMA-002)/5; v2 CONFORMANT 84/0/19. Out of
scope, unscheduled: `TitleGenerator` keeps the dead client after restart; session open racing
`providers/set`; `_goal/control`/steering don't wait for a pending provider update.

**10(f1) done (b6b5935 `fix:`, v1+v2):** `createDeferred<T>()`; `startCodexTurnTracker(sessionId,
ready: Promise<SessionState|null>)` awaits `ready`, builds the `CodexEventHandler` lazily; registered
before `resumeSession`/`loadSession` in `tryCreateSession` "resume" and `getOrCreateSessionWithHistory`
(v1 load / v2 resume+replay); `installSessionState` no longer starts it. Deferred settled `null` on
every failure/stale path (+ new `CodexAcpClient.discardSessionSubscription(sessionId)` when no real
subscription); load paths settle in `streamThreadHistory`'s `finally` (live after replay).
`session/new`/fork unchanged (already-resolved promise). Tests `resume-goal-turn-timing.test.ts` (6:
v2 resume ±replay, v1 resume, v1 load, load ordering, failure path; 5/6 fail pre-fix). No snapshot
changed. Suite 967 / 26. TCK (`.agents/tck/10f1-targeted.md`) v1 `-k test_session` 18/0/2; v2
session/resume/state 24/0/2. Reusable for 10(f2): the deferred + ready-gated tracker; every
abort path must settle `null` or the session's notification queue wedges.

**10(e) done (01543bf):** `AcpAgentRouter.ts` v2 `providers/list|set|disable` → direct delegates
(`listProviders`/`setProvider`/`disableProvider`); restart path untouched. Tests
`providers-v2.test.ts` (v1/v2 loop: list, set, disable, idempotent unknown disable, unsupported
`apiType` / unknown id → -32602; pins: v2 non-URI `baseUrl` → -32602 (SDK `format: uri`), v1 same
input succeeds). No live sessions → restart not exercised. Suite 961 / 26. TCK
(`.agents/tck/10e-targeted.md`) v1 init/ext 7/1 (SCHEMA-002); v2 init/ext 14/0; v2 `-k
test_session` 24/0/2.

**10(d) done (b2e5732):** `forkSession` param widened to `WithAcpMcpServers<…>` (type-only); new
`forkSessionV2` = `forkSession` + `{sessionId, ...createSessionConfigOptionsResponseV2(...)}` (no
`modes`); registered via `acpV2.methods.agent.session.fork` after `session.resume`. Q2 parity
already given by `tryCreateSession` (`canPublishSessionUpdates=false` for fork). Q6 untouched.
Tests in `session-lifecycle-v2.test.ts` (+4; snapshots `data/session-lifecycle-v2-fork.json`,
`…-fork-invalid-params.json` -32602, `…-fork-unknown-session.json` -32603, same as v1); v1 pin
`modes` defined in `session-fork.test.ts`. Suite 947 / 26. TCK (`.agents/tck/10d-targeted.md`) v1
`-k test_session` 18/0/2; v2 24/0/2; v2 init/ext 14/0.

**10(c) done (d1584bb):** `AcpAgentRouter.ts` v2 `.onRequest(ASYNC_TASK_STOP_METHOD,
asyncTaskStopParamsParser, → extMethod)`; shared `extMethod` branch (`CodexAcpServer.ts:654-665`)
untouched. Advertising already identical (AIR `asyncTasks` in shared `initializeExtensionsMeta()`).
Unknown task/session → `{stopped:false}` (v1 parity); blank ids → -32602. Tests
`async-task-stop-v2.test.ts` (4). Suite 943 / 26. TCK (`.agents/tck/10c-targeted.md`) v1 init/ext
7/1 (SCHEMA-002), v2 14/0. Note (pre-existing, v1, not scheduled): the v1 SDK client's
`zSessionUpdate` rejects codex-acp's unprefixed v1 `async_task_*` tags (-32602 at the client), so
v1 tests use raw mock connections.

**10(b) done (5025885):** `AcpAgentRouter.ts` v2 chain `.onRequest(GOAL_CONTROL_METHOD,
goalControlParamsParser, → extMethod)` next to `_session/steering`; no business-logic change. Goal
request resolves after the Codex-started turn completes; tracker sends `running` + one `idle`; no
`user_message`. Zod errors → -32602 on both versions. Tests `session-goal-v2.test.ts` (5; no
snapshots). Suite 939 / 26. TCK (`.agents/tck/10b-targeted.md`): v1 init/ext 7/1 (SCHEMA-002
advisory); v2 init/ext 14/0; v2 state/prompt 9/0/1. Next slice to dispatch: **10(b) `_session/goal` on v2** (see "Topic 10
slice order" in Next steps). Suite **934 pass / 26 skip**. acp-tck `main` @ `b15c7bd` (6 local
commits, not pushed).

**10(a) done (1ac2e35):** `toV2SessionUpdate` (`src/AcpV2SessionUpdate.ts`): `subagent_spawned` /
`subagent_state_update` → `_subagent_update` (`{subagentSessionId, name, task, capabilities: {}}` /
`{subagentSessionId, state}`, `_meta` passed through; comment: rename on RFD PR #1992);
`async_task_spawned` / `async_task_state_update` → `_async_task_*` (payload unchanged);
`async_task_progress` stays fail-loud (never emitted). No renderer gate: gating is upstream and the
same on v1/v2 (`clientSupportsSubagents()` reduces to AIR `nativeSubagentSessions` on v2;
`createAsyncTasks()` gates on AIR `asyncTasks`). Tests: `session-update-v2.test.ts` (+1, snapshot
`data/session-update-v2-subagent-and-async-task.json`), new `subagent-and-async-task-updates-v2.test.ts`
(4, gated on/off), new `v2-resume-replay-subagents.test.ts` (3: resume replay no longer -32603;
child content replays; running background terminal announced as `_async_task_spawned` on replay via
`CodexBackgroundTerminalTasks.recover()`, so async tasks are not lost). Existing
`v2-session-update-guard.ts` already covers the unknown-tag guard. No v1 snapshot changed. TCK
(`.agents/tck/10a-targeted.md`) `-k "test_session or test_prompt"`: v1 24/0/3, v2 33/0/3.

**EXT-202 TCK fix — done; user OK'd resuming codex-acp (2026-09-25).** Q4/Q5 research done (below). User
chose Q1 (a) in the blocking manner: no codex-acp work until the fix is verified and the user
confirms. acp-tck `main` (not pushed) `6e29654` (fix) + `b15c7bd` (self-tests): vendored v2
`schema.unstable.json` (spec `d8805733`) + `load_unstable_schema()`; `_allowed_root_properties`
unions stable + unstable properties (used by `find_unknown_root_keys` → EXT-202, SCHEMA-002); full
jsonschema validation (SCHEMA-001) stays stable-only; no requirement text changed. Fixtures
`unstable_capability_key.py` (PASS) / `unknown_capability_root_key.py` (still FAIL). acp-tck suite
286 pass. codex-acp @ `f9d477b`: scoped `-k "test_initialize or test_extensibility"` v2 only
EXT-202 FAIL→PASS, v1 identical (SCHEMA-002 advisory unchanged). **Full v2 84/0/19 CONFORMANT; full
v1 50/1 (SCHEMA-002)/5 CONFORMANT.** Note `.agents/tck/tck-fix-ext-202.md`. acp-tck now 6 local
commits ahead, not pushed.

**Q4/Q5 research done** (`.agents/research/v2-provider-restart-and-fork-tracking.md`, code reading
@893716e + Codex rust-v0.156.1; no live run). **Q4 confirmed (v1+v2):** the provider restart builds a
new `CodexAcpClient` (empty subscription registry, `CodexAcpServer.ts:1551-1558`) and re-resumes
sessions without subscribing (`:1476-1492`); `CodexAppServerClient.notify` drops unhandled threads
(`:888-895`) → post-restart goal turns unrendered, no v2 `running`/`idle`, until the next prompt.
Turn running at restart: never completes (app-server drops the route on EOF) → v2 `running` with no
`idle` (MUST) + stale `codexReportedRunningTurnId` (`isSessionBusy` wrongly true, breaks M2).
`providers/set` waits (no timeout) for all active prompts. Fix sketch: (1) `startCodexTurnTracker`
before `replacement.resumeSession` in the resume loop (**v1-visible, additive → user decision**);
(2) capture the old client, `waitForSessionNotifications`, then clear the turn id +
`reportUnownedTurnState(idle, cancelled)` (v2-only); (3) don't wait for unowned turns. **Q5
refuted:** Codex copies a goal into a fork only with experimental `deferGoalContinuation` (not
sent); nothing to fix. **Adjacent (open):** normal `session/resume` likely drops a goal turn's
`turn/started` (tracker installed after resume + `model/list` + `account/read`) → `idle` without
`running` (live check); `TitleGenerator` keeps the dead client after restart; a session open racing
`providers/set` may run on the killed client; with fix 1 unloaded forks get re-subscribed;
`_goal/control`/steering don't wait for a pending provider update (unverified).

**User decisions (2026-09-25) on Q4:** apply fix 1 (tracker reinstall before re-resume) on **v1 and
v2**, plus fix 2 (v2-only `idle`/`cancelled` close-out) and 3 → new slice **10(f) provider-restart
tracking** (after 10(e)). Normal-resume timing gap: **confirmed live**
(`.agents/research/v2-resume-goal-turn-timing.md`): the tracker is installed in `installSessionState`
(`CodexAcpServer.ts:912` resume, `:2412` load) after `thread/resume` + `model/list` + `account/read`
(+ history read); `notify` drops unhandled thread events; the goal turn starts ~6-8 ms after resume.
Unmodified local runs won 4/4; with +30 ms after `model/list`, v1 and v2 lost `turn/started` and v2
got a lone `idle`. Affects v2 resume (±replay), v1 resume, v1 load; also stale `codexReportedRunningTurnId`
(no `requires_action`, no M2). Load paths: live frames can interleave with the history replay. Fix
sketch: `startCodexTurnTracker(sessionId, ready: Promise<SessionState|null>)`, called before
`resumeSession`/`loadSession`; `installSessionState` resolves it (after `streamThreadHistory` on
load); always settle `null` on failure/stale paths (per-session queue would block). v1-visible
(no lost opening items; live after replay) → **user (2026-09-25): v1 + v2, in the 10(f) group** —
split as 10(f1) early-subscribe tracker on resume/load (`ready` promise), 10(f2) provider-restart
reinstall (reuses f1) + v2 `idle`/`cancelled` close-out. Vitest repro: resume a
second thread id, emit `turn/started` + delta from a `model/list` override.

**5b-2b done (f9d477b)** → **topic 5 done.** v2-only filter in `streamThreadHistory` also drops
fallback `agent_message_chunk`/`agent_thought_chunk` (identity check against
`responseItemFallbackUpdates`; still merge anchors). Tests in `v2-resume-replay.test.ts`: tool call
only, in position (snapshot `data/v2-resume-replay-fallback-tool-call-only.json`); fallback
determinism sibling; v1 regression. `connectV2Client` gained `threadPath`. Suite 926 / 26. TCK
(`.agents/tck/5b-2b-v1-v2.md`) v1 `-k test_session` 18/0/2; v2 `-k "test_session or test_resume"`
24/0/2 (= baseline).

**User decisions (2026-09-25) on topic 10 research:** Q1 EXT-202 → (a) keep + fix TCK (blocking,
above); Q2 forks match v1 (no `available_commands_update` on v2); Q3 leave the disabled-`openai`
`current` gap + document in Phase 4; Q6 unknown → flag as an open AIR contract question in the
Phase 4 docs.

**Topic 10 research done** (`.agents/research/v2-fork-providers-and-extension-methods.md`): no
protocol changes needed; all four are thin v2 wrappers over v1 logic. **Bug:** v2 `initialize`
already advertises `session.fork`, `capabilities.providers`, `_meta.goal.controlMethod` but none is
registered (-32601). Fork: unstable-only; request = v1 (incl. `mcpServers`, `WithAcpMcpServers`
type widen); response must drop `modes` (+ `createSessionConfigOptionsResponseV2`); no replay/state
obligation. Providers: same shapes (v2 SDK validates `baseUrl` as uri → -32602 on v2 only); direct
delegates via `acpV2.methods.agent.providers.*`. `_session/goal` / `_session/async_task/stop`: same
zod parsers + `extMethod` like `_session/steering`; goal request is not a prompt (existing tracker
sends `running`/`idle`); async stop is inert until the `_async_task_*` renderer cases land. TCK has
no tests for these methods (Vitest must cover); filters: `-k "test_initialize or test_extensibility"`,
`-k test_session`, `-k "test_session or test_prompt"` (v1 too). **Slices:** 10(a) renderer cases
(before 10(c)); 10(b) `_session/goal`; 10(c) `_session/async_task/stop`; 10(d) `session/fork`;
10(e) `providers/*` + EXT-202. **Open, user decisions:** Q1 EXT-202 (a: keep + fix TCK fork, rec.);
Q2 no `available_commands_update` for forks on v2 (parity, rec.); Q3 disabled `openai` still listed
as current (RFD MUST `current:null`; rec. leave + document). **Unverified (confirm before 10(e)):**
Q4 provider restart re-resumes sessions without reinstalling the baseline turn tracker (v1+v2; v2
may miss `idle` for a running goal turn); Q5 v1 fork `thread/unsubscribe`s → inherited goal turns
invisible until first prompt; Q6 (ask AIR) fork points match Codex item ids, but v2 user message id
is our `clientId`.

**Next steps, in order (one programmer at a time; researchers may run in parallel):**
0. **Remaining work (Phase 4 tail), one programmer at a time; all decisions are recorded in the
   "P4(b) live checks done" block above:**
   - **P4(c)** D1 restart close-out race (v2) — in flight at the time of the fourth-session flush
     request; see that block for the result if recorded.
   - **P4(d)** D2 (v1 + v2): in the provider-restart close-out, mark the cut-off turn's in-flight tool
     calls `failed` and end their terminals (`fix:`). Evidence: `v2-phase4-live-checks.md` check 3.
   - **P4(e)** D3 (`docs:`): `FIXME` comment at the restart resume loop (`CodexAcpServer.ts`
     ~1546-1574, never-prompted session has no rollout → `thread/resume` fails → session dies) +
     `readme-dev.md` Known gaps entry. Don't fix.
   - **Final:** full TCK v1 + v2 (expect v1 50/1 SCHEMA-002/5, v2 84/0/19), record, done. Topic 10 and
     earlier slices are history (below).
1. ~~**5b-2b**~~ done (programmer, small): Q1 option A (user decision) — on v2 the
   `ResponseItemHistoryFallback` contributes only its recovered tool calls (`tool_call` /
   `tool_call_update`); every fallback `user_message_chunk` / `agent_message_chunk` /
   `agent_thought_chunk` is a merge anchor only and never sent (extend 5b-1's filter in
   `streamThreadHistory`, `CodexAcpServer.ts` ~2463-2473). v1 unchanged. Test: legacy fixture with
   an unmatched fallback agent chunk + a recovered `function_call` → only the tool call is sent,
   in position; determinism test can then include the fallback. `feat:` commit. Then end-of-topic-5
   scoped TCK (v1 `-k test_session`, v2 `-k "test_session or test_resume"`).
2. **Topic 10** — needs slicing; research first where not covered. Owned items:
   `session/fork` (`acpV2.methods.agent.*`), `providers/{list,set,disable}`, `_session/goal` and
   `_session/async_task/stop` via `onRequest("_…", parser, h)`; renderer cases in
   `toV2SessionUpdate` for `subagent_spawned`/`subagent_state_update` → `_subagent_update` and
   `async_task_*` → `_async_task_*` (decided: `v2-subagent-and-custom-session-updates.md`; this also
   fixes the accepted v2 replay fail-loud for AIR `nativeSubagentSessions` clients and the silently
   lost async tasks on resume); EXT-202 `capabilities.providers` placement
   (`v2-extension-capabilities-placement.md`); child-session primers on native replay (5b-2a tested
   the root session only); subagent child sessions never count as busy, so child-session
   permissions get no `requires_action` (4(c) note). Suggested: a researcher first for
   `session/fork` + providers on v2 (shapes vs v1, capability advertising, fork replay/`replayFrom`),
   then slices 10(a) renderer cases, 10(b) extension methods, 10(c) fork, 10(d) providers + EXT-202.
3. **Phase 4** — full TCK v1 + v2 (from one process); AIR v2 contract docs in `readme-dev.md`
   (idle `_meta` `sessionFailure`/quota; `_subagent_update`/`_async_task_*` names; the SDK client
   counts any `idle` as a pending prompt's stop; steers show as `user_message` on landing; permission
   requests withdrawn with `$/cancel_request` on cancel); live checks via `/run-codex` (auto goal turn
   after `session/new` renders — G-render; cancel during a real approval); fix stale v2 test doc
   comments.
- **Unscheduled follow-ups (minor):** `titleGen.onTurnCompleted` latch on non-inserted turns
  (2(a2-iv)); M2 only on the main dispatch path; redundant second `running` after a late permission
  answer on cancel (3(d)); close during an unowned turn gets no interrupt retry (3(a)); idle-time
  permission/elicitation can't be aborted by `session/cancel` (uses the finished prompt's
  `interactionSignal`); OAuth elicitation may precede the `session/new` response; Q-PERM research
  open Qs (react to Codex `serverRequest/resolved`); MCP startup status may land after the resume
  response (RESUME-202 quiet period); fallback misses the inherited prefix of forked/reverted threads.

**Slice log for the second and third sessions (history; the list above is authoritative).** The
numbering below is the old next-steps list, kept as a log:

1. Three small slices, one programmer each, in this order:
   - **J11** — **Done (64d1201)**: removed `startGoalContinuationIfCurrent`, its 2 call sites,
     `goalControlGenerations`/`bumpGoalControlGeneration`, and the `GOAL_CONTINUATION_PROMPT` import
     in `CodexAcpServer.ts` (export kept for J11b's path); `runGoalSet`'s 1 s timer untouched.
     `CodexAcpClient.test.ts`: 3 tests retargeted (no continuation turn on set/resume), the
     reservation test now uses the steering fallback (`turnSteer` rejects → `startNewTurnFromSteering`),
     "starts only the latest goal replacement" deleted (mechanism gone). J11b's test "starts a goal
     work turn when app server starts no continuation turn" left as is. Suite 889 / 26. TCK v1 25/1
     (SCHEMA-002)/3; v2 37/2 (RESUME-202, EXT-202)/4.
   - **J11b** — **Done (e92e366)**: `createGoalCommandResult(null)` → `{handled: true}`;
     `GOAL_CONTINUATION_PROMPT` and `CommandHandleResult`'s `handled:false.prompt` removed; dead
     `effectiveParams`/`turnClientUserMessageId`/goal `registerSyntheticInsertion` code in `prompt()`
     removed (plan-impl synthetic insertion kept). Tests retargeted in `CodexAcpClient.test.ts` and
     `prompt-v2.test.ts` (snapshot `prompt-v2-goal-resume-continuation.json` →
     `…-no-continuation.json`). Suite 889 / 26. TCK v1 24/0/3; v2 31/1 (RESUME-202)/4.
   - **G-render** — **Done (612d1a5)**: `startCodexTurnTracker` owns a `CodexEventHandler` (same args
     as the prompt path, `collectTurnDiffs=false`) and calls `handleSessionScopedNotification` before
     `trackCodexTurnCompletion`. Ownership = `CodexSubagentSubscriptions` keeps one `current` closure
     per session; the first `prompt()` subscription replaces the baseline (resume/load reinstall it),
     so no double render; after that, the prompt's leftover subscription already renders unowned
     turns via the same call. `DENY_ALL_*` unchanged. Tests: `agent-initiated-turns-v2.test.ts`
     (+new/resume render, no-double-render), new `agent-initiated-turns-v1.test.ts`; harness gained
     `thread/resume` response + `agentMessageDelta`. No snapshot changed. Suite 893 / 26. TCK v1
     24/0/3; v2 31/1 (RESUME-202)/4. Not live-checked → include an auto-goal-turn-after-`session/new`
     live check in Phase 4.
2. **Topic 3**, cancellation. Slices (one programmer each, in order):
   - **3(a)** — **Done (78a8666)**: shared retry loop `requestTurnInterrupt(sessionState, threadId,
     completionTurnId, requestName)`; id recomputed after each backoff (`interruptTurnId ?? mismatch
     found ?? completion id`); retries "no active turn" and `parseExpectedActiveTurnMismatch`
     (`CodexThreadErrors.ts`) when `expected === currentTurnId`, `found` non-empty, and
     `activePrompts.has(threadId)`; `Close` now retries like `Cancel`. `interruptPromptTurn`/
     `interruptLateStartedTurn` take `sessionState`. Tests: +3 in `review-turn-ids.test.ts`;
     `cancel-turn-registration-race.test.ts` "does not retry on close" → "retries a close interrupt
     the same way as a cancel" (old test pinned the bug). No snapshot changed. Suite 896 / 26. TCK v1
     `-k "test_cancel or test_session or test_prompt"` 26/0/3. Note: retries are gated on an active
     prompt, so closing during an unowned (Codex self-started) turn gets no retry — pre-existing.
   - **3(b)** — **Done (8815bd5)**, one open question (Q-PERM below). `session/cancel` on the v2
     chain → shared `cancel()`. `queuedV2PromptCancellers` + `registerQueuedV2PromptCanceller`/
     `cancelQueuedV2Prompts` (called by `cancel()` before `interruptSessionTurn`, and at the top of
     `closeSession()`; v1 no-op). `promptV2` races `reservation.wait` against its canceller → -32800
     at once, but releases its FIFO slot only after `reservation.wait` resolves. `!inserted` +
     `stopReason === "cancelled"` → -32800 (was -32603; M2 adopted-not-landed; one `prompt-v2` test
     expectation updated). Harness: `PromptSession.cancel()`, `onRequestPermission` gets `ctx.signal`.
     `cancel-v2.test.ts` (4) + 1 snapshot. Suite 900 / 26. TCK v1 26/0/3; v2 `-k "test_cancel or
     test_prompt or test_session or test_state"` 39/1 (RESUME-202)/5: CANCEL-201/202/203/205/206/
     207/208 + INFO-CANCEL-201/202 PASS, CANCEL-204 SKIP (unobservable). Missing: the "cancel during
     a permission request" test (blocked on Q-PERM).
     **Q-PERM (researcher dispatched):** plain `session/cancel` never aborts `activePrompt.signal`
     (only `closeSession` via `requestClose()` and v1 `$/cancel_request` via
     `observePromptRequestCancellation` do), so the outbound `session/request_permission` is not
     `$/cancel_request`ed on cancel (v1 or v2); only `turn/interrupt` is sent. **Research done**
     (`.agents/research/v2-cancel-pending-permission.md`): the client MUST answer pending permissions
     `cancelled` (v1+v2); agent `$/cancel_request` is only MAY (INFO-CANCEL-202 informational).
     Codex on interrupt aborts its pending approval (`serverRequest/resolved`, later answers dropped);
     codex-acp ignores that. Today no hang: v1 `cancelled`, v2 one `idle/cancelled`. **Real bug (v1+v2):**
     cancel during the plan-implementation review (no turn to interrupt, signal never aborted) → the
     client's `cancelled` answer makes the prompt end `end_turn` (breaks CANCEL-203; untested). Options:
     (a) `cancel()` calls `activePrompt.requestCancel()` (too broad: changes pre-turn flow);
     (a′, researcher's pick, v1+v2) separate per-prompt permission/elicitation abort controller fired by
     cancel/close + `cancelRequested` flag → plan review returns `cancelled` (v1-visible: optional
     `$/cancel_request` per pending request, and the bug fix); (b) v2 only; (c) leave. Research open
     Qs: react to `serverRequest/resolved`; stray v2 `running` after idle when a late answer arrives;
     URL elicitations; resolved-vs-completed ordering. **User decided (2026-09-24): (a′) on v1 and
     v2** (bug fix + cascade; the v1 `$/cancel_request` is accepted) → slice **3(d)**. Research open Qs
     not scheduled.
   - **3(c)** — **Done (6aa86ed)**: `promptV2(params, signal?)` (router passes `ctx.signal`). Queued
     → same canceller as 3(b) (only it, -32800). Started-not-inserted (`dropPendingRequest`; new
     `UserMessageInsertion.onTurnStarted` fired in `tryHandleCommand` + `sendPrompt`): not adopted →
     `requestTurnInterrupt` + -32800; M2-adopted → -32800 only, turn untouched. After insertion →
     no-op. Harness: `signal` on `sendPrompt`/`request`, `turnInterruptCalls()`. +4 tests in
     `cancel-v2.test.ts`. Suite 904 / 26. TCK v1 `-k "test_cancel or test_prompt"` no fails; v2
     `-k "test_cancel or test_prompt or test_state"` no fails (CANCEL-204 skip).
   - **3(d)** — **Done (17d8a62)**: `ActivePrompt.interactionSignal`/`abortInteractions()`/
     `cancelRequested` (second controller in `trackActivePrompt`; `requestCancel`/`requestClose` abort
     it; `cancel()` sets the flag + aborts synchronously before queue drop/interrupt). Approval,
     elicitation and plan-review permission use `interactionSignal`; plan-review stop check
     `promptShouldStop(...) || cancelRequested`. `acp-test-utils.ts` `getAcpRequestOptions()`. Tests:
     +1 `approval-events`, +1 `plan-review-events` (v1), +2 `cancel-v2`. Suite 908 / 26. TCK v1
     `-k "test_cancel or test_prompt or test_permission"` no fails; v2 CANCEL-201..208 (204 skip) +
     INFO-CANCEL-201/202 + STATE-201..203 PASS. **Minor follow-up (unscheduled):** v2 cancel during
     `requires_action` yields `requires_action, running, running, idle/cancelled` — a redundant
     second `running` from the late permission answer (legal: nothing after idle); plan-review cancel
     `running, idle/cancelled`.
   - **3-full** — **Done (30cc414)**, `.agents/tck/3-full-v1-v2.md`: v1 CONFORMANT 50/1 (SCHEMA-002)/5
     (= baseline). v2 81 pass / 2 fail / 20 skip (502 s): only RESUME-202 (5b) + EXT-202 (advisory);
     all CANCEL-* pass (204 skip), INFO-CANCEL-202 pass. **Topic 3 done.**
   - **3(c)** `$/cancel_request` / `ctx.signal` for a pending v2 `session/prompt` (queued → only it,
     -32800). Then end-of-topic full TCK v1 + v2.
   CANCEL-202 goal risk: live probe in `v2-agent-initiated-turns.md` (n=1) saw no goal turn after an
   interrupt → treated as safe. Original notes: `ctx.signal` / `$/cancel_request` (incl. a queued prompt → only it is
   dropped with -32800) and v2 `session/cancel` (drops all queued not-yet-inserted prompts with
   -32800, one `idle`/`cancelled` for the running turn; `session/close` acts like cancel; the queue
   hook is in `acquireTurnStartReservation`/`promptV2`); v1 cancel-retry option B; retry
   `Close`-named interrupts. Note: CANCEL-202 safety depends on goals pausing on interrupt
   (unverified, `v2-agent-initiated-turns.md` Q2 TCK note).
3. **Topic 4(b)** — **Done (f901d30)**: v1/v2 elicitation types are identical in SDK 1.5.0. New
   `src/AcpV2Elicitation.ts` (identity conversion points + `elicitationSessionId`);
   `AcpV2Connection.createElicitation()` (session-scoped → `requires_action` before, `running` in
   `finally` if `isTurnRunning`; request-scoped, e.g. device-code login → no states) +
   `completeElicitation()` (`elicitation/complete`); routed from `extensionOnlyV1View()`. Harness:
   `onElicitation`, elicitation transcript entries. `elicitation-v2.test.ts` (6: OAuth accept/
   decline/cancel, no-url-mode fallback to permission, cancel aborts, device-code `auth/login` end to
   end). Suite 914 / 26. TCK v1 `-k "test_authentication or test_prompt"` no fails; v2 `-k "... or
   test_permission"` 12/0/6 (no TCK elicitation module).
   **Q-IDLE-RA (researcher dispatched):** a session-scoped permission/elicitation while no turn runs
   (e.g. MCP OAuth re-auth during MCP startup at `session/new`/`resume`, if that happens) sends
   `requires_action` and then nothing → client left in `requires_action`. Can it happen; what v2
   allows (skip `requires_action` when idle? return to `idle`?). Report →
   `.agents/research/v2-requires-action-outside-turn.md`. **Resolved:** real on v2 via (1)
   codex-acp's own MCP OAuth re-auth at session open (`authenticateMcpServer`, fire-and-forget from
   `tryCreateSession` for new/resume with `mcpServers`, URL elicitation with `sessionId`) and (2) Codex
   `mcpServer/elicitation/request` with `turnId: null` while idle after a prompt has run (the
   prompt's handler stays current). Spec: `requires_action` = foreground work blocked (SHOULD only
   then); `idle` MUST when ready. **Orchestrator decision (option (a), v2-only, no v1 impact):** in
   `AcpV2Connection.requestPermission()` and session-scoped `createElicitation()`, check
   `isTurnRunning` once before sending; not busy → no `requires_action` and no trailing `running`;
   busy → `running` in `finally` only if still busy. Slice **4(c)**, after 5b-1 lands. Also fix the
   wrong "only ever fires mid-turn" comment in `elicitation-v2.test.ts` and add tests for both idle
   paths. **4(c) — Done (ad03c16)**: private `withStateBracket(sessionId, sendRequest)` in
   `AcpV2Connection` (checks `isTurnRunning` once; idle → no states; busy → `requires_action` +
   `running` in `finally` if still busy), used by `requestPermission()` + session-scoped
   `createElicitation()`. Harness: `connectSession({codexResponses})`. +3 tests in
   `elicitation-v2.test.ts` (OAuth at session open; idle `turnId:null` MCP elicitation; its
   permission fallback), comment fixed. Suite 918 / 26. TCK v2 `-k "test_permission or test_state
   or test_prompt"` 9/0/2. **Topic 4 done.** Routed: subagent child sessions (`isSessionBusy(child)` always false → with (a) no
   `requires_action` for child-session permissions) → topic 10; idle-time requests use the finished
   prompt's `interactionSignal` so `session/cancel` can't abort them (unscheduled); OAuth elicitation
   may precede the `session/new` response (unscheduled).
4. **Topic 5b**, resume replay (list below, item 6).
   **5b-1** — **Done (bcab7b7)**: `loadSessionAndReplayHistory` (shared by v1 `loadSession` and v2
   `resumeSessionV2` `start`; replay awaited before the response); v2-only in `streamThreadHistory`:
   fallback `user_message_chunk`s dropped (merge anchors only) + `sendReplayMessageStart` primer
   (`content: []`, once per kind+id, none for id-less chunks) via new
   `AcpV2Connection.startReplayMessage` / `ACPSessionConnection.startReplayMessage`
   (`ReplayMessageKind`); `createUserMessageUpdates` id = `clientId ?? item.id` on v2. Primer rule
   is replay-only (live unchanged). Still random ids: review-mode entered/exited chunks, unmatched
   fallback agent/thought chunks. Tests in `session-lifecycle-v2.test.ts` (+1 net) + snapshot
   `session-lifecycle-v2-resume-start-replay.json`; no v1 snapshot changed. Suite 915 / 26. TCK v1
   `-k test_session` 18/0/2; v2 `-k "test_session or test_resume"` 24/0/2: **RESUME-201..205 PASS**,
   DELETE-202 skip.
   **User decisions (2026-09-24) on Q-5B:** Q2 hide the reviewer prompt on **v2 only**; Q4 **accept**
   the subagent fail-loud until topic 10; Q5 **skip the fallback when a rollout has
   `thread_rolled_back`** (v1 + v2 bug fix). **Q1 → option A** (user, 2026-09-24, after
   clarification): on v2 the fallback contributes only its recovered tool calls; all fallback
   user/agent/thought chunks are merge anchors only, never sent. v1 unchanged.
   **5b-2a** — **Done (7406f7b `fix:` rolled-back rollouts → `parseResponseItemHistoryFallback`
   returns `null` if any `event_msg` `thread_rolled_back` (`isThreadRolledBackRecord`), v1+v2;
   1cd3e3b `feat:`)**: `createReviewModeUpdate` `messageId: item.id` on v2; `hiddenReviewerPromptItemIds(thread)`
   + `isUuidV7` implement the Q2 rule, applied on v2 in `streamThreadHistory` and
   `streamNativeThreadHistory`; native path sends primers on v2 (root session tested only; child
   sessions → topic 10). New `v2-resume-replay.test.ts` (review ids + hiding snapshot, native
   primers, replay-twice determinism with a fallback-free fixture) + v1 regression (reviewer prompt
   still shown on v1) + fallback rolled-back test. Suite 923 / 26. TCK v1 `-k test_session` 18/0/2;
   v2 `-k "test_session or test_resume"` 24/0/2 (RESUME-201..205 pass). **5b-2b** (next): Q1 option A.
   **Q-5B research done** (`.agents/research/v2-resume-replay-open-questions.md`, HEAD 7e2ec21):
   - Q1 ids: spec needs unique ids + RESUME-204 prompt ids only; stability is a judgment call.
     agentMessage/reasoning/review-mode items already stable (item ids). Review-mode chunks: set
     `item.id` in `createReviewModeUpdate` (v2 only). Fallback agent/thought chunks: A never emit on
     v2 (merge anchors only) vs B `fallback:<line>` ids → **user decision**.
   - Q2 hide reviewer prompt: U hidden iff `clientId==null`, first item of turn T, next turn starts
     with `enteredReviewMode`, `T.id > P.id` (UUIDv7), optionally T has no agentMessage/other user
     msg; hide only U; both native and non-native paths. v2 only vs v1 too → **user decision**.
   - Q3 interrupted reviews: no special handling beyond Q1/Q2/primers.
   - Q4 subagents: with AIR `nativeSubagentSessions`, a thread with `subAgentActivity` makes v2
     `session/resume` replay fail -32603 midway (fail-loud renderer); async tasks silently lost
     (`reconcile` catches). Maps 1:1 once topic 10 adds renderer cases → sequencing **user decision**.
   - Q5: 0.156.1 has no `thread/rollback`; old rollouts with `thread_rolled_back` still resurrect
     rolled-back tool calls via the fallback (v1 bug). Skip the fallback when that record exists
     (changes v1 output) → **user decision**.
   - Q6: `content: []` primer before the first chunk of every replayed user/agent/thought message
     (one per id, none for zero-chunk messages), also in the native path + child sessions; needs a
     v2-only send (like `updateState`). Add a replay-twice determinism test. MCP startup status may
     land after the resume response (RESUME-202 quiet period) — open.
5. **Topic 10**, `session/fork`, providers, `_session/goal`, `_session/async_task/stop` on v2 +
   subagent/async-task renderer cases; EXT-202 placement.
6. **Phase 4**, full TCK v1 + v2; AIR v2 contract docs (idle `_meta` `sessionFailure`/quota;
   subagent/async renames; the SDK client counts any `idle` as a pending prompt's stop; steers show
   as `user_message` on landing).
- Small unscheduled follow-ups: `titleGen.onTurnCompleted` latch on non-inserted turns (2(a2-iv));
  M2 only on the main dispatch path; stale v2 test doc comments.

### Slice log (detail; items marked Done are history, the list above is authoritative)

**Original next-steps list (history):**
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
5. **Topic 4** — (pulled ahead while Q3 was blocked) **4(a)** — **Done (4c4e7a6)**: new
   `src/AcpV2Permissions.ts` (single conversion point `toV2RequestPermissionRequest` /
   `toV1RequestPermissionResponse`): v2 `title` = `_meta.permission.title` ?? `toolCall.title` (none →
   internalError), `description` = `_meta.permission.description` (new `readPermissionMeta()`),
   `subject: {type:"tool_call", toolCall}` with content via exported `toV2ToolCallContent`, `options` /
   `_meta` unchanged. `AcpV2Connection.requestPermission()` sends `requires_action` before, `running`
   in `finally` (single-flight; `RequiresActionStateUpdate` has no id). `extensionOnlyV1View().request()`
   routes `session/request_permission` there. **Deviation (touches v1 code, same v1 behavior for valid
   outcomes):** `CodexApprovalHandler.ts`/`permissions/mcp.ts` response readers now check
   `outcome === "selected"` instead of `!== "cancelled"` (ENUM-203 open union). Tests
   `permissions-v2.test.ts` (7, incl. real plan-implementation permission) + 4 snapshots;
   `initialize-v2`/`session-update-v2` rejection tests now use `fs/read_text_file`. Suite 867 / 26.
   TCK v1 `-k test_prompt` 6/1; v2 `-k "test_prompt or test_permission or test_enums or test_patches"`
   12 pass / 10 skip / 0 fail; PERM-201/ENUM-203/PATCH-209 still skip (TCK "hi" prompt triggers no
   approval). Check in 2(a2-v): the unconditional `running` after a permission is only right while
   a turn is running. **4(b)** `elicitation/create` — next after 2(a2-v)/2(c).
   Original scope: permissions / `requires_action`: v2 `request_permission` and `elicitation/create`
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
| 2 | Prompt lifecycle & turn state machine | **Done** | 2(a1), 2(r), 2(b), 2(e), 2(h), 2(u2), 2(a2-i..v), 2(c)-1, 2(c)-2(i), J11, J11b, G-render done | — (topic 2 done apart from small follow-ups) | Long pole — start early per plan.md |
| 3 | Cancellation semantics | **Done** | — | — | Depends on topic 2's `state_update` fork existing |
| 4 | Permission requests & approvals | **Done** | — | — | Depends on topic 2's `state_update` fork existing |
| 5 | Session lifecycle (new/resume/list/close/delete) | Done | 5a, 5b-1, 5b-2a, 5b-2b (f9d477b) | — | Depends on topics 1, 9 |
| 6 | Tool calls, messages & terminal streaming | **Done** | — | — | 6(a)-6(d); end-of-topic full TCK in `.agents/tck/6-full-v1-v2.md` |
| 7 | MCP config & client execution surface removal | **Done** | — | — | Depends on topic 1 |
| 8 | Auth flow rename | **Done** | — | — | 11a1969, 5f9335b |
| 9 | Config options, modes & plans | **Done** | — | — | 9a + 9b landed |
| 10 | Unstable/extension methods on v2 (plan gap) | Done | research, 10(a) (1ac2e35), 10(b) (5025885), 10(c) (d1584bb), 10(d) (b2e5732), 10(e) (01543bf), 10(f1) (b6b5935), 10(f2) (37bbc23) | — | Not owned by plan.md topics: register `session/fork` and `providers/{list,set,disable}` via typed `acpV2.methods.agent.*`; `_session/goal`, `_session/async_task/stop` via `onRequest("_…", parser, h)`; outbound `_auth/status_update` via `client.notify`; subagent/async-task renderer cases (see Open questions). `_session/steering` is owned by topic 2(c). Depends on topic 1 |

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
  Status: **resolved (2026-09-24)** — decisions below. Findings:
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
  - **2(c) blocker — confirmed live** ("Live verification (Codex 0.156.1)" section of the same
    file; probe `/tmp/goalrace/probe.mjs`). Auto goal turns start 6–25 ms after `turn/completed`,
    `thread/goal/set`, or `thread/resume`, with no userMessage. B's `turn/start` sent ≤12 ms after
    `turn/completed` gets its own turn (6/6); ≥16 ms → silently steered (4/4; response returns the
    goal turn id, `inProgress`). No non-steering `turn/start` option. Only early signal:
    `thread/goal/updated{status:"active", turnId}` 2–3 ms before each `turn/completed`. Working
    mitigation **M1**: pause goal while A runs → `turn/start` B after A completes → set active once B
    starts (2/2; costs: visible paused→active churn, goal token accounting stops during pause, a
    crash leaves it paused). **M2** detect-and-adopt (response turn id ≠ ours → treat B as steered,
    resolve on userMessage landing, one `idle` at that turn's end) needed regardless. With an active
    goal the thread is never idle beyond ~20 ms gaps → strict queue-until-idle starves B.
    New judgment calls: **J8** queued prompt during active goal (a) M1 / (b) steer / (c) hold;
    **J9** relax 2(c) to "never knowingly" + M2; **J10** prompts right after resume with an active
    goal; **J11** keep or remove codex-acp's own goal-continuation fallback (C1; redundant on
    0.156.1).
    **User decisions (2026-09-24, partial):** J1-J3 → foreground as recommended (`running` at turn
    start, one `idle`; minted id + `user_message` on landing for codex-acp-started turns; none for
    Codex self-started goal turns). **J8 → (b) steer B into the running goal turn** (not M1 pause).
    J4/J5/J7 as recommended. **J6 → shared reservation on v1 too** (scheduling only, no wire change).
    **J11 → remove codex-acp's C1 goal-continuation fallback.** **J9/J10 → relax + adopt (M2)**, no extra
    workarounds (user: keep logic simple; no pause-before-resume tricks): never *knowingly*
    `turn/start` on a busy thread; if the `turn/start` response returns a turn id codex-acp didn't
    start, treat B as steered — B's request stays pending until its userMessage lands (response +
    `user_message`), no second `running`, one `idle` at that turn's end; if the steered input is
    dropped (turn interrupted before the next model call) B never lands → fail B with a JSON-RPC
    error (decision #1). Same path after `session/resume` with an active goal. With J8 = steer, a
    prompt arriving during a goal turn goes straight to `turn/start` (steer) instead of the queue.
    **All Q3 decisions made; 2(a2-v)/2(c) unblocked.** Milestones:
    **2(a2-v)-1** v2 session-level Codex turn tracking (J5) + `running`/one `idle` for turns no v2
    prompt owns (J1-J3) — **Done (65514c1)**: `SessionState.codexReportedRunningTurnId`;
    `startCodexTurnTracker` (baseline `subscribeToSessionEvents` at `installSessionState`, all
    versions, `DENY_ALL_*` handlers); `isCodexTurnRunning(sessionId)`; `trackCodexTurnStart/
    Completion` (also called from `prompt()`'s handler); `reportUnownedTurnState` (no-op if
    `v2PromptsInFlight.has` at that event, or v1); `stopReasonForUnownedTurn` (interrupted →
    cancelled, else end_turn); `AcpV2Connection.setTurnRunningCheck`. Tests
    `agent-initiated-turns-v2.test.ts` (4). Suite 871 / 26. TCK v1 24/0/3; v2 31/1 (RESUME-202)/5.
    **Orchestrator review found:** (1) bug — the permission `running` check ignores
    `v2PromptsInFlight`, so the plan-implementation permission (between turns) leaves the client in
    `requires_action` until idle; 4 permission snapshots lost `running` because the harness sends no
    `turn/started`; (2) unverified claim that the baseline tracker's `DENY_ALL_*` handlers match the
    old no-subscriber reply (runs on v1 too). → **fix slice 2(a2-v)-1f — Done (cb5f543,
    c073e63)**: `isSessionBusy(sessionId)` = `isCodexTurnRunning || v2PromptsInFlight.has`, now
    behind `setTurnRunningCheck` (reuse it in 2(c)); permission tests use `startRunningPrompt` (sends
    `turn/started`); 4 snapshots regain trailing `running`; plan-impl = running, requires_action,
    running, idle. `DENY_ALL_*` verified identical to the old no-handler defaults in
    `CodexAppServerClient.onRequest`; a second `subscribe()` only swaps `session.current` (baseline
    registration is a superset). New `pre-prompt-approvals-v1.test.ts` (5) pins v1 pre-prompt
    replies. Suite 876 / 26. TCK unchanged (v1 24/0/3; v2 31/1 RESUME-202/5). **Phase 4 docs:** the
    SDK client attributes any `idle` to a pending prompt (`acp.ts:2845-2851`), so a queued B's
    `readText()` ends at `idle(A)`/`idle(X)` — client limitation (no prompt id on `state_update`),
    mention in the AIR contract docs;
    **2(c)-1(i)** — **Done (ec550eb)**: `acquireTurnStartReservation(sessionId)` →
    `TurnStartReservation {wait, needsWait, release}` over `turnStartQueueTail` (per-session promise
    chain; `needsWait` from the previous slot's synchronous `settled` flag, so no extra tick without
    contention — needed by `approval-events`/`elicitation-events` tests). v1 `prompt()` is now a
    wrapper (self-acquires if no reservation passed) around `promptAfterReservation` (old body).
    `startNewTurnFromExternalPrompt` releases on `prompt()` settle (not on steer acceptance —
    deadlock otherwise). `promptV2` takes it before any side effect; releases after its idle.
    -32600 overlap rejection removed (closing check kept). Tests: 5 in `prompt-v2.test.ts`
    (FIFO, 3 queued, local command, A fails, same-tick G1) + 1 in `CodexAcpClient.test.ts` (goal
    continuation serialized behind a v2 prompt); `prompt-v2-overlap-rejected.json` deleted. Suite
    881 / 26. TCK v1 `-k "test_prompt or test_session or test_cancel"` 26/0/3; v2 31/1 (RESUME-202,
    confirmed pre-existing)/5.
    **2(c)-1(ii)** J8 + M2 adopt — **Done (d58869f)**: J8 needed no code (an unowned goal turn holds
    no reservation, so B's `turn/start` goes out at once). M2: `promptAfterReservation` snapshots
    `priorRunningTurnId = codexReportedRunningTurnId` synchronously before `sendPrompt`; if the
    `turn/start` response id equals it → `insertion.onTurnAdopted()` (new in `UserMessageInsertion`).
    `promptV2`: `inserted`/`turnWasAdopted` flags; adopted → `onInserted` resolves `{messageId}`
    without a second `running`; never-inserted guard is `!inserted`; an adopted-but-never-inserted
    prompt sends one compensating `idle`. Ownership: `v2PromptsInFlight.add` before dispatch already
    suppresses `reportUnownedTurnState`. A steer missed by the snapshot (goal turn starts inside the
    `turn/start` window) degrades to B sending its own `running` (a harmless duplicate) + one `idle`.
    Only the main dispatch path does M2 (not the plan-impl 2nd turn / local-command callback). 4
    tests in `prompt-v2.test.ts`. Suite 885 / 26. TCK unchanged (v1 26/0/3; v2 31/1 RESUME-202/5).
    No live probe.
    **2(c)-2(i)** `_session/steering` on v2 — **Done (b2b81d7)**: registered on the v2 chain (same
    parser/handler, after `session.prompt`). `performSteeringRequest` mints one `clientUserMessageId`
    per steer (v1 + v2; `CodexAcpClient.steerTurn` forwards it). Injected steers:
    `pendingSteerLandings` (keyed by minted id, registered before `turnSteer`, removed on throw) +
    `trackSteerLanding` hooked into both the baseline tracker and `prompt()`'s subscription → live
    `user_message_chunk` via `emitLiveSteerUserMessage` (v2 only); entries dropped when the session's
    turn completes (steer dropped by interrupt → nothing emitted). Fallback `startNewTurnFromSteering`
    passes a `UserMessageInsertion` through the new optional `insertion` param of
    `startNewTurnFromExternalPrompt` (`startGoalContinuationIfCurrent` unchanged); its turn gets
    `running`/`idle` via `reportUnownedTurnState`. v1 test changes: two `turnSteerSpy` expectations in
    `steer-events.test.ts` gained `clientUserMessageId: expect.any(String)`. `steering-v2.test.ts` (5)
    + 2 snapshots. Suite 890 / 26. TCK v1 `-k "test_prompt or test_session or test_cancel or
    test_extensibility"` 27/1 (SCHEMA-002, known advisory)/3; v2 `-k "... or test_state or
    test_extensibility"` 37/2/5: RESUME-202 (5b) + EXT-202 (known advisory, `capabilities.providers`
    placement → topic 1/10). **J11 on hold (user, 2026-09-24):** the user wants v1 client behavior preserved;
    remove C1 only if it fixes a bug with no v1-visible regression. The programmer was told not to do
    J11. → research `.agents/research/v2-goal-continuation-fallback-v1-impact.md` (in flight): when C1
    fires on 0.156.1, what v1 sees with/without it (esp. whether an unowned auto goal turn's output is
    rendered on v1 at all), harm today, and a recommendation.
    **User (2026-09-24): don't consider older Codex versions; always assume the latest Codex (currently
    the pinned 0.156.1).** This applies to all later decisions too. Original 2(c)-1 scope: shared per-session turn-start reservation (J4, J6 v1 too) + v2 queued prompts pending
    until insertion + J8 (goal turn running → `turn/start` directly) + M2 adopt (J9/J10);
    **2(c)-2** `_session/steering` minted id + `user_message` on landing, steering fallback through
    the reservation (with `running`/`idle`), remove C1 goal-continuation fallback (J11). Cancel
    interactions (drop queued prompts with -32800) → topic 3.
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

# Provider restart and fork: baseline turn tracking (topic 10 Q4/Q5 follow-up)

**Sources checked:** codex-acp `eugenethedev/acp-v2` @ 893716e (working tree, read-only);
openai/codex `rust-v0.156.1` (81e8e29, local copy `/tmp/codex-research/codex-0.156.1` plus `gh api`),
with `main` @ 8dd0a08 spot-checked for the fork-goal logic (unchanged); npm `@openai/codex` latest = 0.156.1;
live timings from `.agents/research/v2-agent-initiated-turns.md` "Live verification (Codex 0.156.1)".
**Method:** code reading of codex-acp and the Codex app-server source. No new live run and no new Vitest
repro were written (report-only role). A harness repro is feasible and sketched below.
**Confidence:** high for Q4 and Q5. Every link in the chain is deterministic code, plus one live
timing already measured (1c).

## Answer

**Q4: confirmed, both (i) and (ii), on v1 and v2.** The restart builds a fresh `CodexAcpClient`, which
has an empty subscription registry. It then re-resumes every session without subscribing anything, so
the new app-server client silently drops every thread notification until that session's next
`session/prompt` subscribes again. Codex 0.156.1 auto-starts a goal turn about 6 ms after `thread/resume`
whenever the goal is active, so with an active goal this is the expected case, not a corner case. A turn
that is still running when the restart starts (with an active goal there almost always is one, because
goal turns chain with gaps of about 8–25 ms) is not waited for. The old connection's outbound route is
removed before any teardown notification could be sent, so no `turn/completed` ever arrives. That leaves
`codexReportedRunningTurnId` stale and the v2 client stuck at `running`, which violates R13 (MUST). It
self-heals only when a later v2 prompt sends its own `idle`.

**Q5: refuted.** Codex copies a goal into a fork only when `thread/fork` has
`deferGoalContinuation: true`. That parameter is experimental, is absent from the generated types, and
codex-acp does not send it. Even with it, the fork does not auto-start a turn. The fork path does install
the baseline tracker, but after `thread/unsubscribe`, so the tracker is idle until the client loads the
fork, and that load reinstalls it anyway.

## Q4 evidence (codex-acp, v1 and v2 share this path)

| # | Fact | Citation |
|---|------|----------|
| 1 | `enqueueProviderUpdate` waits only for `activePrompts` (owned prompts, all sessions). Unowned or Codex-started turns are not waited for. | `src/CodexAcpServer.ts:1456-1460` |
| 2 | Restart builds a **new** `CodexAcpClient`/`CodexAppServerClient` over a new process. | `src/CodexAcpServer.ts:1551-1558` |
| 3 | Each client owns its own `CodexSubagentSubscriptions`, so old subscriptions (the baseline tracker, or the last prompt's "leftover" subscription) stay on the dead client. | `src/CodexAcpClient.ts:143`, `:936-948`; `src/subagents/CodexSubagentSubscriptions.ts:31-45` |
| 4 | The resume loop calls `replacement.resumeSession` only. There is no `installSessionState`/`startCodexTurnTracker`. | `src/CodexAcpServer.ts:1476-1492` (tracker: `:976`, `:991-1019`) |
| 5 | `CodexAppServerClient.notify` drops a thread-scoped notification when no handler is registered for it. Server requests with no handler get `cancel` / empty answers. | `src/CodexAppServerClient.ts:888-895`, `:220-272` |
| 6 | Codex 0.156.1: after `thread/resume` in a fresh app-server with a persisted active goal, `turn/started(G)` arrives about +6.4 ms after the resume response. The goal stays `active` across a mid-turn kill. | `.agents/research/v2-agent-initiated-turns.md:168` (case 1c); X3 at `:61` |
| 7 | The restart closes stdin (`:1540`) and force-kills after 2 s (`:1541-1546`). On EOF the app-server sends `OutboundControlEvent::Closed` (which removes the outbound route) **before** it runs `processor.connection_closed`, so interrupted-turn notifications are never written to codex-acp. | codex `app-server-transport/src/transport/stdio.rs:125-133`; `app-server/src/lib.rs:1137-1159`, `:918-919` |
| 8 | Unowned `running`/`idle` come only from `trackCodexTurnStart`/`trackCodexTurnCompletion`, which only a subscription calls. `codexReportedRunningTurnId` is cleared only by `turn/completed`. | `src/CodexAcpServer.ts:1043-1068` |
| 9 | A stale `codexReportedRunningTurnId` keeps `isSessionBusy` true, so a permission settled outside a turn re-sends `running` (4(a) check). | `src/CodexAcpServer.ts:475`, `:1026-1037` |
| 10 | M2 adoption compares the next prompt's turn id with the stale `priorRunningTurnId`. The invisible post-restart goal turn does not match, so a steered prompt is treated as owning that turn and the turn's earlier items are lost. | `src/CodexAcpServer.ts:3836`, `:3855-3857` |

Consequences:
- **(i) Confirmed.** After `providers/set`/`providers/disable` (only when sessions exist, `:1452`; for
  `disable`, only for `openai`, `:1440-1446`), Codex-started turns are not rendered on v1 or v2 and get
  no v2 `running`/`idle`. This holds until the session's next `session/prompt`. It applies to **every**
  live session, including ones that were prompted before, because the leftover prompt subscription is
  lost too. **v1-visible:** yes, v1 loses rendering of post-restart goal turns.
- **(ii) Confirmed.** An unowned turn (a goal turn, or a leftover turn) running at restart is killed
  with no `turn/completed`. v2: `running` with no `idle` (an R13 MUST violation), a stale
  `codexReportedRunningTurnId`, and any in-progress tool calls left open. It "ends" only when a later v2
  prompt's `idle` arrives (the SDK treats any `idle` as the pending prompt's stop). If the user never
  prompts again it stays `running` for good. v1: there is no state channel. The turn's rendering just
  stops mid-stream (this is pre-existing).

### In-flight `session/prompt` during a restart (v1 and v2 behave the same; v2 routes through `prompt()` → `promptAfterReservation`, `:3546-3562`)
- **A prompt already running when `providers/set` arrives:** it is not interrupted. `providers/set`
  blocks until **every** active prompt in every session completes (`:1456-1460`). That includes prompts
  parked on a permission request or on plan approval, and there is no timeout. Goal turns that follow
  the prompt's own turn are unowned, so they are not waited for (see (ii)).
- **A prompt arriving during the restart:** it waits at `:3576-3578` (after it takes the turn-start
  reservation). It then runs on the replacement client, and its own `subscribeToSessionEvents` (`:3675`)
  restores rendering for that session from then on. The race is closed: `this.providerUpdate` is set
  synchronously (`:1498`), and `trackActivePrompt` runs with no `await` after the check. On v2 the
  session is already in `v2PromptsInFlight` (`:3399`) while it waits, so unowned states are suppressed
  for it.
- **If the restart rejects** (an `AggregateError` from failed resumes, `:1494-1496`, or a restart
  failure), every prompt waiting at `:3577` rejects with that error. This applies to v1 and v2 and is
  pre-existing.

### Live check vs harness
- A live `/run-codex` check is **feasible but not needed** for the verdict. You would drive codex-acp
  over stdio with a probe like `/tmp/goalrace/probe.mjs`: `session/new` → `/goal NEVER…` → wait for an
  auto turn → `providers/disable {providerId:"openai"}` (this restarts with no gateway needed) → observe
  there is no `idle` and no rendered post-restart turn. It costs real tokens. Keep it for the Phase 4
  live pass alongside the G-render check.
- **Vitest repro (recommended regression test):** extend `providers.test.ts:196` style. Use a v2 fixture,
  and make `restartCodexClient` resolve to a second `createCodexMockTestFixture()` client whose
  `resumeSession` is mocked. (a) Send `turn/started` on the first fixture, call `setProvider`, then send
  nothing: assert there is no `idle` after `running`. (b) After `setProvider`, send
  `turn/started`/`item/*`/`turn/completed` through the **replacement** fixture's
  `sendServerNotification`: assert there are no `session/update`/`state_update` calls (non-conforming
  today). With the fix, (a) ends with exactly one `idle{stopReason:"cancelled"}` and (b) renders like
  `agent-initiated-turns-v2.test.ts`.

## Q4 fix sketch (reuses existing plumbing)

1. **Reinstall the baseline tracker for each resumed session, subscribing *before* `thread/resume`.**
   In the loop at `:1476`, call `this.startCodexTurnTracker(session)` before
   `replacement.resumeSession(...)`. `this.codexAcpClient` is already the replacement (`:1473`). The
   order matters: the auto goal turn starts about 6 ms after the resume response (fact 6), while
   `resumeSession` still awaits `model/list` after `thread/resume` (`src/CodexAcpClient.ts:589-598`).
   Registering the handler early is harmless, because nothing arrives until `thread/resume` subscribes
   the connection. On failure, drop it with `replacement`'s registry `clear` (or leave it, since the
   session stays broken either way). This also fixes M2 adoption after restart (fact 10).
   **v1-visible (additive):** v1 renders Codex-started turns after a restart. That is the same behavior
   G-render already introduced for new/resume on v1 (`agent-initiated-turns-v1.test.ts`), but it still
   needs a user OK.
2. **Close out a turn that was running at restart (v2 only, no v1 change).** Capture
   `const previousClient = this.codexAcpClient` before the swap. After `restartCodexClient()` resolves
   (the old process has exited), for each session:
   `await previousClient.waitForSessionNotifications(id)` (`src/CodexAcpClient.ts:962`) so nothing from
   the old stream is still queued. Then, if `codexReportedRunningTurnId !== null`, set it to `null` and
   call `reportUnownedTurnState(id, {state:"idle", stopReason:"cancelled"})` (`:1076-1090`; this matches
   `stopReasonForUnownedTurn("interrupted")`, `:299-300`). It is a no-op on v1 and while a v2 prompt is in
   flight, and in that case the prompt's own `idle` closes the state. Optional follow-up: have the
   session's current `CodexEventHandler` fail its open tool calls (not researched).
   - Alternative: `requestTurnInterrupt` before the restart, then await `turn/completed`. A live
     observation (n=1) shows an interrupt suppresses goal continuation and keeps the goal `active`
     (`v2-agent-initiated-turns.md:171`). The existing tracker would then send `idle` naturally. This
     costs an extra RPC and wait, touches v1 rendering (the interrupted turn completes visibly), and
     adds a timeout path. Not recommended over (2).
3. Do **not** extend the wait at `:1456` to unowned turns. With an active goal the thread never idles
   for more than about 25 ms, so `providers/set` would starve.

## Q5 evidence

| # | Fact | Citation |
|---|------|----------|
| 1 | Fork: `thread/fork` with `excludeTurns`, `lastTurnId`, `modelProvider`, and no `deferGoalContinuation`; then `thread/unsubscribe` on the new thread. The unsubscribe is intentional so that the client loads the fork first (commit 69ca755). | `src/SessionFork.ts:32-43` |
| 2 | Goal inheritance runs only if `defer_goal_continuation && rollout_path.is_some() && goals_enabled`. Otherwise `inherited_goal = false`, so no goal snapshot and no goal runtime on the fork. | codex `app-server/src/request_processors/thread_processor.rs:5190-5216`, `thread_fork_goal.rs:5-28` (same on `main`, `:5214`) |
| 3 | Parameter doc: "carry the source thread's current goal into the fork **without starting its initial automatic continuation**". It is `#[experimental]`. Upstream test: "deferred goal should not start a turn while forking". | codex `app-server-protocol/src/protocol/v2/thread.rs:621-626`; `app-server/tests/suite/v2/thread_fork.rs:895,1044` |
| 4 | Generated `ThreadForkParams` has no `deferGoalContinuation` field (experimental fields are not generated). | `src/app-server/v2/ThreadForkParams.ts:20` (ends at `excludeTurns?`) |
| 5 | Fork goes through `getOrCreateSession` → `installSessionState` → `startCodexTurnTracker`, the same as new/resume, but only after `forkSession` has already unsubscribed. So the tracker receives nothing until the client's `session/load`/`resume` re-subscribes, and that call reinstalls the tracker. | `src/CodexAcpServer.ts:841-845`, `:912`, `:974-977` |

Verdict: **refuted**. There is no goal on the fork, so there are no auto goal turns, nothing invisible,
and no tracker gap. It is not v1-visible. There is no fix to make. v2 `session/fork` is not wired on the
v2 chain yet (`src/AcpAgentRouter.ts:116` is v1), so v2 inherits this analysis when 10(e) wires it. If
a future change sends `deferGoalContinuation: true` (AIR "fork keeps goal"), the goal starts only at the
next explicit turn, which a prompt owns, so there is still no gap.

## Discrepancies
- None between ACP and Codex for these questions. The R13 MUST (`running` → `idle`) is the requirement
  the Q4(ii) behavior breaks (`v2-fork-providers-and-extension-methods.md:63`).

## Open questions (adjacent, not researched here)
1. **The G-render resume window (likely real, affects the normal resume path too).** `getOrCreateSession`
   installs the tracker (`:912`) only after `resumeSession` (`thread/resume` + `model/list`) and
   `getAuthStateForProvider` (`account/read`) return (`:830-860`). The auto goal turn's `turn/started`
   arrives about 6 ms after the resume response (case 1c), so it is probably dropped by `notify`. The
   likely symptom: the client gets `idle` with no preceding `running`, and early items are lost. Same
   fix idea: subscribe before `thread/resume`. The state.md G-render entry says this was not
   live-checked.
2. `TitleGenerator` keeps the pre-restart `CodexAppServerClient` (`:906-911`, `src/TitleGenerator.ts:34`),
   so title generation after a provider restart calls a dead connection.
3. A session open (`new`/`resume`/`load`/`fork`) that passed its `providerUpdate` check before
   `providers/set` arrived can still be running on the old client when the restart kills it.
4. With fix (1), the restart would also re-subscribe forks the client has not loaded yet (they are in
   `this.sessions`). This is harmless today because such a fork has no turns, but it goes against the
   intent of 69ca755.
5. `_goal/control` (`:666-670`) and `executeOrQueueSteeringRequest` do not await `providerUpdate` (compare `ASYNC_TASK_STOP` at `:655-656`); a goal set or steer during a restart hits the old or new client unpredictably (unverified hypothesis).

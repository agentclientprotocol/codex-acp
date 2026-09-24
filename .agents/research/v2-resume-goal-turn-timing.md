# Does the baseline turn tracker miss the auto goal turn after `session/resume` / `session/load`?

**Sources checked:** codex-acp @ `047bc01` (HEAD; runs used a `git archive` snapshot in
`/tmp/resumegoal/snap`, so the concurrent `AcpV2SessionUpdate.ts` edits were not involved); Codex
`codex-cli 0.156.1` (the repo's pinned `node_modules/@openai/codex`) run live; Codex source 0.156.1
at `/private/tmp/codex-research/codex-0.156.1/codex-rs`. The ACP spec/SDK were not re-checked. The only
spec point used (R13) is quoted from `v2-fork-providers-and-extension-methods.md:63`.
**Confidence:** high that the gap exists and what it does when it is lost (code plus a live repro). Medium
on how often it is lost in the field: with a warm model cache and a non-OpenAI provider, the tracker won
all 4 unmodified live runs, by only about 5–27 ms.

## Answer
**Confirmed. It is a real race, but on a fast machine the tracker usually wins it narrowly.**
codex-acp registers the thread's notification handler only in `installSessionState` →
`startCodexTurnTracker`. That happens after `thread/resume` has returned **and** after `model/list`,
`account/read` (OpenAI provider only) and, on load paths, the history read (`thread/turns/list` /
`thread/read`). Codex's goal extension starts the goal turn on the resumed idle thread about 6–8 ms
after the resume response. `CodexAppServerClient.notify` drops thread-scoped notifications that have no
handler, and nothing buffers them. In unmodified live runs the tracker was installed 1.5–2.6 ms after
the resume response and won all 4 times. With 30 ms of latency injected after `model/list` (standing in
for an uncached/online `model/list`, an `account/read`, or a long history read), it lost both times:
`turn/started` was dropped, **v2 got `idle{end_turn}` with no `running`**, and on both protocols the turn
rendered only from the moment the handler was installed. All four normal open paths are affected: v2
`session/resume` (with and without `replayFrom`), v1 `session/resume`, and v1 `session/load`.

## Evidence

### Code
| # | Fact | Citation (codex-acp) |
|---|------|------|
| 1 | `resumeSession`/`loadSession` await `thread/resume` and then `model/list`. `loadSession` also awaits `thread/turns/list`/`thread/read` in between. | `src/CodexAcpClient.ts:590-598`, `:630-650` |
| 2 | `getOrCreateSession` then awaits `getAuthStateForProvider` (`account/read` when the provider is `openai`/null) before `installSessionState`. | `src/CodexAcpServer.ts:830-860`, `:912`, `:937-951` |
| 3 | `getOrCreateSessionWithHistory` (v1 load, and v2 resume with `replayFrom:start`) has the same order: `loadSession` → auth → `installSessionState`. | `src/CodexAcpServer.ts:2338-2361`, `:2412` |
| 4 | The handler is registered only by the tracker's `subscribeToSessionEvents` → `CodexSubagentSubscriptions.subscribe` → `client.onServerNotification`. | `src/CodexAcpServer.ts:973-1019`; `src/subagents/CodexSubagentSubscriptions.ts:31-45` |
| 5 | **No buffering.** `notify` calls the thread's handler if there is one, and otherwise returns silently. The global `record*` hooks run for every notification, but they only feed captures somebody registered beforehand (`threadStatusCaptures`, `turnRoutingCaptures`, …), and none are registered during resume. | `src/CodexAppServerClient.ts:887-900`, `:190-214`, `:985-1029` |
| 6 | `session/close` clears the root handler (`clearThreadHandlers` + `subagents.clear`), so a resume in the same process after a close has the same gap as a fresh process. Whether Codex unloads the thread on `thread/unsubscribe` and re-runs continuation on the next resume is an unverified hypothesis. | `src/CodexAcpClient.ts:694-700` |
| 7 | `trackCodexTurnCompletion` sends `idle` for every unowned `turn/completed`, whether or not `running` was sent. That is why the lost race shows up as a lone `idle`. | `src/CodexAcpServer.ts:1057-1068` |
| 8 | Codex starts the goal turn from the goal extension's `on_thread_idle` → `continue_if_idle` → `start_turn_if_idle`, holding a goal-state permit. `on_thread_resume` only restores the runtime. | codex `ext/goal/src/extension.rs:165-193`, `ext/goal/src/runtime.rs:425-485` |
| 9 | `model/list` uses `RefreshStrategy::OnlineIfUncached` with a 300 s cache TTL, so a stale cache means a network round trip before the tracker can install (source-inferred, not observed). | codex `app-server/src/request_processors/catalog_processor.rs:258`, `models-manager/src/manager.rs:32` |

### Live runs (scratch driver `/tmp/resumegoal/snap/run-resume.ts`, logs in `/tmp/resumegoal/*.txt`)
Each thread was prepared with `/tmp/goalrace/probe.mjs resume-prep`: an active goal is persisted, then the
app-server is SIGKILLed. The thread was then opened through `CodexAcpServer` against a fresh app-server.
`handler` is `notificationHandlers.has(threadId)` at dispatch time. User config: `model_provider = 'wire'`,
so there is no second `account/read`, and `model/list` answered in about 1 ms.

| Run | resume resp → handler installed | resume resp → `turn/started` | Outcome |
|---|---|---|---|
| v2 resume | +~1.5 ms | +7.0 ms | won. `running` … `idle` |
| v1 resume | +~1.5 ms | +8.3 ms | won |
| v2 resume `replayFrom:start` | +~2.5 ms | +12.5 ms | won |
| v1 load | +~2.6 ms | +29.7 ms | won |
| v2 resume, +30 ms after `model/list` | +~33 ms | +6.4 ms | **lost** |
| v1 resume, +30 ms after `model/list` | +~33 ms | +5.5 ms | **lost** |

In every run, `thread/status/changed{idle}` and `thread/goal/updated{active,turnId:null}` arrived with no
handler and were dropped. That is harmless, because `publishCurrentGoal*` re-reads the goal with
`thread/goal/get`.

Lost race, v2 (`v2-resume-delay30.txt`):
```
 102.6 CODEX-RESP thread/resume
 109.0 CODEX turn/started 01a0d5c4-8616-… handler:false      <- dropped
 135.7 MARK resume response                                  (tracker installed just before)
3030.1 ACP agent_message_chunk "GO" …                        (rendered: arrived after install)
7287.1 CODEX turn/completed handler:true
7287.8 ACP state_update idle end_turn                        <- idle with no running
```
Won race, v2 (`v2-resume.txt`): `139.2` resume resp → `146.2 ACP state_update running` → `146.2 CODEX
turn/started handler:true` → … → `8537.0 ACP state_update idle end_turn`.

Side observation: in the won runs, `turn/started` arrived about 2–3 ms after the `thread/goal/get` response
every time. This looks like both requests taking the goal-state permit (fact 8), which delays continuation
while `thread/goal/get` is in flight. It does not make the race safe: `thread/goal/get` is sent only
*after* the tracker is installed, and the direct probe (no `goal/get`) started the turn at +6.4 ms
(`v2-agent-initiated-turns.md:168`).

## How the client sees it (when the race is lost)
- **v2:** no `running` for the goal turn, then a lone `idle{stopReason:"end_turn"}` at its end. This breaks
  the R13 MUST (`running` when foreground work starts). `codexReportedRunningTurnId` stays null during the
  turn, so `isSessionBusy` is false. As a result, approvals in that turn get no
  `requires_action`/`running` bracket (`src/CodexAcpServer.ts:474-475`, `:1026-1037`), and a prompt sent
  mid-turn snapshots `priorRunningTurnId = null` and misses M2 steer adoption (`:3833-3836`).
- **Both protocols:** anything the turn emits before install is lost (in the repro that was only
  `turn/started`). If install is delayed past the first item, as with a slow history read on load or a
  cold `model/list`, the start of the agent's output is missing.
- **Load paths (v1 `session/load`, v2 `replayFrom:start`):** once installed, the tracker renders live
  goal-turn frames immediately, while `streamThreadHistory` has not replayed history yet (`:2412` vs
  `:1182`). In the won runs the live turn started only just after the replay finished (v2-load: replay
  ended at 129.1, `turn/started` at 130.0). A slower replay would interleave live frames with history.

## Fix sketch (reuses existing plumbing)
Register the subscription **before `thread/resume`**, the same ordering as the provider-restart fix
(`v2-provider-restart-and-fork-tracking.md:91-98`). Because `SessionState` doesn't exist yet, make the
tracker wait on it. The per-session notification queue already serializes handler calls
(`enqueueSessionNotification`, `src/CodexAcpClient.ts:945-947`, `:973-990`), so it doubles as the
buffer:

1. Split `startCodexTurnTracker(sessionState)` into
   `startCodexTurnTracker(sessionId, ready: Promise<SessionState | null>)`. Its event handler does
   `const state = await ready; if (!state) return;`, builds the `CodexEventHandler` lazily once (memoized),
   and then runs the existing four calls unchanged. The first event blocks the queue until `ready`
   settles, so every later event is held in order. Nothing is dropped and nothing is reordered.
2. In `getOrCreateSession` (resume) and `getOrCreateSessionWithHistory`, create a deferred and call
   `startCodexTurnTracker(id, deferred.promise)` right before `codexAcpClient.resumeSession`/`loadSession`.
   Registering early is harmless, because nothing arrives until `thread/resume` subscribes the connection.
   `installSessionState` resolves the deferred instead of calling the tracker (new/fork keep today's
   immediate path, with an already-resolved promise).
3. **Always settle the deferred** (`null`) in the existing failure paths (`resumeSubscribed`/`subscribed`
   catch blocks, `closeStaleSessionOpen`, and a `finally`). An unsettled promise would wedge that
   session id's queue permanently. The queue is keyed by session id and shared with later opens and with
   `waitForSessionNotifications` callers.
4. On the two load paths, resolve the deferred **after** `streamThreadHistory` (`:1182`) instead of at
   install, so live goal-turn frames follow the replayed history.

**v1-visible changes:** v1 no longer loses the opening items of a Codex-started turn after
resume/load, and on load, live frames now always come after the replay. Both are additive or
ordering-only, and no new update types appear on v1 (`state_update` stays v2-only via
`reportUnownedTurnState`, `:1075-1080`). Same scope as G-render's v1 change. It needs the same user OK
as the provider-restart item.

## Testability notes (Vitest, `v2-prompt-harness.ts`)
The existing resume test (`agent-initiated-turns-v2.test.ts:87-106`) does not cover this. `connectSession`
already did `session/new` on `thread-1`, so a handler exists, and it emits only after the resume response.
Repro:
- Resume a **different** id (`thread-2`). Set `setCodexResponse("thread/resume", …)` to return
  `thread.id = "thread-2"`.
- Set `setCodexResponse("model/list", async () => { client.emit(turnStarted-with-threadId-thread-2);
  client.emit(agentMessageDelta-for-thread-2); return codexResponse("model/list"); })`. This emits in the
  window after `thread/resume` and before install.
- `await client.request("session/resume", {sessionId: "thread-2", cwd})`, then emit `turn/completed`
  for `thread-2` and `settle()`.
- Today: v2 `stateUpdates` = `[{idle,end_turn}]`, with 0 agent chunks. After the fix: `[{running},
  {idle,end_turn}]` and 1 chunk. For v1 (`connectSession(1)`), assert the chunk count goes from 0 to 1.
  The harness helpers hard-code `threadId: sessionId`, so a small local override is needed.
- For load ordering: override `thread/resume` with a non-null `turnsBackwardsCursor`, and make
  `thread/turns/list` return one turn. Emit the live `turn/started` + delta from the `model/list` override
  and assert that every replayed update precedes the live `running`/chunk.

## Discrepancies
None between sources. The mismatch is internal: Codex starts the turn about 6 ms after `thread/resume`,
while codex-acp subscribes only after more round trips.

## Open questions
1. Re-resuming a session that is already open in this process (no close) does not drop anything. The old
   handler stays registered, but events in the window go to the **old** `SessionState`'s subscription
   until `subscribe` swaps `current`. The new state then starts with `codexReportedRunningTurnId = null`
   even though a turn is running. Not investigated.
2. Does `thread/unsubscribe` (close) unload the thread so that the next resume re-runs goal continuation?
   This decides whether fact 6 matters in practice.
3. On v2 `session/new`, the same install-after-RPC order exists (`thread/start` → `model/list`), but a new
   thread has no goal, so no auto turn is expected. Not live-checked (state.md G-render asks for it).

# Does removing codex-acp's C1 goal-continuation fallback change what v1 clients see?

**Sources checked:** codex-acp @ `8ba7568` (HEAD, read via `git show`/`git archive`, not the working tree); Codex `codex-cli 0.156.1` (`node_modules/@openai/codex`), observed live on 2026-09-24 with a scratch ACP v1 client driving codex-acp HEAD (`/tmp/c1probe/client.mjs`, adapter logs `/tmp/c1probe/logs-*/app-server.log`, parsed by `/tmp/c1probe/summ.mjs`) and a raw app-server probe (`/tmp/c1probe/rawstatus.mjs`). "noC1" runs used a scratch copy (`/tmp/c1head-noc1`) where `startGoalContinuationIfCurrent` returns right away. I did not consult the ACP spec or SDK: `_session/goal` is a codex-acp extension method, and ACP defines no semantics for it.
**Confidence:** high for when C1 fires and for the v1 before/after (seen live, n = 3 with C1 and n = 1 without, consistent with the code). Medium for the race outcome, because C1's `turn/start` won 3 out of 3 times, and I never saw the steered variant live.

## Answer
- **When C1 fires on 0.156.1.** `runGoalSet` returns `null` in two cases.
  - The goal comes back non-`active` (e.g. `budgetLimited`). C1 then checks `getGoal` and does nothing.
  - No turn-scoped notification arrives within 1 s of the matching `thread/goal/updated`, and the thread never goes `active`. This happens when the goal is set **during a busy turn that is silent for more than 1 s**: model latency before the first item, or a quiet tool call such as `sleep`. It is common. It is **not** dead code. I reproduced it 3 out of 3 times.
  - On an idle thread, after resuming a paused or complete goal, Codex starts the turn itself 14–25 ms later, so C1 never fires.
- **What v1 sees in that case, with C1.** Prompt A runs to completion. `_session/goal` resolves `{}` only after A ends, when C1's turn starts. The goal turn's `agent_message_chunk`s and goal `session_info_update`s are rendered.
- **Without C1.** The same goal output and goal updates are rendered by prompt A's leftover subscription handler. The only differences:
  - `_session/goal` resolves about 1 s after the request, instead of after A ends;
  - no phantom **"Continue working toward the active goal."** user message goes into the thread. With C1, that message is persisted and **replayed to v1 on `session/load` as a `user_message_chunk`** (observed).
- **Harm today:** no duplicate turn and no duplicate output. Codex drops its own continuation because the thread is busy. The harm is that phantom message: it is extra model input, and it shows up in history.
- **Verdict:** (c) mixed, leaning (a). **Recommendation:** remove C1.
  - The only v1-visible regression is an earlier `{}` for an extension request, in a narrow case.
  - If exact response timing must be preserved, use the passive-wait guard below. It does not send `turn/start`.
- **Separate finding:** with or without C1, a Codex-started goal turn on a session where no `session/prompt` has run yet is **invisible to v1**. That covers `_session/goal set` right after `session/new`/`load`, and X3 after resume. The baseline tracker only tracks turn state. C1 does not fire in this case, so its removal neither causes nor fixes this.

## Requirements
There are no ACP-spec tiers here: `_session/goal` is a codex-acp extension. This table lists codex-acp behavioural invariants that the user requires to be preserved.

| # | Invariant (v1) | Tier | Citation |
|---|---|---|---|
| 1 | Goal-turn output (agent chunks, tool calls) keeps rendering live wherever it renders today | user requirement | `CodexAcpServer.ts:3513-3553`, `CodexEventHandler.ts:312-316` |
| 2 | Goal `session_info_update{_meta.goal}` updates keep flowing | user requirement | `CodexEventHandler.ts:651-652`, `CodexAcpServer.ts:2282-2301` |
| 3 | `_session/goal` still returns `{}`. Its timing may change only where noted | user requirement | `CodexAcpServer.ts:651-708` |
| 4 | No turn is started for a non-active goal | existing (C1 has it via `canStart`; the slash fallback lacks it) | `CodexAcpServer.ts:2053-2061`; `CodexCommands.ts:452-455` |

## Details

### 1. What `runGoalSet` waits for (`CodexAppServerClient.ts:393-484`, grace `:150` = 1000 ms)
- It sends `thread/goal/set`. `expectedGoal` is taken from the response (`:452-455`). A `thread/goal/updated` counts as the matching update only if it equals `expectedGoal` on objective, status, budget and `updatedAt` (`:432-438`, `goalsMatch` `:1306-1312`).
- If the response status is not `active`: wait for the matching update, then **return `null`** (`:460-463`).
- **Routing.** After the matching update, the **first notification of any kind that carries a `turnId` or `turn.id`** on the thread becomes the "goal turn" (`captureTurnRoutings` `:424-431`, `extractTurnRouting` `:1322-1336`). `runGoalSet` then waits for **that turn's completion** (`:464-476`). On a busy thread this is the *running* turn, e.g. the user's prompt A: its `hook/*`, item or `turn/completed` notifications.
- **The `null` timer** (`createNoGoalTurnStartedPromise` `:509-570`):
  - it starts 1000 ms after the matching update;
  - `thread/status/changed{active}` cancels it;
  - `active` followed by a non-active status also resolves `null`.
  - On an already-busy thread there is no status change, so **only a routed notification within 1 s prevents `null`**.
- **Live gaps inside a normal turn.** Turn-scoped notifications stop for 1.9–3.4 s during model sampling, and for about 3.0 s during `sleep 3/4` (`/tmp/goalrace/events-{afterturn,race-*}.json`; I measured the gaps with a script).

**When C1 fires on 0.156.1** (C1 = `extMethod` `set`/`resume` → `startGoalContinuationIfCurrent`, `CodexAcpServer.ts:659-703,2042-2062`):

| Case | `runGoalSet` | C1 | Evidence |
|---|---|---|---|
| Idle thread, set or resume (active / paused / complete goal) | Codex starts the goal turn 4–25 ms later → routed → returns that turn's completion | no | live: `out-idle-fresh.txt`, `out-idle-after-prompt.txt`, `rawstatus statuses` steps 1, 2, 4 (auto turn 14 / 22 ms) |
| Busy turn, and a turn notification arrives within 1 s | the *running* turn is routed → waits for it | no | `out-afterturn.txt` in `/tmp/goalrace` (hook/started 290 ms after) |
| **Busy turn, silent > 1 s** | `null` after 1 s | **yes → starts a turn** | live `out-busy*.txt` 3/3 (`Goal continuation started a new turn` in the logs) |
| Budget exhausted: set or resume returns `budgetLimited` (codex-acp's `set` sends no `tokenBudget`, so the old budget and usage carry over) | `null` right away | fires, but `canStart` sees `getGoal` ≠ active → **no turn** | live `rawstatus statuses` steps 6–8, `budgetset` step c |
| Paused or complete goal + `resume` | Codex sets it `active` and starts a turn | no | steps 2, 4 |
| Slow Codex start > 1 s on an idle thread | would return `null` → C1 would fire and race Codex | would fire | hypothesis; never observed (all starts ≤ 25 ms) |
| Older Codex | out of scope per user | — | — |

- **`resume` vs `set`:** the same mechanism. `resume` also publishes the goal snapshot first (`:691-693`).
- **The `/goal` slash-command fallback is a separate call site with the same trigger.**
  - `runGoalCommand` → `setGoal`/`resumeGoal` → `createGoalCommandResult(null)` → `{handled:false, prompt: GOAL_CONTINUATION_PROMPT}` (`CodexCommands.ts:390-455`).
  - `prompt()` then sends it as a normal `turn/start` inside the same prompt (`CodexAcpServer.ts:3644-3656`).
  - It has **no `canStart` status check**. `/goal <objective>` or `/goal resume` on a `budgetLimited` goal therefore starts a real model turn for a goal that Codex has stopped. That is a bug (reasoned from the code plus the live `budgetLimited` response; the turn itself was not run).
  - It is not named in J11 (`state.md:507,513`, "C1 … `_session/goal`"). The orchestrator should scope it explicitly.

### 2. What v1 renders: the subscription model
- `installSessionState` installs the **baseline tracker** at session creation (`CodexAcpServer.ts:989-1016`, from 65514c1). It only runs `trackCodexTurnStart`, `trackSteerLanding` and `trackCodexTurnCompletion`, which are v2 `state_update` and bookkeeping. It **renders no items**, and it denies approvals.
- Each `prompt()` subscribes a rendering handler (`:3513-3553`). `CodexSubagentSubscriptions.subscribe` only swaps `session.current` (`subagents/CodexSubagentSubscriptions.ts:31-35`), and the one app-server listener dispatches to `session.current` (`:44`).
- When the prompt ends, that handler **stays current**. With `promptNotificationsActive=false`, it calls `handleSessionScopedNotification` → `handleNotification` (`CodexAcpServer.ts:3532-3536`; `CodexEventHandler.ts:312-316,402-445`). So it keeps rendering items from later, unowned turns. `dispose()` only stops diffs and plans (`CodexEventHandler.ts:503-521`).
- On `turn/started` it sets `currentTurnId ??=` (`:565-570`). That is what lets v1 `session/cancel` find an unowned turn (`CodexAcpServer.ts:3223-3228`).
- **Consequence:** a Codex auto-started goal turn is rendered to v1 **if and only if some `prompt()` has run in this process for the session**.
  - Seen live, rendered: `out-busy-noc1.txt` shows the GOALOK chunks and goal `complete` after A, with no C1.
  - Seen live, invisible: `out-idle-fresh.txt`. The Codex log shows the goal turn producing "GOALOK" twice, yet v1 receives **zero** `session/update`s, not even the goal `_meta`. `_session/goal` returns `{}` after 7.7 s.

### v1 timelines (busy case: prompt A = `sleep 4`, `_session/goal set` at the `tool_call`)

| | With C1 (HEAD, 3 runs) | Without C1 (1 run) |
|---|---|---|
| goal `_meta` active | +4 ms | +4 ms |
| `_session/goal` → `{}` | **after A's `session/prompt` response** (+28 to +42 ms after A's `turn/completed`) | **+1.0 s after the request** (during A's sleep) |
| A's output and response | unchanged | unchanged |
| Goal turn | C1's own turn with input "Continue working toward the active goal." (not rendered live on v1: `CodexEventHandler.ts:869,944` drop `userMessage`). Codex started **no** turn of its own (0/3) | Codex turn 17 ms after A's `turn/completed` |
| Goal turn output on v1 | GOALOK chunks, goal `complete` | same |
| `session/load` replay | …"AOK", **`user_message_chunk` "Continue working toward the active goal."**, "GOALOK…" | …"AOK" "GOALOK…" (no phantom user message) |
| Model input | an extra user instruction | goal context only |

### 3. Harm today
- **Observed (3/3).** C1's `turn/start` lands 28–42 ms after `turn/completed(A)` and gets **its own** turn; Codex never started a competing one.
  - Without C1, Codex started at 17 ms. My hypothesis is that codex-acp's `thread/goal/get` (`canStart`) and `skills/list forceReload` (`CodexAcpClient.ts:886-901`), sent right after A, delay `continue_if_idle` until C1's `turn/start` wins. I did not verify this.
  - There was no second turn, no duplicate output, and no prompt ending early.
- **Not observed, reasoned from code and the earlier race data.** Suppose C1's `turn/start` reaches a thread where Codex's goal turn is already running. That happens when the running turn is an *unowned* Codex goal turn, because the reservation (`:3105-3121`) waits only for codex-acp prompts. Then:
  - the `turn/start` is **steered**. The phantom message is injected mid-turn, and a later landing adds an extra sampling round (`v2-agent-initiated-turns.md` §2);
  - C1's `prompt()` adopts that turn from the `turn/start` response id and swaps the rendering handler. There is still one current handler, so output is not duplicated;
  - `_session/goal` resolves right away.
- **Net harm:** a phantom user message in history (visible on reload) and in the model context, and on a steer an extra model round. `_session/goal` is also held open behind the running prompt, though that is the same as the routed path, which also waits for A.

### 4. Verdict and recommendation
- **(c) mixed, leaning (a).**
  - Removing C1 fixes the phantom user message (visible to v1 on `session/load`) and the extra model input.
  - The goal turn's live output, tool calls and goal updates stay the same: in every case where C1 fires, a prompt handler is already current, because C1 fires only on a busy thread.
  - The one v1-visible change is **`_session/goal` returning `{}` earlier** (about 1 s after the request instead of after the running prompt). This only happens in the silent-busy case.
  - Edge case (hypothesis): a session loaded with an active goal (X3), no prompt yet, and a silent running goal turn. Here C1 would have made later output visible by adopting that turn.
- **Minimal change:** in `extMethod` `set`/`resume`, drop the `startGoalContinuationIfCurrent` call when `turnCompleted === null` (`CodexAcpServer.ts:670-677,697-703`) and return `{}`. Delete `startGoalContinuationIfCurrent` (`:2042-2062`).
- **If the user wants `_session/goal` timing preserved exactly:** keep a guard, but make it **passive**. When the result is `null` and the goal is `active`, wait through the turn-start reservation for the next Codex `turn/started` on the thread, or give up after 1 s of idle. Never send `turn/start`. I recommend the plain removal unless the user considers the earlier `{}` a regression.
- **Slash fallback (decide separately, J11b):** make `createGoalCommandResult(null)` return `{handled: true}` (`CodexCommands.ts:452-455`). That fixes the `budgetLimited` turn bug and the steer on a busy unowned goal turn.
  - The v1-visible change: `/goal …` on a stopped goal ends right away with `end_turn` and runs no model turn.
  - In the busy case, Codex's own turn keeps rendering via the `/goal` prompt's leftover handler.

## Testability notes
- **C1 removal.** Mock `setGoal` → `null`, with `onGoalSet(active goal)` and `getGoal` → active. Assert `extMethod` resolves `{}` and `turnStartSpy` is never called.
  - Replace or retarget these tests: `CodexAcpClient.test.ts:2835, 2881, 2946, 2969, 3020, 3287`.
  - Keep `:3062` (routed turn, no duplicate) and `:3178` (no hang).
- **v1 rendering of an unowned goal turn.** Run a v1 `prompt()` to completion, then emit `turn/started` + `item/agentMessage/delta` + `turn/completed` for a new turn id. Snapshot: `agent_message_chunk` is present.
  - The same sequence on a fresh session with no prompt shows no chunk. That documents the gap in Open question 1.
- **Phantom message.** Unit tests cannot observe the `session/load` replay without a real Codex. The observable proxy is "no `turn/start` with `GOAL_CONTINUATION_PROMPT` input".
- **Slash fallback.** Mock `setGoal` → `null` with a goal whose status is `budgetLimited`. Assert no second `turn/start` and `stopReason: "end_turn"`. Also update the `prompt-v2.test.ts:814` / `data/prompt-v2-goal-resume-continuation.json` snapshot.
- The race timing (whether C1 wins or gets steered) cannot be unit-tested. It needs a live probe.

## Discrepancies
- The earlier report said C1 is "effectively dead on 0.156.1" (`v2-agent-initiated-turns.md:176`). That holds only for idle-thread set or resume. C1 fires reliably when the goal is set during a busy turn that is silent for more than 1 s, which is typical.
- `runGoalSet` treats the first turn-scoped notification of a *running user turn* as "the goal turn" (`CodexAppServerClient.ts:424-431`). So in the routed busy case, `_session/goal` waits for the user's turn, not for a goal turn.
- `_session/goal` timing is inconsistent today:
  - the routed path returns at goal-turn **completion** (idle: 7.7 s / 8.2 s live);
  - C1 returns at goal-turn **start**;
  - the budget path returns right away.

## Open questions
1. **Pre-existing v1 gap (route to topic 5 / J5 owner).** A Codex-started goal turn on a session with no prior `prompt()` is invisible on v1. This covers `_session/goal set` right after `session/new`/`session/load`, and X3 after load or resume with an active goal. The baseline tracker should render, or install a session-scoped `CodexEventHandler`. This is independent of C1.
2. Should v1 `session/cancel` of an unowned goal turn be guaranteed? It depends on the leftover handler setting `currentTurnId` after `prompt()` cleanup nulls it (`CodexAcpServer.ts:3971` vs `CodexEventHandler.ts:569`). That is racy, and on a fresh session the baseline tracker never sets it.
3. Why Codex skipped or delayed its own continuation when C1 sent `goal/get` + `skills/list` (0/3 auto-starts within 42 ms, versus 17 ms without). Is `skills/list forceReload` holding a thread lock?
4. The user must decide whether an earlier `_session/goal` `{}` counts as a v1 regression, which would mean passive-wait instead of plain removal. The user must also decide whether the slash fallback falls under J11.

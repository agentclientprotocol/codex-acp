# Q3: Agent-initiated turns on ACP v2: which turns start with no v2 `session/prompt` pending, what ACP v2 allows or requires for them, and how they interact with the 2(c) queue

**Sources checked:**
- ACP spec `agent-client-protocol` @ `5b45096` (2026-09-24; `pull --ff-only` was up to date on `main`). Files: stable `docs/protocol/v2/*` (the `draft/` copy of `prompt-lifecycle.mdx` differs only in link paths), `docs/rfds/v2/prompt.mdx`, `docs/rfds/v2/overview.mdx`, `schema/v2/schema.json`.
- ACP TypeScript SDK `acp-typescript-sdk` @ `69fda37` (2026-09-23, up to date).
- ACP TCK `acp-tck` @ `64b62b6` (2026-09-24): `src/tck/v2/requirements.py`.
- Codex `openai/codex` @ `rust-v0.156.1` (the installed version). I read single files through `gh api` into `/tmp/q3-*` and cloned nothing. **Everything I cite from Codex was read in the source only; I did not observe it live.**
- codex-acp @ `1fa6a1e` (branch `eugenethedev/acp-v2`), plus `.agents/state.md` and the four prior research files.

**Confidence:** high on the codex-acp caller analysis and on what the spec says. Medium on the Codex runtime goal-continuation behaviour, which I read in the source but did not observe live. Several recommendations are judgment calls because the spec leaves them open; they are listed as such.

## Answer

1. `startNewTurnFromExternalPrompt` has exactly **two** callers: goal continuation from `_session/goal` (`set`/`resume`), and the steering fallback in `_session/steering`. In both cases the pending client request is the extension request itself, not a `session/prompt`, and it resolves as soon as the turn *starts*. Neither extension method is registered on the v2 chain yet (`AcpAgentRouter.ts:137-151`), so on v2 today this code cannot be reached. **I also found agent-initiated turns that never pass through that function:** Codex's own goal runtime starts turns by itself. It does so after `thread/goal/set` when the thread is idle, after **every** turn that ends while a goal is active, and after `thread/resume`. These turns are reachable on v2 today (a `/goal` prompt is enough), and nothing in codex-acp tracks them.
2. The spec explicitly anticipates agent-initiated work (RFD `prompt.mdx:13,202,300`; `migration.mdx:321`). The `running`/`idle` MUSTs are tied to foreground work, not to a prompt (`prompt-lifecycle.mdx:188,377`). So a `running`…`idle` pair with no prompt pending is **allowed**, and it is **required** if the turn counts as foreground work. The spec never defines "foreground", so that classification is our call; I recommend treating these turns as foreground. A `user_message` without a prompt is **allowed** but not required (`prompt-lifecycle.mdx:19,39`; RFD `prompt.mdx:74,167`). The SDK client tolerates both (`src/v2/acp.test.ts:983-1061`).
3. Under 2(c), a v2 prompt that arrives during such a turn **must be queued**, and its `turn/start` must be held back until that turn's `turn/completed`. The "busy" predicate therefore has to count these turns. The current check only partly does: it counts the internal `prompt()` once that call has registered, but it misses a pre-registration window and misses every Codex-runtime turn.
4. The approved steering decision (#6: emit the `user_message` when the steer lands) covers the user message in the new-turn case too. When steering *starts* a turn, that turn also needs its own `running`…`idle`, and the start has to go through the same per-session gate as queued prompts.

## Requirements

| # | Requirement | Tier | Citation |
|---|---|---|---|
| R1 | When foreground work starts or resumes, send `state_update running`. The rule is not conditioned on a prompt. | MUST | spec `docs/protocol/v2/prompt-lifecycle.mdx:188`; `migration.mdx:278` |
| R2 | When ready to process a new prompt, send `idle`, with a `stopReason` if the transition ends foreground work. | MUST (the schema says SHOULD for `stopReason`; see the queued-prompt research, D1) | `prompt-lifecycle.mdx:377,491`; `migration.mdx:282` |
| R3 | Session updates are not limited to prompt-driven foreground work. Background activity may emit updates while `idle`, and they do not change the state. | MAY | `prompt-lifecycle.mdx:39,526`; `migration.mdx:311` |
| R4 | "Foreground" and "background" are never defined. | **silent** | `prompt-lifecycle.mdx:514-526` (definitions only) |
| R5 | Agent-initiated turns are an intended use: "allow the agent to initiate an interaction in a session rather than requiring it to wait for a user prompt"; "Running … Important now that turns aren't tied necessarily to prompts"; "agents may produce output without a prompt … `state_update` remains session-scoped". | Design intent (RFD, a proposal, not normative) | RFD `docs/rfds/v2/prompt.mdx:13,202,300`; normative echo in `migration.mdx:321` ("future agent-initiated or queued work") |
| R6 | A `user_message` "creates or updates a user message identified by `messageId`". Nothing ties it to a `session/prompt`. Messages without a prompt response exist ("Imported or non-ACP messages … without a corresponding prompt response"; other clients see messages with no request). | MAY | `prompt-lifecycle.mdx:19`; RFD `prompt.mdx:74,167` |
| R7 | The insertion MUSTs (response + `user_message`, same id) apply only to `session/prompt`. | MUST (prompt only); silent otherwise | `prompt-lifecycle.mdx:139,158` |
| R8 | Distinct inserted submissions get distinct ids. A replayed retained *prompt* message reuses its id. | MUST | `prompt-lifecycle.mdx:180,182`; `session-setup.mdx:198-200` |
| R9 | `session/cancel` covers "active session work". After aborting, the agent sends `idle`/`cancelled` after all other updates for that work. | MUST | `prompt-lifecycle.mdx:530,548,559` |
| R10 | Queueing and steering are out of scope. | **silent** | RFD `prompt.mdx:86,279`; RFD `overview.mdx:115` |
| R11 | TCK ACP-STATE-201/202/203 are scoped to a `run_prompt` (a prompted session): an `idle`+`stopReason` needs an earlier `running`, and the idle that ends an observed `running` carries a `stopReason`. The TCK drives no goal or steering, so it never sees these turns. | CAPABILITY (`capabilities.session`) | `acp-tck/src/tck/v2/requirements.py:210-259` |
| R12 | TCK ACP-CANCEL-202: after `idle`/`cancelled`, no further `state_update` within the quiet period "unless a new prompt was sent". | CAPABILITY | `requirements.py:407-418` |

## Details

### Q1: Every caller and trigger (codex-acp @ `1fa6a1e`)

| # | Path | Trigger | Pending client request at turn start | Registered on v2 today? |
|---|---|---|---|---|
| C1 | `extMethod` `_session/goal` / legacy `_codex/session/goal_control`, `action:"set"` → `startGoalContinuationIfCurrent` (`CodexAcpServer.ts:566-592`) | `setGoal` → `runGoalSet` returns `null`: Codex routed no turn within 1 s after the matching `thread/goal/updated`, or the thread went active and then inactive without a routed turn (`CodexAppServerClient.ts:150,393-484,509-570`), **and** `updatedGoal !== null` | `_session/goal`. It stays open through `await previousPrompt?.completion`, through `canStart()` (`getGoal` RPC plus the generation check, `:1807-1817`), and until `onTurnStarted`. The response `{}` goes out right after the turn starts (`:1839-1846`). | No (`AcpAgentRouter.ts:133-135` is v1 only; v2 chain `:137-151`). Owner: topic 10 |
| C2 | Same, `action:"resume"` (`:598-617`) | `resumeGoal` → `runGoalSet` returns `null`, same conditions | `_session/goal` | No |
| C3 | `_session/steering` → `executeOrQueueSteeringRequest` → `SteeringQueue` → `performSteeringRequest` → `startNewTurnFromSteering` (`:552-553,1676-1734,1793-1796`) | `getSteerableTurnId` returns `null` (`currentTurnId` is null and no `pendingTurnStart`, or the session is closing, `:1893-1906`), **or** `turn/steer` failed with "no active turn to steer" / on a turn that is no longer current (`:1758-1779`) | `_session/steering`. It resolves `{outcome:"startedNewTurn"}` at turn start (`:1794-1795`) and rejects if cancelled before the start (`:1849-1853`). | No. Owner: 2(c) |

There are no other callers (`rg startNewTurnFromExternalPrompt|startGoalContinuationIfCurrent src`: only `:586,611,1794,1804`). Note that "after a goal turn completes" is **not** a codex-acp trigger. When Codex *does* route the goal turn (`turnCompleted !== null`), codex-acp starts nothing, and `_session/goal` stays pending for that whole Codex turn (test `CodexAcpClient.test.ts:2997`).

Both callers go through `startNewTurnFromExternalPrompt` (`:1820-1875`). That function awaits the current `activePrompts` entry once, re-checks closing, runs `canStart`, and then calls v1 `prompt(params, undefined, onTurnStarted)`. It passes **no `insertion`**, so:
- no `clientUserMessageId` is sent;
- the userMessage item is dropped, because `CodexEventHandler.ts:944-947` returns `null` for live `userMessage`;
- no `state_update` is sent (`sendState` exists only inside `promptV2`, `:2991-2997`).

Agent output still reaches v2 through the internal prompt's event handler.

**Agent-initiated turns codex-acp does not start (Codex runtime, source-read):**

| # | Codex trigger | Evidence |
|---|---|---|
| X1 | `thread/goal/set` / resume on an idle thread → `continue_if_idle` → `start_turn_if_idle` with `turn_trigger:"goal"` and a response-item input (**no userMessage**) | `codex-rs/ext/goal/src/runtime.rs:225-241,425-491`; observed live for `thread/goal/set` in `v2-codex-prompt-insertion-signal.md:150-151` |
| X2 | **Every turn end**: `TurnComplete` is sent, then `emit_thread_idle_lifecycle_if_idle` → goal extension `on_thread_idle` → `continue_if_idle`. While a goal is active, Codex immediately starts another turn. | `codex-rs/core/src/tasks/mod.rs:798-869`; `core/src/tasks/lifecycle.rs:55-78`; `ext/goal/src/extension.rs:180-191` |
| X3 | `thread/resume` also fires the idle lifecycle, so a session resumed with an active goal can start a turn with no prompt at all | `app-server/src/request_processors/thread_lifecycle.rs:810-814`; `thread_processor.rs:3940-3949` |

Inside a prompt, X1 is the `/goal` command turn (already handled by 2(a2-i)). **X2 happens on v2 today:** after a `/goal <objective>` prompt's turn ends, Codex keeps going. codex-acp learns about such a turn only if a session subscription exists (one is created by the first `prompt()` on that session in this process, `CodexAcpServer.ts:3182-3199`). If so, the handler sets `sessionState.currentTurnId ??= turn.id` on `turn/started` and clears it on `turn/completed` (`CodexEventHandler.ts:565-577`), and the output is rendered via `handleSessionScopedNotification`. No `state_update` is sent, and the promptV2 overlap check does not consult `currentTurnId`.

### Q2: What the spec, the SDK and the TCK say

- **A `running`…`idle` pair with no prompt pending.** R1/R2 are phrased in terms of foreground work and readiness, never in terms of a prompt. The RFD makes "turns aren't tied necessarily to prompts" the reason `running` exists (R5). Verdict: **allowed; required if the turn is foreground work**. The spec does not define foreground (R4), and R3 would technically let us call it background and send no states. I recommend foreground, because:
  - the turn is interruptible by `session/cancel` (`cancel` → `interruptSessionTurn` uses `currentTurnId`, `CodexAcpServer.ts:3764-3773`), and R9 then *requires* an `idle`/`cancelled`, which reads as a false turn end without a preceding `running` (see TCK STATE-201's inference);
  - it can raise permission requests, and `requires_action` is only defined for foreground work (`prompt-lifecycle.mdx:400`);
  - it blocks new prompts (a Codex steer, or our queue).
- **A `user_message` with no prompt.** Allowed (R6), never required (R7). Reuse a minted id so that live and replay agree (R8 is strictly about prompt-inserted messages, but the same reasoning applies).
- **Reference SDK (client side).** `SessionUpdateRouter` turns an idle `state_update` into a `stop` **only if a prompt is awaiting completion**; otherwise it is a plain `session_update` (`src/v2/acp.ts:2836-2856`). This is tested: an idle with no prompt pending is surfaced as a normal update and does not complete the next prompt (`src/v2/acp.test.ts:983-1061`). So an agent-initiated pair is tolerated. **The hazard:** if a client prompt is pending while an agent-initiated turn ends, the SDK attributes that turn's `idle` to the prompt (`acp.ts:2845-2851`; `beginPrompt` `:1195-1211`). `readText()` documents that updates carry no prompt id and prompts must be serial (`acp.ts:1920-1925`). The SDK has no agent-side example of agent-initiated turns (`src/examples/dual-version-agent.ts:226-268` only covers prompt-driven turns).
- **TCK.** STATE-201..203 and CANCEL-202 (R11, R12) are checked only inside prompt runs. No TCK row covers agent-initiated turns, and the TCK cannot trigger goal or steering. An X2 turn after a cancelled prompt would not start, since the Codex idle cause is `Interrupted` (`tasks/mod.rs:798-800`). The goal extension does not check the cause, though (`extension.rs:180-191`), so CANCEL-202 is safe only if goals are paused on interrupt. I have not verified that.

### Q3: A v2 `session/prompt` arriving during an agent-initiated turn

- User decision 2(c): queue FIFO, keep the request pending until insertion, and never `turn/start` on a busy thread (Codex silently steers: `v2-codex-prompt-insertion-signal.md`, queue invariant). So B is queued and dispatched only after the running turn's `turn/completed`. The sequence is `idle(X, stopReason)` → B `turn/start` → insertion (response + `user_message`) → `running` → … → `idle(B)`, the same shape as the approved between-turns sequence.
- **Does the overlap check need to count these turns? Yes.** Coverage today, for `v2PromptsInFlight || activePrompts || pendingTurnStarts` (`CodexAcpServer.ts:2983`):
  - Internal `prompt()` for C1–C3, from `trackActivePrompt` (`:3103`) to `activePrompt.complete()` (`:3633`): **counted**.
  - **Gap G1:** C1–C3 before `prompt()` registers: after `await previousPrompt?.completion` (`:1829`), during `canStart()` (the `getGoal` RPC, `:1812`), and during `prompt()`'s `await this.providerUpdate` (`:3083-3085`). A v2 prompt admitted in this window leads to two `prompt()` calls and a second `turn/start` on a busy thread. The reverse also happens: `startNewTurnFromExternalPrompt` never checks `v2PromptsInFlight`, so it misses a v2 prompt that has passed its check but has not yet reached `trackActivePrompt`.
  - **Gap G2:** the Codex-routed goal turn while `_session/goal` is pending (`runGoalSet` non-null path). No `prompt()` runs, so it is **not counted**.
  - **Gap G3:** X2 and X3 runtime turns are **not counted**. They are visible only as `sessionState.currentTurnId !== null` (when subscribed) or through `thread/status/changed` `active` (`src/app-server/v2/ThreadStatus.ts`).
- The busy predicate for 2(c) should be: "a codex-acp turn start is reserved or in flight (any starter), **or** Codex reports a running turn on the thread". Every starter (v2 queued prompt, goal continuation, steering fallback) should take one per-session reservation synchronously, before its first `await`.
- **Residual race I cannot close from our side (source-read):** X2 starts right after `TurnComplete`, so B's `turn/start` dispatched on `turn/completed(A)` can lose the race to Codex's `start_turn_if_idle` and get steered into the goal turn. This needs a Codex-side check (Open questions).

### Q4: Steering

Decision #6 (a fresh `clientUserMessageId` on every steer; show the `user_message` only when the userMessage item lands; response unchanged) fully covers the **user message** in both branches. In the new-turn branch, `turn/start` gets the minted id, and the item lands with `clientId` equal to that id. The difference is **state**:
- in the inject branch the running turn already owns `running`/`idle`;
- in the start branch codex-acp must emit its own `running` and exactly one `idle`+`stopReason` for the new turn, and the start must hold the per-session reservation.

One more point: `getSteerableTurnId` already injects into an X2/X3 turn when `currentTurnId` is set (`:1897-1899`). That is correct and should stay.

### Q5: Recommended v2 behaviour

| Turn source | `running` | `user_message` / id | `idle` | Queue interaction |
|---|---|---|---|---|
| C1/C2 goal continuation (`GOAL_CONTINUATION_PROMPT`) | at turn start (`onTurnStarted`, the `turn/start` response) | minted UUID as `clientUserMessageId`; `user_message_chunk` when the userMessage with that `clientId` lands (decision #3) | exactly one, `toV2IdleState(response)` when `prompt()` resolves; failure mapped as in promptV2 (agent text + idle) | enters the same per-session FIFO; `canStart()` is re-evaluated at dequeue; `_session/goal` stays pending until the turn starts (unchanged meaning) |
| C3 steering fallback | at turn start | minted UUID; emitted on landing (decision #6) | exactly one at the end | same FIFO; if a turn becomes steerable while the steer waits, inject instead (existing `performSteeringRequest` order) |
| G2 Codex-routed goal turn during `_session/goal` | on the first routed `turn/started` (`runGoalSet` `onTurnStarted`) | none (Codex records no userMessage; do not synthesize one) | on its `turn/completed` | counts as busy; queued B waits for it |
| X2/X3 Codex runtime turns | on `turn/started` for a turn no codex-acp starter owns | none | on its `turn/completed`; `stopReason` from the turn status (`completed`→`end_turn`, `interrupted`→`cancelled`, `failed`→ failure path) | counts as busy |
| any, on `session/cancel` | — | — | one `idle`/`cancelled` for the running turn; queued prompts dropped with `-32800` (2(c) decision) | — |

**Spec-mandated parts:**
- once a turn is treated as foreground, `running` before work and `idle` with `stopReason` when it ends (R1, R2);
- `idle`/`cancelled` after a cancel (R9);
- a queued B's response and `user_message` only at insertion (queued-prompt contract R1/R2);
- distinct ids (R8).

Everything else is a judgment call (below).

**v1 impact:** none on the ACP wire if every addition is gated on `protocolVersion === 2` (for example, only when an insertion/agent-turn observer is supplied, as 2(a2-iii) did). v1 keeps its out-of-turn updates and its `turn/start` shape. The FIFO/reservation also changes v1 *scheduling* if it is shared (an external start would wait on a reservation, not only on `activePrompts`). That changes no v1 wire shape, but it is a behaviour change to confirm (J6).

## Testability notes

- The harness already has `PromptSession.request(method, params)`. `_session/goal` and `_session/steering` must first be registered on v2 (topic 10 / 2(c)), or the tests must call `extMethod` on a v2-connected agent.
- **C1:** mock `setGoal` → `null` and `getGoal` → active; call `_session/goal set`; emit the userMessage with the `clientId` from the captured `turn/start`, then `turn/completed`. Snapshot the order: `{}` response, `running`, `user_message_chunk{messageId === turnStart.clientUserMessageId}`, agent chunks, `idle{stopReason:"end_turn"}`. A non-conforming run shows agent chunks with no `running`/`idle`, which is today's behaviour. Also assert that the v1 variant has no `clientUserMessageId` and an unchanged snapshot.
- **G1:** hold `getGoal` on a deferred, send v2 `session/prompt` B during it, and assert that `turnStartSpy` is never called twice without a `turn/completed` in between. Assert that B's response comes after `idle(X)`.
- **X2:** after a v2 prompt ends, emit `turn/started{id:"auto"}`, items, and `turn/completed`. Assert `running` … `idle`. Send B while "auto" runs and assert that it is queued (no `turn/start` until `turn/completed(auto)`).
- **Steering fallback:** extend `steer-events.test.ts:83` ("starts a new turn when no turn is active") with a v2 connection. Assert `running`, `user_message` on landing, and `idle`.
- **Cancel:** `session/cancel` during C1 or X2 → exactly one `idle`/`cancelled` after all updates.
- **Not unit-testable:** Codex's real race between `start_turn_if_idle` and a client `turn/start` (X2), and whether goals pause on interrupt. These need a live `/run-codex` probe.

## Discrepancies

- **SDK attribution vs. spec.** The spec allows agent-initiated turns (R5), but the SDK client helper attributes *any* idle to a pending prompt (`acp.ts:2845-2851`). If B is queued behind an agent-initiated turn X, `idle(X)` completes B's `readText()` early. The same thing already happens with the approved 2(c) between-turns sequence behind a client turn; there, the SDK's "call prompts serially" guidance (`acp.ts:1920-1925`) makes it the client's fault. For X, the client can only avoid it by watching for `running`. The spec has no prompt id on `state_update` (RFD `prompt.mdx:300`), so this is not ours to fix. Mention it in the AIR contract docs.
- **codex-acp vs. the Codex runtime (existing, v1 too).**
  - codex-acp's continuation (C1) assumes Codex does not continue by itself after a prompt's turn (test `CodexAcpClient.test.ts:2835`, "waits for an active turn before starting goal work"). Codex 0.156.1's idle hook (X2) does continue by itself, so C1's `turn/start` may land on a busy thread and be steered into the runtime turn.
  - `prompt()` also clears `sessionState.currentTurnId` (`:3101`), which hides a running X2 turn from cancel and steering.
  - These are source-read only, not observed live.
- **Spec docs vs. schema on `stopReason` strength** (MUST vs SHOULD): unchanged from the queued-prompt research, D1. Always send it.

## Judgment calls for the user

- **J1:** Treat all agent-initiated turns (C1–C3, G2, X2/X3) as **foreground**, with a `running`…`idle`+`stopReason` pair. The alternative, calling them background with no states, is legal under R3/R4, but it breaks cancel confirmation and queue semantics.
- **J2:** Send `running` at **turn start**, not at user-message landing. This covers pre-insertion work (compaction, MCP startup, hooks) and a turn that never inserts. The alternative mirrors promptV2's order: `user_message` → `running`, with nothing if the message never lands.
- **J3:** Show no `user_message` for Codex runtime turns (G2, X2/X3). Codex records none, and the goal context input is not user text.
- **J4:** Use one per-session FIFO/reservation shared by v2 queued prompts, goal continuation and the steering fallback. Arrival order decides, and goal continuation's `canStart()` is re-checked at dequeue. The alternative is that external starts pre-empt queued prompts.
- **J5:** Count Codex runtime turns as busy through `turn/started`/`turn/completed` (and/or `thread/status/changed`) with a **session-level subscription on v2** that does not depend on a prior `prompt()`. This is needed for X3 right after `session/resume`.
- **J6:** Also apply the shared reservation on v1 (a scheduling-only change that fixes G1 there too, with no wire change), or keep v1 on today's `activePrompts` wait.
- **J7:** Mint `clientUserMessageId` for C1 on **v2 only** (matches 2(a2-iii)). Steering mints on both versions per decision #6.

## Open questions

- **Codex (route to a Codex researcher + live probe):**
  - Does the goal idle continuation (X2) run after every turn end on 0.156.1, including after interrupts?
  - Is `start_turn_if_idle` vs. a client `turn/start` race-free, or can a queued B be steered into a runtime goal turn? Is there any app-server knob to suppress or defer the auto-continuation?
  - Does `thread/resume` (X3) really start a turn for an active goal?
  - This decides whether 2(c)'s "never `turn/start` on a busy thread" can be guaranteed at all, and whether codex-acp's own C1 continuation is still needed.
- **Topic 10 / 2(c):** register `_session/goal` and `_session/steering` on v2. That is the prerequisite for C1–C3 to exist on v2 at all.
- **Topic 5:** session-level event subscription after `session/resume` (for X3 output and states).
- **Topic 3:** existing `prompt()` clears `currentTurnId` (`:3101`), which can hide a running Codex turn from cancel and steering.

## Live verification (Codex 0.156.1)

**What was run:** a scratch JSON-RPC client (`/tmp/goalrace/probe.mjs`) that talks directly to `node_modules/@openai/codex/bin/codex.js app-server` (`codex-cli 0.156.1`, the repo's pinned version) over stdio, with `performance.now()` timestamps taken on line arrival. Every thread was `thread/start {approvalPolicy:"never", sandbox:"read-only", config:{model_reasoning_effort:"low"}}` in `/tmp/goalrace/ws`, with the user's default model. Transcripts are in `/tmp/goalrace/out-*.txt`. Each timing is one observation. Where n is small, that is stated. Two objectives were used:
- `TRIVIAL`: "Reply with the single word GOALOK, then call update_goal with status complete." It completes in one turn.
- `NEVER`: "Wait until the user sends … BANANA …; until then just reply WAITING", with `tokenBudget: 30000`. It stays active, so continuation keeps going. After each observation it was paused or cleared.

**Confidence:** high for 1a/1b/1c, the race outcome, and the pause mitigation (repeated, with consistent results). Medium for the exact width of the race window (n = 11 trials) and for interrupt behaviour (n = 1). Budget-limit stopping was **not** observed.

### 1. Auto-continuation: **confirmed** (X1, X2, X3)

| Case | Transcript | Sequence (ms after the triggering event) | userMessage in the auto turn? | What stopped it |
|---|---|---|---|---|
| **1a** Goal set during client turn A; A completes (X2) | `out-afterturn.txt` | `thread/goal/updated{status:active, turnId:A}` −2.8 → `thread/status/changed idle` −0.2 → **`turn/completed(A)` 0** → `thread/status/changed active` +23.3 → **`turn/started(G)` +23.5** → agentMessage "GOALOK" +4.5 s → `thread/goal/updated active` then `complete` (both `turnId:G`) +4.75 s → agentMessage "" → `status idle` → `turn/completed(G)` +8.1 s → nothing for 10 s | **No.** G has only reasoning and agentMessage items. | `complete` (the model called `update_goal`; the tool call is not surfaced as an item) |
| **1b** `thread/goal/set` on an idle thread (X1) | `out-idleset.txt` | goal/set response 0 (12.8 ms after the request) → `thread/goal/updated{active, turnId:null}` +2.5 → `status active` +24.6 → **`turn/started(G)` +24.8** → "GOALOK" → goal `complete` → `turn/completed(G)` +7.4 s → nothing for 10 s | **No** | `complete` |
| **1c** `thread/resume` in a fresh app-server, with a persisted active goal and no running turn (X3). Prep: `resume-prep` SIGKILLed the process mid-turn after goal/set. | `out-resume.txt` | `thread/status/changed idle` −0.5 → **`thread/resume` response 0** → `thread/goal/updated{active, turnId:null}` +0.4 → `status active` +6.2 → **`turn/started(G)` +6.4** → "GOALOK" → goal `complete` → `turn/completed(G)` +6.8 s → nothing for 15 s | **No** | `complete` |
| Pure auto-start gaps (no competing client request) | `out-afterturn`, `out-race{15,20,40,100}`, `out-pauseearly*` (after B) | `turn/completed` → next `turn/started`: 23.5, 8.9, 17.5, 17.3, 22.5, 17.3, 7.8 ms | — | — |
| Interrupt (goal set during A, then `turn/interrupt` A) | `out-interrupt.txt` | `turn/completed(A){status:interrupted}` → **no turn for 10 s**. The goal stayed `active` (`thread/goal/get`). | — | Interrupt suppresses the continuation (n = 1). This matches `ThreadIdleCause::Interrupted` in `core/src/tasks/mod.rs` / `lifecycle.rs:61-62`, although the goal extension does not check the cause itself. So TCK CANCEL-202 is safe here. |
| Client pause (`thread/goal/set {status:"paused"}`) during a running goal turn | `out-race*.txt` (all) | The running goal turn runs to its normal end. After that there is no further turn. | — | `paused` |

Additional observations:
- **Only turns show the Codex-side signals.** Each auto turn is announced as `thread/status/changed{active}` about 0.2 ms before its `turn/started`. At every turn end, `thread/status/changed{idle}` arrives 0.2–0.5 ms *before* `turn/completed`. So neither status notification gives usable lead time.
- **The one predictive signal** is the goal state at turn end. While a goal is active, every turn ends with `thread/goal/updated{status:"active", turnId:<ending turn>}` (turn-stop accounting), 2–3 ms before `turn/completed`. If the tracked goal status is `active` when `turn/completed` arrives (and the turn was not interrupted), Codex will start a turn about 8–24 ms later.
- **Codex-acp's own C1 fallback is effectively dead on 0.156.1.** Codex routes a turn about 25 ms after an idle goal/set (1b), well inside `runGoalSet`'s 1 s window. After a goal turn, Codex continues by itself (1a).
- Budget stop: not observed. Source only: `continue_if_idle` starts only when `status == Active` (`ext/goal/src/runtime.rs:465-468`), and `BudgetLimited` clears the active goal (`:243-247`).

### 2. The race: **confirmed**. Timing decides the outcome; nothing in the protocol does.

The `race` scenario: goal `NEVER` is active during A, and a client `turn/start` B (`clientUserMessageId:"B"`) is sent from the synchronous line handler for `turn/completed(A)`, plus an optional `setTimeout(delay)`.

| Delay setting | B sent after `turn/completed(A)` | Codex's next `turn/started` after `turn/completed(A)` | B's `turn/start` response `turn.id` | B's userMessage lands in | Outcome |
|---|---|---|---|---|---|
| 0 (×5) | 0.15–0.24 ms | 12.2–17.5 ms | a new turn | that new turn, first item (about +20 ms) | **B gets its own turn** (5/5) |
| 10 | 12.3 ms | 17.8 ms (= B's turn) | new | B's turn | B gets its own turn |
| 15 | 15.8 ms | **8.9 ms** (goal turn) | **the goal turn's id** | goal turn, +27 ms | **steered** |
| 20 | 21.1 ms | 17.5 ms | goal turn id | goal turn, +39 ms | **steered** |
| 40 | 41.5 ms | 17.3 ms | goal turn id | goal turn, **+3.68 s** (after the first sampling round) | **steered** |
| 100 | 101.9 ms | 22.5 ms | goal turn id | goal turn, **+4.07 s** | **steered** |

- **Deterministic by arrival order.** The outcome is decided entirely by whether B's `turn/start` reaches the app-server before `continue_if_idle` → `start_turn_if_idle` submits (6/6 won when sent ≤ 12.3 ms after `turn/completed`; 4/4 lost when sent ≥ 15.8 ms). The auto-start gap varies from **7.8 to 24.8 ms** (n = 9, including 1b). No fixed client delay is safe, and a codex-acp dispatch that awaits anything (an RPC, `providerUpdate`, a GC pause) can lose.
- **A steered B looks like a success.** The `turn/start` response is `{turn:{id:<goal turn>, status:"inProgress"}}`. It carries no error or flag. The only tells:
  - `response.turn.id` equals a turn already announced by `turn/started` that codex-acp did not start;
  - B's userMessage (`clientId:"B"`) lands under that turn id, sometimes seconds later.

  Where the losing B lands depends on timing. Before the goal turn's first sampling, B is folded into the first model request. Otherwise it is injected after the first sampling round, and the goal turn then runs a second round.
- **Losing races do not queue a second goal turn.** When B wins, Codex's continuation for that idle is dropped (`StartIfIdleSubmission::NotSubmitted`). The goal continues after B's turn ends (observed in `pauseearly`: auto turn 7.8 / 17.3 ms after `turn/completed(B)`).
- **Ways a client could avoid the race.** Only the last one works.
  - `turn/start` has no refuse-to-steer option. `TurnStartParams` fields (`src/app-server/v2/TurnStartParams.ts`): `threadId, disabledPluginIds, clientUserMessageId, input, turnTrigger, toolOutput, cwd, approvalPolicy, approvalsReviewer, sandboxPolicy, model, serviceTier, serviceTierForTurn, effort, summary, personality, outputSchema`. Its doc says overrides are "Ignored when this request steers an already-active turn", which confirms that steering is the defined behaviour.
  - `deferGoalContinuation` exists only on `thread/fork` (`app-server/src/request_processors/thread_processor.rs:4834,4855,5190` at `rust-v0.156.1`) and is absent from the generated types. It does not apply to `thread/resume` or to `turn/start`.
  - `thread/status/changed` gives about 0.2 ms of lead (see above). It is not usable.
  - **Pausing the goal first works (observed 2/2; see M1).** Scenario `pauseearly` pauses with `thread/goal/set {threadId, status:"paused"}` while A is still running. At `turn/completed(A)`, no auto turn started; with a 1000 ms wait (`out-pauseearly1000.txt`), the thread stayed idle for the whole second. `turn/start` B then got a fresh turn, with B's userMessage as its first item. Right after `turn/started(B)`, `thread/goal/set {status:"active"}` started **no** extra turn, and Codex continued the goal 7.8 / 17.3 ms after `turn/completed(B)`.
  - Side effect of the pause: goal accounting freezes at the pause point. `tokensUsed` stayed at 15994, versus about 16090 without the pause, so the rest of A is not billed to the goal (`prepare_external_goal_mutation`, `runtime.rs:164-189`).

### 3. Can codex-acp guarantee "never `turn/start` on a busy thread" (2(c))?

**Not with timing or protocol parameters alone.** No option on `turn/start` refuses to steer, and the idle window between goal turns is 8–25 ms with no lead signal. After `session/resume` with an active goal, Codex starts a turn about 6 ms after the resume response. A client prompt that follows the resume will almost always be steered.

There is a second, bigger problem. **While a goal is active the thread is never idle**, apart from those ~20 ms gaps. So a strict "queue until idle" makes a queued prompt wait until the goal reaches `complete`/`blocked`/`paused`/`budgetLimited`/`usageLimited`. With `tokenBudget: null`, that wait is unbounded. The 2(c) decision did not anticipate this.

Mitigations, in the order I recommend them:

- **M1: pause, dispatch, restore (viable; the only mitigation that preserves 2(c)).**
  - When a v2 prompt is queued behind a running turn and the tracked goal status (from `thread/goal/updated` / `thread/goal/get`) is `active`, send `thread/goal/set {status:"paused"}` right away, while the current turn is still running.
  - On that turn's `turn/completed`, send `turn/start` for B.
  - On `turn/started(B)` (or the `turn/start` response), send `thread/goal/set {status:"active"}`. Restore only if the goal is still the one codex-acp paused (same `objective`/`createdAt`, still `paused`), so that a user's own pause is not undone.

  Costs:
  - The goal visibly toggles `paused`→`active` in `thread/goal/updated`, both for other clients and for codex-acp's own goal notifications.
  - Goal accounting drops the remainder of the paused turn.
  - A crash between pause and restore leaves the goal persisted as `paused`.
  - The running goal turn still finishes normally; the pause does not interrupt it.

  Unverified: whether a pause sent *after* `turn/completed` is ordered before `continue_if_idle`'s DB read. `apply_external_goal_set` does not take `goal_state_permit` (`runtime.rs:191-256`); only `continue_if_idle` does (`:432`). So "pause at dequeue time" is itself racy, and the pause should be sent when B is queued, not when it is dequeued. B arriving while the thread looks idle but a goal is active (the ~20 ms gap, or right after resume) cannot be protected. Such a B needs M2.
- **M2: detect the steer and adopt it (always needed as a safety net).**
  - If `turn/start`'s `response.turn.id` is an already-running turn codex-acp did not start, or B's `clientId` lands under a different turn id, treat B as steered.
  - Send no second `running`: that turn already owns one under J1.
  - Resolve B's `session/prompt` and emit its `user_message` when the userMessage with B's `clientId` lands. This is the existing 2(a) insertion signal and needs no change; it can take seconds.
  - Emit one `idle` when that turn completes.

  This does not satisfy "never `turn/start` on a busy thread". It makes a violation harmless and spec-consistent.
- **M3: deliberately steer B into the goal turn with `turn/steer {expectedTurnId}`.** This matches what Codex does anyway and avoids mutating goal state. It is a product-semantics change: queued prompts become steers while a goal is active.
- **M4: strict wait for idle.** Unbounded starvation under an active goal. Not viable unless it has a timeout or the user accepts that a goal run blocks input.

**Recommendation:** M2 unconditionally, plus M1 as the default policy when a goal is active. Both need a user decision (see J8/J9). The 2(c) guarantee can only hold "for prompts queued while a turn is visibly running, when codex-acp controls the goal". It cannot hold for prompts that arrive in the inter-turn gap, right after resume, or when another app-server client shares the thread.

### New judgment calls

- **J8 (user decision): queued prompts when a goal is active.**
  - (a) M1: pause the goal, run B as its own turn, then resume the goal. Preserves 2(c) at the cost of visible goal-state churn.
  - (b) M3: steer B into the running goal turn.
  - (c) M4: hold B until the goal stops.

  I recommend (a).
- **J9 (user decision): relax the 2(c) invariant** from "never `turn/start` on a busy thread" to "never *knowingly*, and adopt the steer (M2) when Codex's own goal turn wins the race". Without this, 2(c) is unimplementable on 0.156.1.
- **J10: prompts right after `session/resume` when a goal is active.** Codex starts a goal turn within ~6 ms of `thread/resume`. Options: accept the steer (M2); pause the goal before `thread/resume` (unverified: this needs `thread/goal/set` to work on a not-yet-loaded thread); or pause right after the resume response (it races against the ~6 ms window).
- **J11: C1 codex-acp goal continuation.** It is redundant on 0.156.1 (X1 always routed within ~25 ms in these runs). Keep it as a fallback only, or remove it. Either way it must go through the same reservation/M2 path, because its `turn/start` would be steered into Codex's goal turn.

### Open questions (live-probe follow-ups)

- Is a pause sent immediately after `turn/completed` ever too late? This would need about 20 trials of "pause at dequeue" to see whether `continue_if_idle` ever reads before the pause persists.
- Does `thread/goal/set` work on a thread that is not loaded (before `thread/resume`)? This decides J10.
- Budget/usage-limit stops were not observed live.
- Interrupt suppression was observed only with a goal set 3 ms before the interrupt of a client turn. It was not tested by interrupting an auto-started goal turn.
- How Codex's own TUI handles user input during goal runs (steer vs. queue). It is a reasonable precedent for J8.

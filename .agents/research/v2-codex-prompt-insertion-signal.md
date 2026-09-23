# Which Codex app-server event proves a user prompt was "inserted", for the ACP v2 `session/prompt` `{messageId}` response and the live `user_message`? What does Codex emit in the edge cases?

**Sources checked:**
- Codex `openai/codex` @ tag `rust-v0.156.1` (`81e8e29b2956dfe9b092c63953a9ed282781e77c`). This matches the installed `@openai/codex` `0.156.1` (`package.json:69`, `codex --version`). I fetched individual files read-only with `gh api .../contents/<path>?ref=rust-v0.156.1` into `/tmp/codex-research/src/`. I did not clone anything. The paths below are relative to `codex-rs/`.
- Codex app-server README at the same tag, and at `main` @ `17cd2834` (2026-09-23). Neither version documents turn or item ordering, `clientUserMessageId` or `clientId`. Only the managed-provider paragraph mentions turn start/steer.
- Generated types in this repo: `src/app-server/v2/*` (Codex 0.156.1).
- codex-acp, this repo, branch `eugenethedev/acp-v2` @ `6c7d4c1`. `src/CodexAcpServer.ts` is being edited in the working tree while I write this, so its line numbers may drift.
- **Real Codex 0.156.1 observations.** I ran a raw JSON-RPC probe (`/tmp/codex-research/probe.mjs`, outside the repo) directly against `codex app-server`. Scenarios: basic, turn/start on a busy thread plus turn/steer, steer then interrupt, interrupt, a failing model, `thread/compact/start`, `review/start` inline, `thread/goal/set`, and a reload in a fresh app-server process. The transcripts are in `/tmp/codex-research/out-*.txt` and in this session's output. Timings below come from those runs.
- ACP: I did not re-research this side. It comes from `.agents/research/v2-queued-prompt-contract.md`. I spot-checked the load-bearing lines in `agent-client-protocol` @ `c2452704`.

**Confidence:** high. Every ordering and identifier claim was both read in the Codex source and observed on real Codex 0.156.1. The exception is two edge paths that I only read in the source (a hook blocking the prompt, and step-context errors). They are labeled as source-only.

## Answer

**Insertion = the `item/completed` notification (or the `item/started` sent right before it) for a `userMessage` item whose `item.clientId` equals the ID codex-acp minted and sent as `clientUserMessageId` on `turn/start` / `turn/steer`.**

The other candidates carry no evidence of insertion:
- `turn/start` response. It is sent after Core *spawns* the task, before the input is recorded. It carries `items: []`.
- `turn/started` notification. It is emitted as the task's first action, also before the input is recorded.

Codex records the user message later: after pre-turn compaction, MCP startup, session-start hooks and `UserPromptSubmit` hooks. Only then does it emit `item/started`/`item/completed` for the `userMessage`. There are paths where `turn/started` is sent and the userMessage is **never** recorded. Today `onTurnStarted` fires on the **`turn/start` response** (`src/CodexAppServerClient.ts:302-303`), which is too early for v2.

**`messageId` should be minted by codex-acp** (for example a UUID) **and passed as `clientUserMessageId`.** Codex echoes it as `userMessage.clientId`: live, in `thread/turns/list` / `thread/read`, after a reload in a fresh app-server, and even through the legacy rollout path. The Codex item `id` is only stable for new ("paginated") rollouts. Legacy rollouts rebuild it as `item-N`. Codex-originated user messages always have `clientId: null`.

**Edge cases:**
- `/compact` and runtime-driven `/goal` turns emit **no** userMessage.
- `/review` emits none that codex-acp can correlate: `ReviewStartParams` has no `clientUserMessageId`, and the forwarded reviewer prompt has `clientId: null`.
- `turn/steer`, and `turn/start` on a busy thread (which Codex silently turns into a steer), return success immediately. They insert only at the next sampling boundary, and **interrupting before then drops the input silently.**

## Requirements

| # | Requirement | Tier | Citation |
|---|---|---|---|
| R1 | A successful `{messageId}` response means the user message was inserted. Receipt, queueing or assigning an ID is not enough. | MUST / MUST NOT (`capabilities.session`) | ACP `docs/protocol/v2/prompt-lifecycle.mdx:139` |
| R2 | An adapter may treat the runtime's user-message echo or insertion event as evidence of insertion. It may match that event with a private per-submission token. "An ID assigned in advance is not by itself evidence of insertion." The ID may be native to the runtime or owned by the adapter, as long as updates and replay use it consistently. | RFD (proposal/design intent) | ACP `docs/rfds/v2/prompt.mdx:76` |
| R3 | Distinct inserted submissions get distinct `messageId`s. If a message is replayed, it keeps the same ID. | MUST | ACP `prompt-lifecycle.mdx:180,182` |
| R4 | A request rejected before insertion gets a JSON-RPC error. | MUST (the stated mechanism) | ACP `prompt-lifecycle.mdx:139` |
| R5 | A locally handled command that the runtime does not record: the adapter inserts a live-only user message and need not wait for a runtime event. If replayed, it keeps the same ID. | MUST (same contract) / MAY (live-only) | ACP `docs/protocol/v2/slash-commands.mdx:102-104` |
| C1 | `turn/start` and `turn/steer` accept an optional `clientUserMessageId` (not experimental). Codex copies it to the recorded `userMessage.clientId`. | Codex fact | `app-server-protocol/src/protocol/v2/turn.rs:173-174,295-296`; `app-server/src/request_processors/turn_processor.rs:611-619,1059-1066`; `core/src/session/mod.rs:4819`; generated `src/app-server/v2/TurnStartParams.ts`, `TurnSteerParams.ts`, `ThreadItem.ts` |
| C2 | `turn/start` on a thread with an active turn **steers** it instead of starting a new one. | Codex fact | `core/src/codex_thread.rs:327-338`; `core/src/session/turn_input.rs:280-320`; `turn_processor.rs:650-673` |

## Details

### 1. Candidate signals: order, guarantee, identifiers

Source sequence for a `turn/start` on an idle thread:
1. The app-server calls `thread.start_or_steer_turn(...)` (`turn_processor.rs:650-670`).
2. Core `start_or_steer` first tries `steer_input` (`core/src/session/turn_input.rs:304`). On `NoActiveTurn` it prepares settings, wraps the input as `TurnInput::UserInput{content, client_id, acceptance_order}` (`turn_input.rs:725-735`), calls `spawn_task(...)` and returns `Started{turn_id}` (`turn_input.rs:317-366`).
3. The app-server immediately answers `TurnStartResponse{turn:{id, items: [], itemsView:"notLoaded", status:"inProgress"}}` (`turn_processor.rs:700-714`).
4. Inside the spawned `RegularTask`, the first thing it does is `emit_turn_started` (`core/src/tasks/regular.rs:48-51`). The app-server maps that to `turn/started` with `turn.items` cleared (`app-server/src/bespoke_event_handling.rs:155-182`).
5. Then come turn-start lifecycle contributors and startup prewarm (`regular.rs:52-81`), then `run_turn` (`regular.rs:105`). `run_turn` does all of the following **before** it records the input:
   - pre-sampling compaction (`core/src/session/turn.rs:183-221`)
   - MCP-requirement resolution (`turn.rs:229-249`)
   - step-context capture and waiting for MCP startup (`turn.rs:262-280`)
   - context updates, skills and plugins (`turn.rs:282-317`)
   - session-start hooks (`turn.rs:320-321`)
   - Guardian finalization (`turn.rs:322-364`)
6. `run_hooks_and_record_inputs(..., PersistContext::TurnStart)` (`turn.rs:366-376`) runs the `UserPromptSubmit` hook (`core/src/hook_runtime.rs:670-697`). If the hook does not block, it calls `record_user_prompt_and_emit_turn_item` (`core/src/session/mod.rs:4776-4823`). That function:
   - writes the message into model-visible history (`:4811-4817`)
   - sets `client_id` (`:4819`)
   - emits `ItemStarted` then `ItemCompleted` back-to-back with identical payloads (`:4821-4822`)
7. The app-server forwards these as `item/started` / `item/completed` (`bespoke_event_handling.rs:1073-1131`). The first model sampling request comes after that.

| Signal | When | Guaranteed? | Identifiers carried | Evidence of insertion? |
|---|---|---|---|---|
| `turn/start` response | After the task is spawned. Observed ~4-5 ms after the request. | Yes, if the request succeeds. Otherwise a JSON-RPC error. | `turn.id` only. `items: []`. | **No.** The input has not been recorded yet. On a busy thread, this is the *active* turn's id and means "steered" (see §3). |
| `turn/started` notification | Emitted by the task. Observed ~5 ms **after** the response in all 8 runs, but the order is not guaranteed: the response goes directly to the outgoing queue, while the notification goes through the core event channel. | Only for regular turns and compact. Not sent for the review turn id (§3). Not sent for steers. | `threadId`, `turn.id`, `items: []` (cleared) | **No.** It comes before recording, and some failure paths never record at all (§3). |
| `item/started` `userMessage` | Right after the input is written to history. Observed 430-600 ms after `turn/started`, mostly because of MCP startup and session-start hooks. | For turn/start input that is not blocked by a hook and does not hit an early error. | `threadId`, `turnId`, `item.id` (UUIDv7, `protocol/src/items.rs:513-515,529-536`), **`item.clientId`**, `item.content` | **Yes.** |
| `item/completed` `userMessage` | Immediately after `item/started` (≤2 ms). | Same as `item/started` | Same payload | **Yes.** This is the one persisted to the rollout (`event_msg item_completed UserMessage … client_id`). |

**Most defensible insertion point:** the `userMessage` `item/completed` whose `clientId` matches the minted ID. `item/started` is equivalent, since both come after history is written; take whichever arrives first. This is exactly the RFD's pattern of "user-message echo … matched with a private per-submission token" (R2).

Match on `clientId`, **not** on "the first userMessage in the turn":
- steered messages share the same `turnId`
- the review flow forwards a userMessage with `clientId: null` under the review turn id

**What `onTurnStarted` fires on today:**

| Path | Fires on | Citation |
|---|---|---|
| `runTurn` | the `turn/start` **response** | `src/CodexAppServerClient.ts:295-303` |
| `runReview` | the `review/start` response | `:328` |
| `runCompact` | the first `turn/started` or `item/started(contextCompaction)` | `:547-553` |
| `runGoalSet` | the first routed turn after the matching goal update | `:370-377` |

`CodexEventHandler` only uses `turn/started` to set `currentTurnId` (`src/CodexEventHandler.ts:557-560`). It explicitly ignores `userMessage` items (`:857`, `:932`).

### 2. `messageId` source

**Codex item id vs `clientId` (observed on 0.156.1):**

| Where | `userMessage.id` | `userMessage.clientId` |
|---|---|---|
| live `item/started`/`item/completed` | `01a0d0a5-0d71-7801-…` (UUIDv7) | `acp-msg-A` |
| `thread/turns/list` / `thread/read`, same process | same UUIDv7 | `acp-msg-A` |
| `thread/resume` + `thread/turns/list` in a **fresh** app-server | same UUIDv7 | `acp-msg-A` |
| rollout file (new format) | `event_msg` `item_completed` `{type:"UserMessage", id:<uuid>, client_id:"acp-msg-A"}`. There is **no** `event_msg user_message` line. | — |
| legacy rollouts (with `event_msg user_message`) | **re-synthesized as `item-N`** by `ThreadHistoryBuilder::handle_user_message` (`app-server-protocol/src/protocol/thread_history.rs:503-520,1528-1532`). The live `ItemStarted/Completed(UserMessage)` is ignored for history (`:626-660`, `UserMessage` → no upsert). | preserved from the legacy event (`thread_history.rs:517`; test `:2528-2590`). The legacy `UserMessageEvent` carries `client_id` (`protocol/src/protocol.rs:2536-2538`). |

**Conclusion:** codex-acp must mint the ID. Using the Codex item id is fragile:
- it is only known after insertion, which is fine for the response, but
- it is not stable on the legacy-history path, and
- the in-turn review/compact items carry no user-supplied correlation.

A minted ID passed as `clientUserMessageId` meets R2 and R3 on both history paths:
- **Live:** respond with `{messageId: minted}` and send `user_message{messageId: minted}` when the matching `item/completed` arrives.
- **Replay** (`createHistoryUpdates` → `createUserMessageUpdates`): use `item.clientId ?? item.id`.
  - Messages that codex-acp submitted get their original ID back.
  - Messages from other Codex clients, or from before this change, have `clientId: null`. They fall back to `item.id`, which is stable for new-format rollouts.

**What the history paths use today:**
- `createUserMessageUpdates` uses `item.id` (`src/CodexAcpServer.ts:2443-2452`, called from `createHistoryUpdates` `:2387-2389`).
- `ResponseItemHistoryFallback` builds `user_message_chunk` **without any `messageId`**, and only from legacy `event_msg user_message` records (`src/ResponseItemHistoryFallback.ts:257-280`). It ignores `role:"user"` response items (`:232-235`).
  - It never reads `payload.client_id`, which is present on legacy records.
  - On 0.156.1 rollouts it yields no user messages at all, because that record type is no longer written (observed). The thread-item path then supplies them through `mergeHistoryUpdates` (`src/CodexAcpServer.ts:~3513`).
- Nothing in `src/` sets `clientUserMessageId` today. The only hits are generated types and test fixtures with `clientId: null`.

### 3. Edge cases (observed unless marked "source-only")

- **`turn/start` rejected.** A JSON-RPC error arrives before any turn and before insertion, so a v2 error is correct (R4).
  - Observed: unknown thread gives `-32600 "thread not found: …"`.
  - Source-only:
    - input too large gives `invalid_params` with `input_error_code` (`turn_processor.rs:515-523`)
    - server draining (`:674-677`)
    - other `NotSubmitted` reasons give `internal_error "failed to submit turn input: …"` (`:678`). That includes a busy review or compact turn (`ActiveTurnNotSteerable`).
- **Turn fails after starting** (bad model, observed). The sequence is `turn/started` → userMessage `item/*` (clientId set) → `error` notifications (`willRetry:true`, ×5) → `thread/status/changed systemError` → `error willRetry:false` → `turn/completed status:"failed"`. The message **was inserted** and is in history. The v2 response must already have been sent; the failure surfaces afterwards as the turn's stop reason.
  - Source-only: when pre-sampling compaction fails, the input is still recorded *before* the error is published (`turn.rs:183-221`).
- **`turn/started` but never inserted** (source-only):
  - A non-abort error in step-context/MCP capture returns without recording (`turn.rs:279`).
  - `build_skills_and_plugins` returning `None` (`:308-317`).
  - Session-start hooks stopping the turn (`:320-321`).
  - A Guardian finalization error (`:322-337`).
  - A blocking `UserPromptSubmit` hook: `should_stop`, where only additional contexts are recorded (`turn.rs:862-867`, `hook_runtime.rs:670-697`).
  - In all of these, `turn/completed` arrives with no userMessage carrying the minted `clientId`. codex-acp must then answer the pending `session/prompt` with a JSON-RPC error, or with an adapter-inserted message if it chooses to (see Open questions). Resolving on `turn/started` would wrongly claim insertion.
- **Interrupt right after `turn/started`** (observed). The userMessage `item/*` still arrives (clientId set) *before* the `turn/interrupt` response and `turn/completed interrupted`, and it is in history. Source: a cancelled prewarm still records inputs (`regular.rs:85-95`).
- **`turn/start` on a busy thread = steer** (observed).
  - The response comes back in 1 ms with the **active** turn's id.
  - No new `turn/started` is sent.
  - The userMessage (`clientId:"acp-msg-C"`) arrives **7.6 s later**, after the running turn's agent message and command execution, at the next sampling boundary (`turn.rs:426-446`, `PersistContext::SteeredUserInput`).
  - codex-acp's FIFO queue must therefore hold queued prompts until the previous `turn/completed` before it calls `turn/start`. Otherwise the prompt is silently merged into turn A.
- **`turn/steer`** (observed). The response `{turnId}` is immediate and means "queued in the active turn", **not inserted**.
  - The userMessage with the steer's `clientId` arrives at the next sampling boundary.
  - **If the turn is interrupted before then, the steered input is dropped with no event** (observed: `acp-msg-I` never appeared, live or in history). Source: `clear_pending` clears `pending_input.items` (`core/src/tasks/mod.rs:559,605`; `core/src/session/input_queue.rs:207-211`).
  - Errors: `-32600 "no active turn to steer"`, expected-turn mismatch, `"cannot steer a review turn"`, `"cannot steer a compact turn"` (`turn_processor.rs:1076-1110`).
  - codex-acp's `session/steer` extension calls `turn/steer` without `clientUserMessageId` (`src/CodexAcpClient.ts:1163-1168`).
- **`/compact`** (`thread/compact/start`, observed).
  - The response is `{}` with no turn id.
  - Then `turn/started` (new turn id), `item/started contextCompaction`, `item/completed contextCompaction`, and `turn/completed`.
  - **No userMessage, live or in history.** codex-acp must insert its own live-only message (R5). There is nothing Codex-side to replay.
- **`/goal`** (`thread/goal/set`, observed).
  - The response is `{goal}`. Then `thread/goal/updated` and a runtime-started `turn/started`. After that come reasoning and agentMessage items, but **no userMessage**, live or in history.
  - This is different from codex-acp's own goal continuation (`startGoalContinuationIfCurrent`, `src/CodexAcpServer.ts:~1756`). That sends `GOAL_CONTINUATION_PROMPT` through `prompt()` → `turn/start`, and it **does** produce a userMessage (it is ordinary `turn/start` input).
- **`/review`** (`review/start` inline, observed).
  1. The response carries a **synthesized** `turn.items[0]`: a `userMessage` with `id` = the review turn id, `clientId: null`, content = the display text (`turn_processor.rs:1383-1405`). This item is never emitted as `item/*` and never appears in history.
  2. Then `item/*` `enteredReviewMode`.
  3. Then `turn/started` carrying the **reviewer child's** turn id, not the review turn id. Core does not emit a parent `TurnStarted` for reviews (`core/src/session/review.rs:217-220`); the child's events are forwarded (`core/src/tasks/review.rs:179-181`).
  4. Then `item/*` `userMessage` (fresh UUID, `clientId: null`, the reviewer prompt, `review.rs:198-207`) under the review turn id.
  5. Finally `turn/completed` for the review turn id.
  - History shows the child turn as a separate `interrupted` turn that contains that userMessage.
  - `ReviewStartParams` has no `clientUserMessageId` (`src/app-server/v2/ReviewStartParams.ts`). The adapter must insert its own live-only message, on the `review/start` response.
- **Plan-implementation second turn.** codex-acp sends `turn/start` with text `"Implement the approved plan."` (`src/CodexAcpServer.ts:3234`). This is ordinary `turn/start` input, so Codex records and emits a userMessage for it, which is also replayed from history. I did not probe this separately; the same code path was observed in the basic run. It has no pending ACP `session/prompt`, so no response is waiting on it.

### 4. Late observability

- Insertion always comes **after** `turn/started`, typically by hundreds of ms (MCP startup and session-start hooks). Pre-turn compaction can push it by seconds, and a `contextCompaction` item can then arrive *before* the userMessage in the same turn (`turn.rs:183`, "Pre-turn compaction runs before … the new user message are recorded").
- For a fresh `turn/start`, the userMessage is always recorded before the first model sampling (`turn.rs:366-376`, before the loop at `:420`). No output from that turn can come before it.
- Steered input, from `turn/steer` or from `turn/start` on a busy thread, is inserted only at the next sampling boundary, **after** earlier model and tool output. It can be dropped entirely on interrupt.
- `state_update: running` for the ACP prompt must therefore not wait on insertion if codex-acp wants to show activity earlier. But per the prior research (R10 there), `running` after insertion is the documented sequence. Sending `running` on `turn/started`, before insertion, is a separate design choice for the orchestrator.

## Testability notes

- **Fake client, conforming.** Emit the `turn/start` response, then `turn/started`, then hold. Assert that no `session/prompt` response and no `user_message` has been sent. Then emit `item/started`/`item/completed` `userMessage` with `clientId` equal to the value codex-acp put in `TurnStartParams.clientUserMessageId`. Assert:
  - the response `{messageId}` equals that `clientId`,
  - the `user_message.messageId` is the same value,
  - both come before `running`, in either order.
- **Non-conforming:** the response is sent right after the `turn/start` response or on `turn/started`. Replace the minted UUID with a stable placeholder in snapshots (`toMatchFileSnapshot()`), and assert separately that the response id, the update id and `TurnStartParams.clientUserMessageId` are all equal.
- **No insertion:** emit `turn/started` → `turn/completed(failed)` with no userMessage. Assert that the prompt gets a JSON-RPC error, not `{messageId}`.
- **Correlation:** emit a userMessage with `clientId: null` (review-style) or a different `clientId` (steer) in the same turn. Assert it does not resolve the pending prompt.
- **Replay:** feed `thread/turns/list` a `userMessage` with `clientId: "m1", id: "x"`. Assert the replayed `user_message_chunk.messageId === "m1"`. With `clientId: null`, assert the fallback to `"x"`.
- **Queue:** assert codex-acp issues no `turn/start` for prompt B until A's `turn/completed`. Under C2, an early call would steer.
- **Untestable with fakes:** real-Codex timing (hooks, MCP, compaction delay). Use `/run-codex` or the probe to observe it.

## Discrepancies

- **ACP vs Codex, response timing.** ACP ties the response to insertion. Codex's natural "accepted" signals (`turn/start` response, `turn/steer` response, `turn/started`) all come *before* insertion, and a steer's success is not even a promise of insertion (it is dropped on interrupt). codex-acp's current `onTurnStarted` (the `turn/start` response) is correct for v1 but too early for v2 R1.
- **Codex item id stability.** Codex item ids are stable only for new-format rollouts. Legacy history re-numbers them to `item-N` (`thread_history.rs:503-520`), while `clientId` survives both paths. The RFD allows either a native or an adapter-owned ID (R2). Only the adapter-owned `clientId` is stable everywhere.
- **Review.** The `review/start` response's synthesized userMessage (`id` = turn id) differs from the live forwarded userMessage (fresh UUID) and from history (child turn). Codex offers no correlation token for reviews.
- **Documentation.** The Codex README (tag and `main`) documents none of `clientUserMessageId`, `clientId` or turn/item ordering. The findings rest on source plus observation, so they can change between Codex releases.

## Open questions

1. For turns that start but never insert (a blocking `UserPromptSubmit` hook, early errors): error the `session/prompt` with a JSON-RPC error, or insert an adapter-owned live message and report `idle` with a stop reason? This is an ACP-side design choice.
2. The replay representation of `/review`, `/compact` and `/goal` commands. Codex history has no user message for compact or goal, and review has the reviewer prompt with `clientId: null`. Should codex-acp persist its live-only command messages anywhere, or accept that they are live-only (R5 allows that)? Should the replayed review prompt be hidden or shown?
3. Should the plan-implementation and goal-continuation synthetic `turn/start` prompts be surfaced as `user_message` live? They will be replayed from history either way. If shown, pass a minted `clientUserMessageId` so the IDs match.
4. `ResponseItemHistoryFallback` finds no user messages in 0.156.1 rollouts, and ignores `client_id` in legacy ones. Is the fallback still needed for user messages, and should it read `client_id`?
5. Review flow: `turn/started` carries the child turn id while items use the parent review turn id. `CodexEventHandler` sets `currentTurnId` from `turn/started` (`src/CodexEventHandler.ts:557-560`). Is `completesActiveTurn` (`src/CodexAcpServer.ts:~3006`) still correct for reviews? This is a v1 and v2 correctness question, adjacent to this one.
6. `session/steer` (the extension) should probably pass `clientUserMessageId` too, if v2 exposes steered prompts as `user_message`. Note the drop-on-interrupt behavior.

## Recommendation

**insertion = the first `item/started` or `item/completed` notification on the session's thread with `item.type === "userMessage"` and `item.clientId === <minted id>`; messageId = an adapter-minted UUID sent as `TurnStartParams.clientUserMessageId` (and `TurnSteerParams.clientUserMessageId`), replayed from `ThreadItem.userMessage.clientId ?? item.id`.**

Do not call `turn/start` for a queued prompt until the previous turn's `turn/completed`, because a busy-thread `turn/start` steers.

| Case | Codex emits a userMessage? | Insertion signal to use | messageId | Before-insertion failure |
|---|---|---|---|---|
| `turn/start`, idle thread | Yes. After `turn/started`, hooks, MCP and pre-compaction; before model output. | userMessage `item/*` with matching `clientId` | minted (= `clientId`) | JSON-RPC error on `turn/start`. Or `turn/completed` with no matching item: error the prompt. |
| Turn fails after start (model/API error) | Yes, before the errors | same | minted | none: already inserted, report via stop reason |
| Interrupt right after `turn/started` | Yes (still recorded) | same | minted | — |
| `UserPromptSubmit` hook blocks, or early step/skills/session-start/guardian error (source-only) | **No** | none. `turn/completed` arrives without a match. | — | error, or adapter-inserted (Open Q1) |
| `turn/start` on a busy thread | Yes, but late (next sampling boundary), inside the *old* turn | avoid: queue until `turn/completed` | — | — |
| `turn/steer` / `session/steer` | Yes, late (next sampling boundary). **Dropped silently on interrupt.** | userMessage `item/*` with matching `clientId` | minted | steer errors (`-32600` no active turn, mismatch, review/compact not steerable) |
| `/compact` (`thread/compact/start`) | **No** (only `contextCompaction`) | adapter-inserted live-only message on the `thread/compact/start` response | minted, live-only | JSON-RPC error on `thread/compact/start` |
| `/goal` (`thread/goal/set`, runtime turn) | **No** | adapter-inserted live-only message on the `thread/goal/set` response | minted, live-only | JSON-RPC error on `thread/goal/set` |
| `/review` (`review/start`) | Only an uncorrelatable one (`clientId: null`, reviewer prompt). The response has a synthesized item that is never replayed. | adapter-inserted live-only message on the `review/start` response. Ignore the `clientId: null` userMessage for correlation. | minted, live-only | JSON-RPC error on `review/start` |
| Plan-implementation second turn / goal continuation (codex-acp `turn/start`) | Yes (normal input) | no pending ACP prompt. If surfaced, match by `clientId`. | minted if passed (Open Q3) | — |
| Replay, codex-acp-submitted message | `userMessage` with `clientId` | — | `item.clientId` | — |
| Replay, foreign or legacy message | `userMessage` with `clientId: null` (id is UUID, or `item-N` on legacy) | — | `item.id` | — |

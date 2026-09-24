# Codex insertion follow-ups: (4) `ResponseItemHistoryFallback` user messages, (5) `/review` turn ids, (6) `_session/steering` and `clientUserMessageId`

**Sources checked:**
- codex-acp: `HEAD` `5f9335b`, with uncommitted edits in the working tree (`src/CodexAcpServer.ts`, `src/CodexCommands.ts`, `src/CodexAcpClient.ts` and the new `src/AcpV2Prompt.ts`). A programmer was editing while I researched, so line numbers in `src/CodexAcpServer.ts` can drift by about ±80. Every cite also names its function.
- Codex `openai/codex` @ `rust-v0.156.1` (`81e8e29`), which matches the installed `@openai/codex` 0.156.1. I read the files cached read-only in `/tmp/codex-research/src/` and also fetched `app-server-protocol/src/protocol/thread_history_projection.rs` and `app-server/src/thread_state.rs` with `gh api` at the same tag. Paths below are relative to `codex-rs/`.
- Real Codex 0.156.1 probes, run outside the repo: new scenarios `reviewfail` and `reviewint` in `/tmp/codex-research/probe2.mjs`, output in `/tmp/codex-research/out-review{fail,int}.txt`, plus the earlier `out-review.txt`.
- Local rollout corpus: 327 files in `~/.codex/sessions`, from Codex 0.146.1 to 0.156.1, surveyed read-only with `/tmp/codex-research/survey{,2}.py`.
- ACP spec `agent-client-protocol` @ `c16d6bf` (2026-09-23; `pull --ff-only` succeeded).
- I did not consult the TS SDK. None of the three questions depends on SDK runtime behavior.

**Confidence:** high for Codex behavior: the `/review` turn ids, the error turn ids and the interrupt rule were all observed live, and the history paths were read in source. Medium for the client-visible impact of the v1 `/review` error-attribution bug: I traced it in source but did not reproduce it through codex-acp end to end.

## Answer

**(4)** The fallback runs only in `streamThreadHistory` (`session/load` today, and v2 `replayFrom:start` if topic 5b reuses it), and only when all of these hold:
- the client has no native subagent support;
- `thread.path` can be read locally;
- the rollout has at least one `function_call` whose `call_id` is not a thread tool-call id.

It never yields user messages for paginated rollouts, which is every 0.155/0.156 main thread I observed. On legacy rollouts, Codex's own history already carries every `event_msg user_message` *with* `client_id`, so the fallback's user chunks are redundant. When they survive the merge they are wrong: no `messageId`, which is invalid in v2. **Recommendation for 5b:** use fallback user chunks only as ordering anchors and never emit them. Do not add `client_id` parsing.

**(5)** v1 detects the end of a `/review` correctly in `runReview`, which awaits the review/start response's (parent) turn id. But `CodexEventHandler` overwrites `currentTurnId` with the reviewer child's id from `turn/started`. As a result, `completesActiveTurn` is never true for a review, and `error` notifications (which carry the parent id) are treated as belonging to another turn. **That is a real, low-severity v1 bug.** However, `turn/interrupt` *requires* the child id: using the parent id returns `-32600`. So v2 2(a) must track two ids:
- the **completion id** (the review/start response `turn.id`), used for idle, errors and stop reason;
- the **interrupt id** (the latest `turn/started` id).

It should insert the live-only `user_message` on the review/start response, send `idle` exactly once when `turn/completed` arrives for the completion id, and never surface the `clientId: null` reviewer userMessage.

**(6)** Passing `TurnSteerParams.clientUserMessageId` is a judgment call, and I recommend it. Surfacing steered input as a v2 `user_message` is also not required by the spec (steering is out of ACP scope). I recommend it as well, but only when the matching userMessage item actually *lands*, never on the `turn/steer` response. A steer dropped by an interrupt then produces nothing, which matches Codex history. The `_session/steering` contract stays as it is.

## Requirements

| # | Requirement | Tier | Citation |
|---|---|---|---|
| R1 | Replayed chunks carry `messageId` (`ContentChunk.required = [messageId, content]`) | MUST (schema, v2) | ACP `schema/v2/schema.json` `$defs.ContentChunk` |
| R2 | During replay, each replayed message has an opaque, unique `messageId`. A retained user message inserted by `session/prompt` uses the ID from that prompt's response, even after a restart | MUST | ACP `docs/protocol/v2/session-setup.mdx:198-201` |
| R3 | `replayFrom: start` replays all *retained* history before responding. Live-only messages may be absent | MUST / MAY | ACP `session-setup.mdx:144-152` |
| R4 | Chunk-based replay first sends `user_message{content: []}` with the same id | MUST | ACP `session-setup.mdx:208-211` |
| R5 | A prompt-inserted message is reported via `user_message` or its chunks, with the returned id. Locally handled commands are live-only inserts | MUST | ACP `prompt-lifecycle.mdx:158,182`; `slash-commands.mdx:102-104` |
| R6 | Distinct inserted submissions get distinct ids | MUST | ACP `prompt-lifecycle.mdx:180` |
| R7 | Steering and queueing are outside the v2 prompt RFD | silent (out of scope) | ACP `docs/rfds/v2/prompt.mdx:86,279` |
| R8 | `session/cancel` must actually stop the work, then `idle`/`cancelled` after all other updates | MUST | ACP `prompt-lifecycle.mdx:530-561` (prior research) |
| C1 | `turn/interrupt` checks `turnId` against the app-server's `active_turn_id()`, which follows `TurnStarted`. For a review that is the **child** id | Codex fact (observed) | `app-server/src/request_processors/turn_processor.rs:1605-1615`; `app-server/src/thread_state.rs:171-173,197-218`; `out-reviewint.txt` |

## Details

### Q4 — `ResponseItemHistoryFallback`

**When it runs.** Only from `streamThreadHistory` (`src/CodexAcpServer.ts:2157-2190`). `session/load` calls it (`loadSession`, around `:900`). v2 `resumeSessionV2` still rejects `replayFrom:start` (`:940-952`), and topic 5b plans to reuse `streamThreadHistory`. All of the following gates must pass:
1. `clientSupportsSubagents(...)` is false. Otherwise `streamNativeThreadHistory` runs and the fallback is never called (`:2160-2169`; `src/subagents/AcpSubagents.ts:39-50`).
2. `thread.path` is non-null and readable by codex-acp (`src/ResponseItemHistoryFallback.ts:42-58`). A remote app-server or thread store means no fallback.
3. The parse returns non-null only if it recovered at least one `function_call` (a `response_item` or a legacy top-level record) with a `name` whose `call_id` is **not** among the thread's tool-call ids (`:108-129,153`; `toolCallIdsFromThread` `:156-194`). `custom_tool_call` records are never handled.

The feature was added for issue #206: tool activity missing from app-server history (PR #208, commit `62d2c64`).

**Which rollouts qualify in practice** (local corpus, `survey2.py`):

| Codex | History mode (`session_meta.history_mode`) | Rollouts where the fallback triggers |
|---|---|---|
| 0.153.2–0.155.1 | mostly paginated, some legacy | 5 / 314 (`wait`, `request_user_input`: tools with no ThreadItem) |
| 0.156.1 | 83 paginated main threads, 4 legacy (all `source: {subagent: "review"}`) | 0 / 87 |

Older rollouts from before `ItemCompleted` tool items (legacy mode) are the main population where it triggers.

**User messages in each Codex history source:**
- **Paginated** (0.155/0.156 main threads). History is projected only from `ItemCompleted(TurnItem)` (`app-server-protocol/src/protocol/thread_history_projection.rs:1-4,73-81`). The userMessage carries `id` (UUIDv7) and `clientId`.
  - These rollouts have no `event_msg user_message` records. The only one in the 0.156.1 corpus is a review subagent's legacy rollout.
  - So the fallback emits **no** user chunks for them. `role:"user"` response items are skipped on purpose (`ResponseItemHistoryFallback.ts:232-235`).
- **Legacy** (`ThreadHistoryBuilder`). Every `event_msg user_message` becomes a `userMessage` with `id: item-N` and `client_id` copied from the event (`thread_history.rs:503-520`). A live `ItemCompleted(UserMessage)` is ignored (`:626-660`).
  - So for any user message the fallback can see, the thread path already has one with the right `clientId`. The fallback's copy (`createUserMessageEventUpdates`, `:266-280`) has **no `messageId`**.

**What the merge does with fallback user chunks** (`mergeHistoryUpdates`, `src/CodexAcpServer.ts:3634-3690`):
- Each thread update is matched to a fallback update by exact key (which includes `messageId`) **or by content key** (`historyUpdateContentKey`, which ignores `messageId`).
- A matched fallback user chunk is consumed. Only the thread copy is emitted, and the fallback entries before it are flushed ahead of it. So in practice fallback user chunks serve as **ordering anchors** that place recovered tool calls in the right turn.
- An *unmatched* fallback user chunk is emitted with no `messageId`. Source-reasoned cases (not reproduced):
  - a local image: fallback `[@image](/p)` (`:283-306`) vs thread `[@name](file:///p)` (`src/CodexAcpServer.ts` `userInputToContentBlocks`/`formatUriAsLink`, around `:2527-2562`);
  - legacy turns removed by `ThreadRolledBack` (the builder drops them at `thread_history.rs:1364`; the fallback reads the raw file);
  - a legacy review prompt that 5b *hides* from the thread updates before the merge. Its fallback twin would then be unmatched and come back. This conflicts with the user decision to hide the reviewer prompt.

**Should it read `client_id`?** No.
- It would only fix ids for messages that have `client_id`, and the thread copy already covers exactly those.
- For messages without `client_id`, the replay id is `item.id` = `item-N`, which the fallback cannot reproduce reliably.
- Any fallback user chunk that survives is therefore either a duplicate or content that should not be shown.

**Recommendation (5b):** keep the fallback for tool calls. Keep its user chunks as internal merge anchors, but **drop every fallback `user_message_chunk` from the output**, whether matched or not. That makes the fallback's messageId question moot for user messages, satisfies R1/R2, and keeps the hidden reviewer prompt hidden. Doing the same on v1 is optional (it fixes the latent duplicate), and it is not needed for v2 conformance.

- **Adjacent issue, routed to Open questions:** fallback `agent_message_chunk` and `agent_thought_chunk` also have no `messageId` (`:237-244,254-264,339-351`). Unmatched ones would break R1 in v2 too.
- **Note for R4:** thread-path user chunks need a leading `user_message{content: []}`, or a full-content `user_message`, in v2.

### Q5 — `/review` turn ids and turn-end detection

**Observed on 0.156.1** (`out-review.txt`; `out-reviewfail.txt`; `out-reviewint.txt`):
1. The `review/start` response has `turn.id = P` (parent) and a synthesized `items[0]` userMessage (`id = P`, `clientId: null`).
2. `item/*` `enteredReviewMode` arrives with `turnId: P`.
3. `turn/started` arrives with `turn.id = C` (reviewer child). No parent `TurnStarted` exists (`core/src/session/review.rs:217-220`). The child's events are forwarded with the parent context (`core/src/tasks/review.rs:151-183`), and `send_event` stamps `Event.id = turn_context.sub_id` (`core/src/session/mod.rs:2348-2351`).
4. `item/*` userMessage arrives with `turnId: P`, `clientId: null`, carrying the reviewer prompt. Reasoning, command items and the like also arrive under `P`.
5. **`error` notifications carry `turnId: P`**: all 5 `willRetry:true` retries and the final `willRetry:false` (`out-reviewfail.txt`, 647–8002 ms).
6. `exitedReviewMode`, then `agentMessage`, both under `P`.
7. Exactly **one** `turn/completed`, with `turn.id = P` (`completed`, `failed` or `interrupted`). **Nothing ever completes `C`.**
8. **`turn/interrupt` with `P` returns `-32600 "expected active turn id P but found C"`. With `C` it succeeds**, and `turn/completed{id: P, status: "interrupted"}` follows (`out-reviewint.txt` 1699–1740 ms).
   - Reason: `active_turn_id()` comes from a `ThreadHistoryBuilder` fed by `TurnStarted` (`thread_state.rs:171-173,197-218`), and the check is at `turn_processor.rs:1610-1615`.

**What v1 does:**
- `runReviewCommand` → `runReview` calls `onTurnStarted(P)` on the response. That sets `sessionState.currentTurnId = P` (`src/CodexCommands.ts` `runReviewCommand`/`handleCommandTurnStarted` around `:327-396`; `src/CodexAcpServer.ts` `onTurnStarted` in `prompt()`, around `:3132`).
- `runReview` awaits `turn/completed` for `P` (`src/CodexAppServerClient.ts:317-338`). **So v1 gets the review's end right.**
- About 60 ms later, `CodexEventHandler` handles `turn/started` and sets `currentTurnId = C` (`src/CodexEventHandler.ts:557-560`). It stays `C` until `turn/completed` sets it to `null` unconditionally (`:561-565`).

**v1 consequences (report only, do not fix):**

| # | Where | Effect | Severity | Evidence |
|---|---|---|---|---|
| B1 | `completesActiveTurn` (`src/CodexAcpServer.ts:3100-3102`) | Never true for a review, because `P !== C`. `promptNotificationsActive` stays `true` until the handled-command branch sets it to `false` (`:3162-3164`). In that window, late notifications go through the prompt handler instead of the session-scoped handler. | low | source + observed ids |
| B2 | `createErrorEvent` (`src/CodexEventHandler.ts:1182-1207`) | Every review `error` (`turnId P`) takes the "not the current turn" branch. Clients with typed session failures then get the terminal failure **both** as a live session-failure update **and** in `PromptResponse._meta` (via `terminalFailurePromptResponse(…, P)`, `src/CodexAcpServer.ts` around `:3476-3493`; `getTerminalSessionFailureMeta` `CodexEventHandler.ts:280-293`), where normally it is returned only once (comment at `:1222-1223`). Other clients get a codex `_meta` session-info update instead of an agent text chunk, and `usageLimitExceeded`/auth errors no longer turn into a `RequestError`. | medium-low (a review hitting quota or auth errors) | Codex half observed; codex-acp half source-only |
| B3 | `completeRetryIncidentOnTurnProgress` (`CodexEventHandler.ts:1288-1297`) | Looks up the incident under `currentTurnId = C`, but retry incidents are recorded under `P`, so progress never clears a review retry warning. | low | source-only hypothesis |
| B4 | close: `markTurnStale`/`resolveTurnInterrupted` use `C` (`src/CodexAcpServer.ts:2873-2903`) | The synthesized `interrupted` completion is for `C`, while `runReview` waits for `P`. The prompt still exits through `closeSignal`, but the later real `P` completion is not marked stale. | low | source-only hypothesis |
| OK | cancel: `getInterruptibleTurnId` returns `currentTurnId` = `C` (`:2908-2913`) | **Correct by accident.** Codex requires `C` (item 8 above). Setting `currentTurnId` to `P` to "fix" B1/B2 would break `session/cancel` during a review. | — | observed |

Before `turn/started` arrives (about 60 ms after the response), `currentTurnId = P`, so a cancel in that window sends `P`. I did not probe whether Codex accepts that. It is plausible, because `active_turn_id()` may be unset or `P` then, and `turn_processor.rs:1616-1620` only rejects when not running.

**What v2 2(a) must do for `/review`:**
1. **Insertion.** When `review/start` succeeds, mint a UUID. Send the `{messageId}` response and a live-only `user_message{messageId, content: <the ACP prompt blocks as typed>}` (R5; `slash-commands.mdx:102-104`), then `state_update running`. If `review/start` fails, send a JSON-RPC error and no `user_message`.
   - Ignore the response's synthesized `items[0]` (`id = P`), which is never replayed.
   - The insertion matcher keyed on a minted `clientId` (`src/AcpV2Prompt.ts:29`) must **not** be used for reviews: no userMessage with a minted `clientId` will ever arrive, so the prompt would hang.
2. **Reviewer prompt.** Never surface the live `clientId: null` userMessage (turn `P`) as a `user_message`. This matches the replay decision to hide it. Rule: surface live userMessage items only when `clientId` is one this adapter minted for the session.
3. **Two turn ids per active turn:**
   - `completionTurnId = P`, from the response. Use it for turn end, error attribution (`error.turnId === P`), stop reason and failure meta.
   - `interruptTurnId` = the latest `turn/started` id (`C`), falling back to `P` until one arrives. Use it for `turn/interrupt`. Steering a review is rejected by Codex anyway (`"cannot steer a review turn"`, `turn_processor.rs:1076-1110`).
4. **Turn end and `idle`.** Send exactly one `state_update idle` with `stopReason` (`end_turn`, `cancelled` if `status: "interrupted"`, or a failure) when `turn/completed` arrives for `completionTurnId`. Take it from `runReview`'s result or an equivalent id match. Do not drive `idle` from a generic `turn/completed === currentTurnId` check (it never matches `C`), and never wait for `C` to complete (it never does). `idle` comes after every other update for the turn (R8 ordering).

### Q6 — `_session/steering` and `clientUserMessageId`

**What Codex does with a steered input** (prior research, observed; source here):
- `turn/steer` returns `{turnId}` immediately.
- The input goes into `pending_input` with `client_id = params.client_user_message_id` (`turn_processor.rs:1059-1066`; `core/src/session/turn_input.rs:686-693`).
- At the next sampling boundary, `run_hooks_and_record_inputs(…, PersistContext::SteeredUserInput)` records it (`core/src/session/turn.rs:426-446`). It emits `item/started`/`item/completed` userMessage under the **active turn's id**, with `clientId` equal to the steer's id (observed: `acp-msg-D`).
- If the turn is interrupted first, the input is dropped: no event and no history (`core/src/tasks/mod.rs:559,605`; `input_queue.rs:207-211`; observed `acp-msg-I`).
- A blocking `UserPromptSubmit` hook also records nothing.

**Today:**
- `steerTurn` sends no `clientUserMessageId` (`src/CodexAcpClient.ts:1165-1171`), so landed steers get `clientId: null`.
- v1 never surfaces userMessage items live (`src/CodexEventHandler.ts:857,932`).
- v1 replay shows landed steers with `messageId = item.id` (`src/CodexAcpServer.ts:2460-2470`).
- `_session/steering` returns `injected` on the `turn/steer` response, before the input lands (`performSteeringRequest`/`injectSteerIntoActiveTurn`, around `:1690-1750`).
- With no active turn it returns `startedNewTurn`, via `startNewTurnFromExternalPrompt` → an internal `prompt()` (around `:1788-1843`). That is the same path goal continuation uses.

**Spec position:** steering is outside ACP (R7). R5's MUST covers only `session/prompt` insertions. But R3 means a **landed** steer that Codex retains **will be replayed** under topic 5b, with id `clientId ?? item.id`. So whatever v2 shows live, the message appears on replay.

**Recommendations:**
- **Pass `TurnSteerParams.clientUserMessageId`** (a minted UUID on every `turn/steer`). Judgment call, recommended:
  - the field is stable, not experimental (`app-server-protocol/src/protocol/v2/turn.rs:295-296`);
  - the replay id becomes the adapter-owned `clientId` instead of `item.id`, which is `item-N` on legacy;
  - a landed steer becomes distinguishable from Codex-originated `clientId: null` messages such as the reviewer prompt, which the replay rule hides;
  - a steer landing can never be mistaken for a pending v2 prompt's insertion.
  - It is harmless on v1, since v1 ignores live userMessage items.
- **Surface steered input in v2 as `user_message{messageId: <steer id>, content}` when the matching userMessage item arrives.** Judgment call; not spec-mandated. It keeps live and replay consistent, and dropped steers correctly never appear.
  - Never emit it on the `turn/steer` response. That would claim an insertion that can still be dropped.
  - It must not resolve any pending `session/prompt` and must not change `state_update`. The turn is already `running`.
- **Keep the `_session/steering` response unchanged** (user decision). `injected` means "accepted by Codex", not "landed". Adding a `messageId` to the extension response is optional and would change the contract; I do not recommend it now.
- **The `startedNewTurn` path** goes through the internal `prompt()`. It should get the same treatment as the goal-continuation decision (#3): mint `clientUserMessageId` and surface the `user_message` on insertion. It then gets it for free if 2(a) implements #3 inside `prompt()`.
- **Needs a user decision:** a client that renders steer text optimistically (for example the JetBrains client using `steerSessionWithFallback`) would see a second copy when the v2 `user_message` arrives, unless it reconciles. There is no request/response `messageId` link for steers.

## Testability notes

- **Q4.**
  - Unit-test the (v2) merge with a legacy fixture: fallback `event_msg user_message` (local image) plus a recovered `function_call` not present in the thread. Assert that no emitted `user_message_chunk` lacks a `messageId`, that thread user chunks carry `clientId ?? item.id`, and that the recovered tool call keeps its position.
  - Add a variant where the thread-side reviewer prompt is filtered out. Assert that it does not come back from the fallback.
  - Existing fixture: `src/__tests__/CodexACPAgent/response-item-history-fallback.test.ts`, and `load-session.test.ts` data.
- **Q5.**
  - Fake app-server sequence: `review/start` response (`P`) → `turn/started(C)` → items(`P`), including userMessage `clientId: null` → `error(turnId P, willRetry:false)` → `turn/completed(P, failed)`. Assert:
    - the `{messageId}` response and live `user_message` come right after `review/start`, then `running`;
    - no `user_message` for the reviewer prompt;
    - exactly one `idle`, with the stop reason for `P`, last;
    - the error is attributed to this turn (not duplicated as a live failure plus `_meta`).
  - Cancel test: `session/cancel` after `turn/started(C)` must send `turn/interrupt{turnId: C}`. Before `turn/started` it sends `P`.
  - A v1 regression test for B2 would fail today. Record it as a known bug rather than asserting the current behavior.
- **Q6.**
  - Assert `turn/steer` params contain a UUID `clientUserMessageId`.
  - Emit userMessage `item/completed` with that `clientId` and assert a `user_message` with the same id and no `state_update`.
  - Steer, then `turn/completed(interrupted)` with no userMessage: assert no `user_message`.
  - A userMessage with `clientId: null` must not be surfaced.
- **Unobservable with fakes:** the Codex interrupt-id check and the no-child-completion behavior. Those need `/run-codex` or the probe.

## Discrepancies

- **Codex internal inconsistency (`/review`).** Live `turn/started` uses `C`. Live items, errors and `turn/completed` use `P`. `turn/interrupt` requires `C`. Persisted `ItemCompleted` payloads for the reviewer userMessage and reasoning use `C` (the rollout shows them under `C`, which history renders as a separate `interrupted` turn). Codex acknowledges the missing parent `TurnStarted` in a TODO (`core/src/session/review.rs:217-220`). This is not documented in the README.
- **ACP vs Codex (steering).** ACP has no steering. Codex's steer "success" does not mean insertion. The spec does not constrain codex-acp's `injected` outcome.
- **Spec vs the current fallback.** Fallback chunks without a `messageId` are schema-invalid on v2 (R1).

## Open questions

1. The fallback's `agent_message_chunk`/`agent_thought_chunk` updates have no `messageId`. Unmatched ones violate v2 R1. Drop them, or synthesize stable ids? (Topic 5b/6.)
2. How 5b identifies the "reviewer prompt" to hide on replay. `clientId: null` alone also matches foreign-client and legacy messages, which must fall back to `item.id`. In paginated history it sits alone in an `interrupted` turn right before the turn containing `enteredReviewMode`. What does legacy review history look like? (Topic 5b.)
3. Rolled-back turns: the fallback reads the raw rollout and can bring back rolled-back content (tool calls, user text) on v1 load. Needs its own check.
4. Does Codex accept `turn/interrupt` with `P` in the window before `turn/started(C)` (about 60 ms)? Not probed.
5. Foreign-client user messages (another app-server client on the same thread, `clientId: null` or an unknown id): the "surface only minted ids live" rule hides them live, while replay shows them. Acceptable?

## Recommendations

**Q4 (topic 5b):**
- Keep `ResponseItemHistoryFallback` for tool calls only.
- Use its user chunks as merge anchors, and drop all fallback `user_message_chunk`s from the emitted output.
- Do not parse `client_id`.
- Replayed user ids come only from thread items: `clientId ?? item.id`, sent as `user_message{content: []}` plus chunks, or as a full `user_message`.

**Q5 (topic 2(a)):**
- Per active turn, track `completionTurnId` (the `review/start` response id) and `interruptTurnId` (the latest `turn/started` id).
- Insert the live-only `user_message` on the `review/start` response, then send `running`.
- Hide the `clientId: null` reviewer userMessage.
- Attribute errors and send the single `idle` on `turn/completed(completionTurnId)`.
- Interrupt with `interruptTurnId`.
- v1 bugs B1–B4 exist. Do not "fix" them by setting `currentTurnId` to the parent id, because that breaks cancel.

**Q6 (topic 2(c)/10):**
- Pass a minted `clientUserMessageId` on every `turn/steer` (judgment call, recommended).
- In v2, surface a landed steer as `user_message` with that id on its userMessage item, never on the steer response.
- Keep the `_session/steering` response contract unchanged.
- Not spec-mandated, except that retained landed steers must be replayed (R3).
- **User decision needed:** whether the v2 steer `user_message` is acceptable, given possible duplicate rendering in clients that show steer text optimistically.

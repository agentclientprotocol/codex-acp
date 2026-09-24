# Topic 5b open questions: v2 `session/resume` + `replayFrom:{type:"start"}` history replay

**Sources checked:**
- codex-acp `HEAD` `7e2ec21`. Read via `git show HEAD:<file>` (snapshots in `/tmp/codex-research/q5b/head/`). The working tree has uncommitted 5b-1 edits to `src/CodexAcpServer.ts`; I ignored them. All `src/` line numbers below are HEAD lines.
- ACP spec `agent-client-protocol` @ `d880573` (2026-09-24, `pull --ff-only` OK). Subagents RFD from branch `origin/vbr/subagents-rfd` @ `a06ecf2`. It is unmerged, so treat it as a proposal only.
- ACP TCK `acp-tck` @ `64b62b6` (`src/tck/v2/requirements.py`, `src/tck/v2/conformance/test_session_capabilities.py`).
- Codex `openai/codex` tag `rust-v0.156.1` (commit `b412ff3`), shallow clone at `/tmp/codex-research/codex-0.156.1`. Paths below are relative to `codex-rs/`.
- Real Codex 0.156.1 read-only probe (`thread/read` + `thread/turns/list`, no writes). Script: `/tmp/codex-research/q5b/histprobe.mjs`. Outputs: `/tmp/codex-research/q5b/out-hist.txt` and `out-hist2.txt`. Run against existing local threads: 5 threads with reviews (completed, failed, S1-interrupted, S2-interrupted) plus normal threads. I also cross-checked live item ids against the earlier live probe `/tmp/codex-research/out-review.txt`, which is the same thread `01a0d0a5-d70b…`.
- Local rollout corpus `~/.codex/sessions` (Codex 0.146.1–0.156.1), surveyed read-only.
- TS SDK: not consulted. None of the questions depends on SDK runtime behavior, and the SDK does not validate outbound `session/update` (prior research).

**Confidence:** high for the Codex history shapes and ids (observed live and in history for 0.156.1) and for the codex-acp code paths (read at HEAD). Medium for legacy-mode review history and for rolled-back legacy rollouts: both are source-reasoned only, with no local samples.

## Answer

1. **Stable ids.**
   - v2 requires only that replayed ids are *unique and opaque*, and that a *retained `session/prompt` user message* reuses its prompt-response id. Nothing in the spec or the TCK requires agent/thought ids to be stable across replays or equal to live ids.
   - But the spec's `content: []` primer rule only makes sense if ids are stable, and codex-acp's own renderer already assumes they are. So deterministic ids are the right target (judgment call, SHOULD-level).
   - Review-mode chunks already have a stable id: `item.id` on `enteredReviewMode`/`exitedReviewMode`. It is persisted and equals the live item id.
   - Normal agent messages and reasoning already match live ↔ replay (`item.id`, observed).
   - For fallback agent/thought chunks, I recommend **not emitting them on v2**: treat them as merge anchors, like the fallback user chunks in 5b-1. The alternative is deterministic `fallback:<rollout line>` ids.
2. **Hiding the reviewer prompt.** In 0.156.1 history, the reviewer prompt is the **first item of a separate turn C** that is listed **immediately before** the review turn P (P's first item is `enteredReviewMode`). C's status is `interrupted`, it never contains an `agentMessage`, and C's UUIDv7 id is **greater** than P's, because C is minted after P. That last property is the discriminator that separates C from an ordinary previous turn.
   - The `/review`, `/compact` and `/goal` live-only `user_message`s leave nothing in Codex history, so there is nothing to replay for them.
3. **Interrupted reviews.** Replay renders items, not turns, so the empty interrupted C produces **nothing** on v1 today. Nothing special is needed on v2. What v2 needs for review turns in general: ids on the two review-mode chunks, and the hide rule for the non-empty C of a completed, failed or late-interrupted review.
4. **Subagents / async tasks.** Every v1 native-replay behavior maps onto `replayFrom:start` (the RFD's load flow): announce, child history, terminal, orphan `disconnected`, background-terminal recovery, and root `reconcile()`. Plain resume must keep doing none of them.
   - Today, once 5b-1 reuses `streamThreadHistory`, a v2 client that advertises AIR `nativeSubagentSessions` and resumes a thread containing `subAgentActivity` **fails the whole `session/resume` with -32603 mid-replay**, because `subagent_*` is fail-loud in the renderer.
   - Async-task announcements (`async_task_spawned`) also throw, but the error is caught and only logged. They are silently lost, after a stray `backgrounded` `tool_call_update` has already gone out.
5. **Rollback resurrection.** Still possible on 0.156.1, but only for **old legacy rollouts** that contain `thread_rolled_back` markers. 0.156.1 removed `thread/rollback`, and `thread/revert` writes a new rollout file instead of a marker, so new threads are not affected.
   - The fallback ignores the marker. A rolled-back turn's `function_call` is exactly the kind of "missing" call that triggers it, so those tool calls (and unmatched agent text) come back.
   - v2 impact: wrong content only. It is not a wire error once Q1's rule is applied.
6. **Other v2-invalid replay behavior.**
   - The **primer rule (RESUME-205) applies to agent and thought chunks too**, and to the native (subagent) replay path, not only to user chunks.
   - The hide rule must also cover the native path.
   - `current_mode_update` is never emitted.
   - No other fail-loud renderer case is reachable from history at HEAD.

## Requirements

| # | Requirement | Tier | Citation |
|---|---|---|---|
| R1 | `replayFrom:start`: replay all retained history via `session/update` before responding | MUST | spec `docs/protocol/v2/session-setup.mdx:144-147`, `:221-222` |
| R2 | Live-only messages, including locally handled commands, may be absent from replay | MAY | `session-setup.mdx:149-152`; `slash-commands.mdx:104` |
| R3 | Each replayed message has an opaque, **unique** `messageId` | MUST | `session-setup.mdx:198-199` |
| R4 | A retained user message inserted by `session/prompt` uses its prompt-response id, also after restart | MUST | `session-setup.mdx:199-201`; RFD `docs/rfds/v2/prompt.mdx:157-159` |
| R5 | Chunk-based replay of a message first sends the matching whole-message update (`user_message`/`agent_message`/`agent_thought`) with the same id and `content: []`. This applies to **all three** message kinds | MUST | `session-setup.mdx:208-212`; RFD `docs/rfds/v2/message-updates.mdx:65` |
| R6 | Stability of agent/thought ids across replays, or equality with live ids | not required (silent). v1 RFD: "doesn't require message IDs to be stable across session loads" | `docs/rfds/message-id.mdx:268-275`; v2 docs are silent |
| R7 | (Proposal) On load, orphans are terminated as `disconnected` after all of that child's persisted updates, descendants before parents, on the immediate parent. Repeated loads MUST give the same result | RFD proposal | `origin/vbr/subagents-rfd:docs/rfds/subagents.mdx:271-289` |
| R8 | (Proposal) `session/resume` without replay MUST NOT send standalone child terminal updates | RFD proposal | `subagents.mdx:291-298` |
| R9 | Custom `sessionUpdate` discriminators MUST start with `_` | MUST | `docs/protocol/v2/extensibility.mdx:117` (prior research `v2-subagent-and-custom-session-updates.md`) |
| T1 | TCK RESUME-202: every update before the response, none in a quiet period after it | TCK | `acp-tck src/tck/v2/requirements.py:775-786` |
| T2 | TCK RESUME-204: only a replayed message whose *content equals the prompt* and whose id differs fails. Absence is a SKIP | TCK | `requirements.py:798-811`; `test_session_capabilities.py:155-210` |
| T3 | TCK RESUME-205: every replayed `*_chunk` (user, agent **and** thought) is preceded by `<kind>{messageId, content: []}` | TCK | `requirements.py:813-824`; `test_session_capabilities.py:213-251` |

No TCK row checks agent/thought id stability or live ↔ replay equality.

## Details

### Q1: stable ids for id-less replayed agent/thought messages

**Where id-less agent/thought chunks come from in replay (HEAD):**
- `createReviewModeUpdate` sends an `agent_message_chunk` with no `messageId`, text `Entered review mode: <hint>` or `Exited review mode: <review>` (`src/CodexAcpServer.ts:2759-2771`, called at `:2712-2715`).
- Fallback assistant `response_item` messages: `createAgentMessageChunk(content, undefined, …)`, one chunk per content block (`src/ResponseItemHistoryFallback.ts:230-245`).
- Fallback `reasoning` response items: one chunk per summary/content part (`:334-351`).
- Fallback `event_msg agent_reasoning` (`:281-291`).
- On v2, the renderer gives each of these a **fresh `randomUUID()` on every send** (`src/AcpV2SessionUpdate.ts:105-107`). Its own comment says replayed history "must carry its own ids instead, since they have to be the same on every replay" (`:102-104`).
- Every other history message already has an id: `userMessage` (`:2725-2735`), `agentMessage` (`:2679-2687`), `reasoning` (`:2737-2741`), and plan-as-text.

**Does v2 require stability?** No, only uniqueness (R3) and prompt-id reuse for user messages (R4, T2).
- But the primer rule (R5) exists to "clear any content the Client already holds" (`session-setup.mdx:210-211`). With random ids, a client that keeps its transcript and replays again, for example after a reconnect, gets *duplicate* messages instead of in-place replacement.
- So deterministic ids are what makes replay idempotent. **Classification: judgment call (SHOULD-level), consistent with codex-acp's own stated design; not spec-mandated.**

**Do live and replay ids already match?** Yes for real Codex items in 0.156.1. Observed for thread `01a0d0a5-d70b…` (live `out-review.txt` vs history `q5b/out-hist.txt`):

| Item | Live id (`item/*`) | History id (`thread/turns/list`) | codex-acp live messageId | codex-acp replay messageId |
|---|---|---|---|---|
| agentMessage | `msg_01a0d0a5-e270-…` | same | `event.itemId` (`src/CodexEventHandler.ts:722-724`) | `item.id` |
| reasoning | `rs_09102e8d…` | same (but under turn C, see Q2) | `event.itemId` (`:802`, `:962`) | `item.id` (`src/CodexAcpServer.ts:2739`) |
| enteredReviewMode | `01a0d0a5-d77b-7133-bc56-e8f47012c4cf` | same | not rendered live (`CodexEventHandler.ts:872`) | **none** today |
| exitedReviewMode | `01a0d0a5-e26f-…` | same | **none**, so a random id on v2 (`CodexEventHandler.ts:1039-1044`) | **none** today |

- Paginated history projects the persisted `ItemCompleted(TurnItem)` payloads verbatim (`app-server-protocol/src/protocol/thread_history_projection.rs:73-81`), which is why the ids match.
- Legacy history (`ThreadHistoryBuilder`) uses the persisted `item_id` for review-mode events when present, and otherwise a deterministic counter `item-N` (`thread_history.rs:1180-1211`, Codex test `review_mode_events_replay_persisted_ids` `:1968-2015`). Either is stable across rebuilds of an append-only rollout.

**Stable sources:**
- *Review-mode chunks*: `item.id`, directly. It is distinct for entered and exited. **Recommendation:** set `messageId: item.id` in `createReviewModeUpdate`.
  - To keep v1 byte-identical, do it only on v2. On v1 the chunk has no `messageId` today, and adding one can change grouping in v1 clients.
  - Optional: also use `event.item.id` for the live v2 exited-review chunk, so the replay primer replaces the live text in place. The live and replay *texts* differ (no `Exited review mode:` prefix live), which is existing v1 behavior.
- *Fallback agent/thought chunks*: no Codex thread item exists for them by construction. The candidates are:
  - (a) the `response_item.payload.id` (`msg_…`/`rs_…`). It is present in 100% of the local corpus (0.146.1–0.156.1), but it is `Option` and skipped when absent (`protocol/src/models.rs` `ResponseItem`, `#[serde(default, skip_serializing_if = "Option::is_none")] id`), so older rollouts may lack it. `event_msg agent_reasoning` never has one.
  - (b) the rollout line index, stable because legacy rollouts are append-only.
  - (c) the turn id plus position. Not available: the fallback parses the raw file without turn boundaries.

**Options for fallback agent/thought chunks:**

| Option | Effect | Trade-off |
|---|---|---|
| **A (recommended). On v2, never emit fallback `agent_message_chunk`/`agent_thought_chunk`.** Keep them only as merge anchors, like 5b-1 does for fallback user chunks. Tool calls are still emitted | No id question. Satisfies R3/R5. Also suppresses rolled-back text (Q5) and hidden-review text | Loses agent text that exists *only* in the fallback. That text is normally a duplicate: the thread path has the same message and the merge consumes the fallback copy by content key (`mergeHistoryUpdates` `src/CodexAcpServer.ts:4213-4265`, content key `:4291-4300`). Real losses only in (i) rollouts so old that Codex builds no thread items from them (top-level legacy records, `ResponseItemHistoryFallback.ts:196-219`), which is hypothetical for 0.156.1, and (ii) content mismatches, which are duplicates anyway |
| B. Deterministic ids: one id per source record, `fallback:<lineIndex>`, shared by all blocks/parts of that record | Keeps v1-equivalent content | More code. Unmatched records still resurrect rolled-back text (Q5). Each record becomes its own v2 message, each needs a primer, and multi-block assistant records that don't match the thread's joined text show up as duplicate messages (hypothesis, latent on v1 too). Don't reuse `payload.id`: an unmatched fallback record with the same id as a thread item would be re-primed and clear the thread copy |

The fallback's gate means all of this only matters for rollouts that trigger it: 0 of 87 0.156.1 main threads (prior survey, `v2-codex-insertion-followups.md` Q4).

### Q2: identifying the `/review` reviewer prompt in 0.156.1 history

**Observed history shape (paginated, 0.156.1):**

| Thread | Scenario | Turn order from `thread/turns/list` (asc) |
|---|---|---|
| `01a0d0a5-d70b…` | completed | C `…d7b2…` **interrupted** [userMessage `clientId:null` = reviewer prompt, reasoning] → P `…d776…` completed [enteredReviewMode, exitedReviewMode, agentMessage] |
| `01a0d0b6-0f77…`, `01a0d0b5-cb04…` | failed | C (> P) interrupted [reviewer userMessage …] → P failed [enteredReviewMode …] |
| `01a0d0b6-e55f…` | interrupted after the reviewer started | C (> P) interrupted [reviewer userMessage] → P interrupted [entered, exited "Reviewer failed to output a response.", agentMessage "Review was interrupted…"] |
| `01a0d0d8-3284…` | interrupted in S2 (`lateP`) | C `…3310…` interrupted **[] (empty)** → P `…32d2…` interrupted [entered, exited, agentMessage] |
| `01a0d0d8-397f…` | normal turn, then review interrupted in S1 | T `…39cb…` completed [userMessage **`clientId:null`** "Reply with just OK.", agentMessage] → P `…42c5…` interrupted [entered, exited, agentMessage]. **No C** |

(`/tmp/codex-research/q5b/out-hist.txt`, `out-hist2.txt`; raw rollouts in `~/.codex/sessions/2026/09/24/`.)

**Why C looks like this (Codex source):**
- The reviewer's events are forwarded to the parent with `session.send_event` and persisted under their own turn id C. The reviewer's `TurnStarted(C)` carries `root_turn_id = P` in the rollout.
- `ItemCompleted(AgentMessage)` and agent deltas are **suppressed** (`core/src/tasks/review.rs:151-183`, suppression at `:159-165`). So **C never holds an `agentMessage`**. The final text is added to P via `exit_review_mode` (`:215+`).
- C gets no `TurnComplete`, so it reads back as `interrupted`.
- `root_turn_id` is **not** exposed on the v2 `Turn` (`src/app-server/v2/Turn.ts`), so codex-acp cannot read the C→P link directly.
- Why C is listed before P (P has no `TurnStarted`) was not traced in the store. It was observed in all 4 samples that have a C.

**Why `clientId: null` alone is useless:**
- v1 `turn/start` never sends `clientUserMessageId`: `insertion` is undefined on v1 (`src/CodexAcpServer.ts:3789`). So every v1-created user message has `clientId: null`, and so do legacy and foreign ones.
- Thread `…397f` shows the trap: a `clientId:null` real user turn sits **immediately before** a review turn P. An "any previous turn" rule would hide a real message.

**Candidate rule (recommended):** hide userMessage U iff all of the following hold:
1. `U.clientId == null`;
2. U is the **first item** of turn T;
3. the turn **immediately after** T in the list has an `enteredReviewMode` as its first item (turn P);
4. **`T.id > P.id`** as a string comparison of UUIDv7s, applied only when both are UUIDv7 (version nibble `7`). Codex documents turn ids as UUIDv7 (`app-server-protocol/src/protocol/v2/thread_data.rs:387`; `Turn.ts` doc). C is minted after P (observed gaps of ~60 ms: `…32d2`→`…3310`, `…d776`→`…d7b2`). An earlier real turn always has a smaller id;
5. (belt and braces) T contains no `agentMessage` and no other `userMessage`.

Rule 4 alone rejects the `…397f` false positive (`…39cb` < `…42c5`), and so does rule 5.

**Hide only U**, not the rest of C:
- C's reasoning and tool calls appear live under P today, and v1 renders them (`CodexEventHandler`, items routed by the P-scoped subscription).
- Replaying them keeps replay ≈ live.
- The reviewer userMessage is never shown live (`CodexEventHandler.ts:857,932`: `userMessage` is a no-op).

**Legacy-mode reviews** (unverified, no local sample):
- `ThreadHistoryBuilder` opens P implicitly on `EnteredReviewMode` and then `TurnStarted(C)` finishes it (`thread_history.rs:1213-1229`, `:1285-1295`). So in legacy history, P likely comes **before** C.
- The rule above then does not match, and the reviewer prompt is **shown**. That is a safe degradation, and it is today's v1 behavior.
- Do not extend the rule to "the turn after P": a normal next turn also has an id greater than P.

**Where to apply it:**
- Compute the hidden ids once from `thread.turns` as a pre-pass. Consult them in `createHistoryUpdates`, or filter `thread.turns`.
- Both replay paths must use it: the non-native path (`src/CodexAcpServer.ts:2441-2446`) and the native path (`:2457-2562`, which calls `createHistoryUpdates` at `:2549-2551`). Topic 10 will make the native path reachable on v2.
- 5b-1 never emits fallback user chunks, so the hidden prompt cannot come back through the merge. Paginated rollouts yield no fallback user chunks anyway.
- Optional: `findFirstUserMessageTitle` (`:2586-2598`) makes a thread that *starts* with `/review` take the reviewer prompt as its fallback title. It could skip hidden ids. That is a v1-visible change, and it is a title, not a message.

**Live-only command messages** (`/review`, `/compact`, `/goal`):
- `/review`: `review/start` takes no `clientUserMessageId` (`src/CodexAcpClient.ts:725-735`, `src/CodexAppServerClient.ts:320+`). The only persisted userMessage is the reviewer's `clientId:null` prompt (above). The response's synthesized `items[0]` (id = P) is not persisted as a separate message: none appears in any history sample.
- `/compact`: persists only a `contextCompaction` item, which is replayed as `compaction_update`, not a message.
- `/goal`: persists no userMessage (observed live, prior research, `state.md` insertion notes).
- So the minted ids of these live-only `user_message`s never reappear. That is conforming under R2.

### Q3: interrupted reviews: v1 today vs v2

- **v1 today** (`streamThreadHistory` iterates `turn.items` only, `src/CodexAcpServer.ts:2441-2446`; turn status is never rendered):
  - S2-interrupted (`…3284`): the empty C gives **nothing**. P gives `Entered review mode: <hint>` (agent chunk, no id), `Exited review mode: Reviewer failed to output a response.` (agent chunk, no id), and agentMessage "Review was interrupted. Please re-run /review…" (id `msg_…`).
  - S1-interrupted: P only, same three messages.
  - Interrupted after the reviewer started, completed, or failed: C first, giving `user_message_chunk` = reviewer prompt (id `item.id`), thought chunks and tool calls. Then P.
- **v2 should produce:** the same content, plus:
  - `messageId = item.id` on the two review-mode chunks (Q1);
  - the reviewer userMessage hidden (Q2);
  - primers (R5).
- The empty C needs **no handling**. There is no replay representation for turns or stop reasons, and nothing in the spec requires one.
- Nothing in 2(r)'s "empty interrupted C before P" finding breaks replay.

### Q4: subagent replay, orphan `disconnected`, async tasks on v2

**Current code (HEAD):**

`loadSession` = `getOrCreateSessionWithHistory` → `streamThreadHistory` → `asyncTasks.reconcile()` (`src/CodexAcpServer.ts:1140-1172`). `streamThreadHistory` takes the native path when `clientSupportsSubagents` (`:2426-2434`). The native path (`streamNativeThreadHistory`, `:2457-2562`):
- `subAgentActivity started` → `subagent_spawned` (`:2478-2484`); generation N>1 ids become `<thread>:generation:N`.
- It reads the child thread and recurses into its matching turn under the child session id (`:2486-2507`).
- It recovers the child's background terminals (`asyncTasks.recover`, `:2508-2516`, in try/catch).
- `completed`/`interrupted` → `subagent_state_update completed|cancelled` (`:2539-2544`). An unannounced terminal → spawned only (`:2521-2535`).
- `collabAgentToolCall` is skipped (`:2548`).
- At the end, every announced non-terminal child → `subagent_state_update disconnected` (`:2553-2561`). Nested orphans are emitted inside the recursive child stream, so descendants go before parents, which matches R7.

**Gate on v2:**
- `toV1ClientCapabilitiesView` copies `_meta` verbatim and leaves `subagents` absent (`src/AcpV2ClientCapabilities.ts:8-11,33-34`).
- So `clientSupportsSubagents` is true on v2 exactly when the client advertises AIR `nativeSubagentSessions` in `_meta` (`src/subagents/AcpSubagents.ts:39-50`). The TCK does not.
- Without it, `subAgentActivity` → `tool_call` and `collabAgentToolCall` → `tool_call` (`:2677-2678`, `:2704-2705`), which render fine on v2.

**Reachability of fail-loud during replay:**
- At HEAD it is unreachable: `resumeSessionV2` rejects `replayFrom` (`:1193-1207`).
- Once 5b-1 routes v2 through `streamThreadHistory`: `subagent_spawned`/`subagent_state_update` → `toV2SessionUpdate` throws -32603 (`src/AcpV2SessionUpdate.ts:119-127`). `ACPSessionConnection.update` propagates it (`src/ACPSessionConnection.ts:210-214`), so **`session/resume` fails mid-replay**, after partial updates.
- The trigger: an AIR-native v2 client + a thread with `subAgentActivity` items.
- Live native subagents on v2 fail the same way today (topic 10), so this is consistent with 6(a)'s fail-loud policy.

**Async tasks:**
- `reconcile()` → `syncThread` → `announce` → `publishSpawn` first sends a `tool_call_update` with `_meta…asyncTasks.backgrounded: true` (valid on v2), then `async_task_spawned`, which throws.
- The throw is caught in `reconcile` (`src/async-tasks/CodexBackgroundTerminalTasks.ts:110-116`, `:282-305`) and only logged.
- Net effect on v2: no fail-loud, but a **silent loss plus an orphaned `backgrounded` marker**.
- It is gated on AIR `asyncTasks` (`src/CodexAcpServer.ts:963-969`). `recover()` in the native path behaves the same way (try/catch).

**Which v1 behaviors apply on v2:**

| v1 load behavior | v2 `resume` + `replayFrom:start` | v2 plain `resume` |
|---|---|---|
| announce + child history under child session ids (+ generation ids) | yes, as `_subagent_update` announce (topic 10 rename) | no (and not done today: `resumeSession` streams nothing, `:1174-1191`) |
| terminal `completed`/`cancelled` | yes, `_subagent_update{state}` | no |
| orphan → `disconnected` at the end (descendants first) | yes (R7; the RFD's load flow maps onto `replayFrom:start`, `migration.mdx:757`) | **MUST NOT** (R8); nothing is sent today |
| background terminal `recover` / root `reconcile()` | yes, as `_async_task_*` (topic 10) | not today (`resumeSession` doesn't call `reconcile`) |
| primers for child message chunks | **new on v2**: R5 applies per child session too | — |

**Options for 5b:**
- (a) Leave it fail-loud until topic 10 adds the renderer cases. Document it, and optionally pin it with a test. The replay code then works unchanged, because the mapping is 1:1 (prior decision table in `v2-subagent-and-custom-session-updates.md`).
- (b) Force the non-native path on v2 until topic 10. Replay then shows subagents as tool calls. But the live router would still be native and still fail, so this is inconsistent.
- (c) Pull topic 10's four renderer cases into 5b.

**Recommendation:** (a), and schedule topic 10's renderer cases before any AIR v2 rollout. Make sure 5b's primer logic covers the native path so it just works after topic 10.

### Q5: `ResponseItemHistoryFallback` and rolled-back turns on 0.156.1

- **0.156.1 writes no new rollback markers.** `thread/rollback` was removed ("Requests use the generic unknown-method rejection path. Use `thread/revert` for paginated threads instead"). Old markers are still honored when Codex reads history (`app-server/README.md:291-300`).
- `thread/revert` writes a *new* rollout file that references the retained prefix (`history_base`) and swaps the SQLite path pointer. Old files stay intact (`thread-store/src/local/revert_thread.rs:15-18`, `:95-136`).
- Hypothesis (store path resolution not traced): `thread.path` then names the replacement file, so the fallback cannot see reverted records and resurrects nothing. It also cannot see the inherited prefix (pre-existing limitation, same for paginated forks).
- **Legacy rollouts that contain `thread_rolled_back` markers** (written by Codex ≤0.155 through `thread/rollback`):
  - Codex's builder drops the rolled-back turns (`thread_history.rs:1364-1380`).
  - The fallback parses raw lines and has no rollback handling (`src/ResponseItemHistoryFallback.ts:60-153`).
  - A rolled-back turn's `function_call` has a `call_id` absent from the thread, which is exactly the fallback's trigger (`:108-129`, `toolCallIdsFromThread` `:156-194`). So the fallback activates **because of** the rollback and re-emits those tool calls, plus unmatched assistant/reasoning chunks.
  - Still true on 0.156.1 for such files. Unverified empirically: the local corpus has 0 real `thread_rolled_back` events (the only grep hit was text inside a tool output).
- codex-acp never rolls back or reverts threads itself (no call in `src/`; it only no-ops `thread/reverted`, `src/CodexEventHandler.ts:662`). So only threads rolled back by another Codex client are affected.
- **v2 impact:**
  - Resurrected tool calls become valid `tool_call_update` upserts with wrong content.
  - Resurrected user chunks are already dropped by 5b-1.
  - Resurrected agent/thought chunks: dropped under Q1 option A; otherwise they need ids.
- **Recommendation** (small, fixes a real v1 bug too): if the rollout contains any `event_msg` of type `thread_rolled_back`, skip the fallback (return `null`). Matching Codex's exact turn-boundary rules (`thread-store/src/local/rollout_migration/rollback.rs:1-40`) is not worth it for this legacy-only case.

### Q6: other replay behavior that would be invalid on v2

1. **Primers for every chunked message (R5/T3).**
   - This covers user chunks (thread path), `agent_message_chunk` (agentMessage, review-mode, plan-as-text), and `agent_thought_chunk` (reasoning: *several chunks per item share `item.id`*, `src/CodexAcpServer.ts:2737-2741`).
   - Send exactly one `<kind>{messageId, content: []}` before the first chunk of each id, and none for a message that yields zero chunks.
   - It must work in the native path and for child sessions: the primer goes to the child `sessionId` the chunk is sent on.
   - The internal update type is v1-shaped and has no `user_message`/`agent_message`/`agent_thought`. So primers need a v2-only send, like `updateState` (`src/ACPSessionConnection.ts:201-207`), or whole-message conversion.
   - `mergeHistoryUpdates`'s global `seen` set (`:4219-4229`) already drops identical same-id same-content chunks. That is harmless for primers, but it dedupes two identical parts of one message (latent, v1 too).
2. **Random ids** (Q1): after 5b, no id-less agent/thought chunk may reach `toV2SessionUpdate` from the replay path. A determinism test (replay twice, compare ids) catches regressions. The existing guard only checks for empty ids, which the renderer never produces.
3. **`current_mode_update`**: never emitted anywhere in `src/`. The only reference is the renderer's throwing case (`src/AcpV2SessionUpdate.ts:85-89`). Not reachable from replay.
4. **Other fail-loud cases:**
   - `user_message_chunk` without an id: only fallback user chunks, which 5b-1 drops.
   - `subagent_*`/`async_task_*`: Q4.
   - `diff` and `terminal` content: rendered since 6(b)/6(c). Relative `terminal_info.cwd` is omitted (`src/AcpV2SessionUpdate.ts:208-212`).
   - Nothing else from `createHistoryUpdates` (`src/CodexAcpServer.ts:2669-2723`) is v2-invalid: tool calls → `tool_call_update`; `plan` → `plan_update` (always on v2, 9b); `contextCompaction` → `compaction_update` (v2 reports compaction support).
5. **RESUME-202 ordering:** `reconcile()` is awaited before the `loadSession` response (`:1156-1158`), so async-task updates land inside the replay window.
   - `publishMcpStartupStatusAsync` (`getOrCreateSessionWithHistory`, `:2400-2407`) can emit after the response, but only when `mcpServers` are requested. The TCK sends none. Worth a check by whoever wires v2 MCP config.

## Testability notes

- **Q1:**
  - Fake app-server with `thread/turns/list` returning a review turn (entered/exited items with ids). Assert that the v2 replay has `agent_message{messageId: <entered id>, content: []}` followed by a chunk with the same id.
  - Run replay twice in one test and assert identical `messageId` sequences (determinism).
  - Fallback fixture (legacy rollout with a recovered `function_call` and an assistant message): under option A, assert no `agent_message_chunk`/`agent_thought_chunk` without a matching thread item, and that the tool call is present.
  - v1 snapshots must stay byte-identical (`load-session.test.ts`, `response-item-history-fallback.test.ts`).
- **Q2:**
  - Fixture with the three observed shapes: completed (C>P with reviewer message), S2 (empty C), and `…397f` (clientId-null real turn before P, id < P).
  - Assert the reviewer text is absent in the first case, and that "Reply with just OK." **is** replayed in the third.
  - Negative case: a C-shaped turn where `T.id < P.id` must be shown.
  - Snapshot with `toMatchFileSnapshot()`.
- **Q3:** an S2 fixture with an empty C yields no updates for C. Pinned by the snapshot.
- **Q4:**
  - v2 client with `_meta.jetbrains.air.capabilities: ["nativeSubagentSessions"]` and a thread with `subAgentActivity started`. Today resume rejects with -32603. That is a known-gap pin, and topic 10 flips it.
  - Plain v2 resume emits no `_subagent_update`/`disconnected`.
  - Async tasks: fake `thread/backgroundTerminals/list` returning a running terminal. Assert today's behavior (a lone `backgrounded` `tool_call_update`, no task) as a known gap.
- **Q5:** legacy fixture with a `thread_rolled_back` record after a `function_call`. Assert the fallback is skipped (no resurrected tool call). Today it is resurrected, so this changes v1 output. Record it as an intended fix.
- **Q6:** the RESUME-205-style check in Vitest: for every replayed chunk, a prior `<kind>{content: []}` with the same id in the same session. Real TCK: `-k test_session_capabilities` (RESUME-202..205).
- **Unobservable with fakes:** Codex's C-before-P ordering and the UUIDv7 relation. They need real rollouts (use `/run-codex` or the probe) to catch future Codex changes.

## Discrepancies

- **codex-acp design vs spec:** the renderer comment requires replay ids to be "the same on every replay" (`src/AcpV2SessionUpdate.ts:102-104`). The spec only requires uniqueness, plus prompt-id reuse for user messages. The v1 message-id RFD explicitly does not require stability across loads (`docs/rfds/message-id.mdx:275`). Stricter is conforming.
- **Codex vs itself:** live review items (reasoning, the reviewer userMessage) carry turn id P, but persisted history files them under C (a separate `interrupted` turn listed before P). `root_turn_id` links them in the rollout but is not exposed on the v2 `Turn`.
- **Subagents RFD vs v2:** the RFD's replay flow is written for `session/load` (`subagents.mdx:271-289`), which v2 folds into `session/resume` + `replayFrom` (prior research). Its v2 section uses unprefixed `subagent_update`, while codex-acp decided on `_subagent_update` (R9; topic 10).
- **Codex README vs generated types:** `thread/rollback` is removed in 0.156.1 (README), but `src/app-server/v2/ThreadRollbackParams.ts` is still generated, without a matching `ClientRequest` method. Harmless.

## Open questions

1. Q4: resuming (with replay) a session whose subagent is **still running** in the same app-server. The orphan rule marks it `disconnected`, but live child events may keep arriving, which the RFD forbids ("MUST NOT revive"). Owner: topic 10 / 5b follow-up.
2. `state_update` after replay when Codex reports an in-progress turn at resume time: `thread/turns/list` merges the active turn snapshot (`app-server/src/request_processors/thread_processor.rs:3098-3107`). The spec has no initial state on resume. Is a `running` expected? Owner: topic 2/5.
3. The fallback reads only `thread.path`. For paginated forks and reverts (`history_base`) it misses inherited-prefix records (pre-existing limitation; fallback scope).
4. Legacy-mode review history shape (P before C?) is unverified. A real legacy rollout with `/review` would settle whether the reviewer prompt stays visible there.
5. `publishMcpStartupStatusAsync` emitting after the resume response when MCP servers are requested (RESUME-202 quiet period). Owner: topic 7/5.

## Decisions needed

- **Q1 (user):** fallback agent/thought chunks on v2: **drop them (A, recommended)** or give them deterministic ids (B)? Also: review-mode ids on v2 only (recommended) or on both versions?
- **Q2 (user):** apply the reviewer-prompt hiding on v1 `session/load` too (it removes text v1 shows today), or on v2 only (recommended default, preserves v1)? Please confirm the UUIDv7-ordering rule is acceptable (it relies on Codex's documented UUIDv7 turn ids).
- **Q4 (orchestrator):** accept the fail-loud resume for AIR-native v2 clients until topic 10 (recommended), or pull the renderer cases into 5b.
- **Q5 (user):** skip the fallback when a rollout contains `thread_rolled_back`. This is a v1 behavior change, and it is a bug fix.
- Q3, Q6: no decision needed.

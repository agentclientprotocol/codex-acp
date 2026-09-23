# In ACP v2, what must an agent do, and when, for a `session/prompt` that arrives while a turn is running, if it QUEUES it? The same question for locally handled prompts (slash commands).

**Sources checked:**
- ACP spec `agent-client-protocol` @ `c2452704b53af74238d11d9fb0d5f816b802f9df` (2026-09-23). `pull --ff-only` said "Already up to date". Stable `docs/protocol/v2/*` (the `draft/` copies are identical in every passage cited here), `docs/rfds/v2/prompt.mdx`, `schema/v2/schema.json`.
- ACP TypeScript SDK `acp-typescript-sdk` @ `69fda3703bfb3a33d2f0e9fa6b90081270297d4c` (`v1.5.0-1`, 2026-09-23; already up to date). Since `v1.5.0`, `src/examples/dual-version-agent.ts` is unchanged and `src/v2/acp.ts` only changed its stream-option plumbing.
- ACP TCK `acp-tck` @ `5418887d4c56f007ca59ab344696a71db750f694` (2026-09-23). Its citations are pinned to spec `8f76d6c` (`src/tck/v2/protocol.py:24`), so its line numbers differ from spec HEAD.
- codex-acp (this repo, branch `eugenethedev/acp-v2`): `src/CodexCommands.ts`, `.agents/state.md`, `.agents/research/v2-prompt-lifecycle-and-turn-state-machine.md`.

**Confidence:** high on insertion, response and cancel MUSTs, because the spec text is explicit and repeated across the docs, the RFD and the schema. Medium on the `state_update` sequence between queued turns and for local commands. The spec does not define queueing at all, so those parts are our choice, and I state them as recommendations with reasons.

## Answer

ACP v2 does not define queueing (RFD `docs/rfds/v2/prompt.mdx:86`, `:279`). It does define one rule a queued prompt cannot avoid: **the successful `{messageId}` response means the user message has been inserted into the ACP conversation, and it MUST NOT be sent just because the prompt was received, queued, or given an ID.** Two design choices follow from that rule:

1. **Recommended:** keep the queued prompt's `session/prompt` request **pending**. When its turn actually starts, insert it: send the response plus the live `user_message` (same `messageId`), then `running`. The RFD explicitly allows this: "keeps the prompt request pending until insertion or rejection" (`prompt.mdx:324`).
2. **Also legal, not recommended:** really insert the message on receipt. That places it in the transcript in the middle of turn A's output, which Codex's own thread history will contradict on replay.

Between A and B, the spec is most consistent with **`idle`+`stopReason(A)`, then `running` for B**. Sending no `idle` (one continuous `running`) is arguably allowed, but A's stop reason is then never reported. `session/cancel` is only defined for "active session work". Queued prompts are not addressed, so what happens to them is our choice. I recommend that cancel **drops** all queued prompts that have not been inserted: each gets a JSON-RPC `-32800` error, none gets a `user_message` or `state_update`, and exactly one `idle`/`cancelled` is sent for the running turn.

Locally handled commands follow the same insertion rule. The adapter may insert a live-only user message immediately, without waiting for a runtime event. The spec says nothing about `state_update` for them. I recommend `running` → output → `idle`/`end_turn`, because the SDK's `readText()` and the TCK's driver both wait for an `idle`. When a turn is already running, the local command waits in the same FIFO queue.

## Requirements

All `session/*` rows fall under `capabilities.session`. The TCK classifies every one of them as `Tier.CAPABILITY` (`acp-tck/src/tck/v2/requirements.py:14-21`). The tier column below gives the spec's own strength.

| # | Requirement | Tier | Citation |
|---|---|---|---|
| R1 | A prompt is accepted when it is **inserted**, not when it is received, queued, or finished processing. Once the user message is inserted into the ACP conversation, the agent must respond successfully without waiting for foreground work to finish. | MUST | spec `docs/protocol/v2/prompt-lifecycle.mdx:139`; `migration.mdx:251` |
| R2 | The agent must not send a successful response just because it received the input or assigned an ID. "Merely receiving, queueing, or assigning an ID … does not justify a successful response." | MUST NOT | spec `prompt-lifecycle.mdx:139`; `migration.mdx:251`; `schema/v2/schema.json:4098` (PromptResponse "does not indicate that the prompt was merely received or queued"); RFD `docs/rfds/v2/prompt.mdx:41,43` ("holding the input for later insertion is not acceptance") |
| R3 | A request rejected before insertion gets a JSON-RPC error response. | MUST (stated as the mechanism) | spec `prompt-lifecycle.mdx:139`; RFD `prompt.mdx:43` |
| R4 | `result.messageId` is required, non-null and a string. | MUST | spec `prompt-lifecycle.mdx:153-156`; `schema/v2/schema.json:4097-4130` |
| R5 | The inserted message is reported with a `user_message` update (full `content`) or with `user_message_chunk` updates, and every update for it uses the returned `messageId`. | MUST | spec `prompt-lifecycle.mdx:158`; `migration.mdx:261`; `slash-commands.mdx:102` |
| R6 | The response and the updates may arrive in either order. Clients MUST tolerate both. | MAY (agent side) | spec `prompt-lifecycle.mdx:158`; RFD `prompt.mdx:72` |
| R7 | Each inserted submission gets a distinct `messageId`, even when the content is identical. | MUST | spec `prompt-lifecycle.mdx:180`; RFD `prompt.mdx:70` |
| R8 | Every inserted input is reported live, including a locally handled command. Retention is optional. If the message is replayed, it keeps the same ID. | MUST (live report, same ID on replay); MAY (retention) | spec `prompt-lifecycle.mdx:182`; `migration.mdx:301` |
| R9 | A locally handled command that the runtime does not record: the adapter inserts a live-only user message. It need not wait for a runtime insertion event. If replayed, the command keeps the same ID and is not executed again. | MUST (same contract); MAY (live-only) | spec `slash-commands.mdx:102-104`; RFD `prompt.mdx:45,308-310` |
| R10 | Whenever foreground work starts or resumes, send `state_update {state:"running"}`. | MUST | spec `prompt-lifecycle.mdx:188`; `migration.mdx:278` |
| R11 | When the agent is ready to process a new prompt, it reports `idle`. If that transition ends foreground work, it includes the `stopReason`. | MUST (docs), but see D1 (the schema says SHOULD for `stopReason`) | spec `prompt-lifecycle.mdx:377,491`; `migration.mdx:282`; `schema/v2/schema.json:4909` |
| R12 | The agent may stop foreground work at any point with an idle `state_update` + `stopReason`. | MAY | spec `prompt-lifecycle.mdx:394` |
| R13 | While blocked on user action, report `requires_action`. On resume, report `running`. | SHOULD | spec `prompt-lifecycle.mdx:400`; `migration.mdx:309` |
| R14 | Background updates may flow while the agent is `idle`, and they do not change the state. | MAY | spec `prompt-lifecycle.mdx:39,526` |
| R15 | On `session/cancel`, stop model requests and tool calls as soon as possible. | SHOULD | spec `prompt-lifecycle.mdx:546` |
| R16 | After aborting, send `idle` with `stopReason:"cancelled"`. All updates for the cancelled work come before it. Abort exceptions are caught and reported as `cancelled`. | MUST | spec `prompt-lifecycle.mdx:548,555,559`; `migration.mdx:317` |
| R17 | `session/cancel` covers "active session work". Queued, not-yet-inserted prompts are not mentioned. | **silent** | spec `prompt-lifecycle.mdx:530-561` (no text on queues) |
| R18 | `$/cancel_request` for a pending request: the agent MAY cancel it, but MUST send either a valid response or a `-32800` error. | MAY cancel / MUST respond | spec `docs/protocol/v2/cancellation.mdx:16-22` |
| R19 | Internal cancellation (e.g. the agent drops a request itself) should send the same `-32800` error. | SHOULD | spec `cancellation.mdx:35-38`; `schema/v2/schema.json:4189` ("aborted … due to a cancellation request … or because of resource constraints or shutdown") |
| R20 | `session/close` cancels ongoing work as if `session/cancel` had been sent, then frees resources. | MUST | spec `docs/protocol/v2/session-setup.mdx:258` |
| R21 | Queueing, steering, and whether an agent inserts new prompts while busy. | **silent / explicitly out of scope** | RFD `prompt.mdx:86,279`; RFD `docs/rfds/v2/overview.mdx:115` |
| R22 | FIFO order, queue limits, queue-full rejection, error code for "busy". | **silent** (`error.mdx` is "Documentation coming soon") | spec `docs/protocol/v2/error.mdx:6` |

## Details

### 1. Response timing for a queued prompt

- "Inserted into the conversation" means the agent has added the user message to its ACP conversation, **with a `messageId` and a position relative to other messages** (RFD `prompt.mdx:41`). Insertion is a logical event. It does not mean durable storage or that the model has consumed the input (`prompt-lifecycle.mdx:182`; RFD `prompt.mdx:45`).
- For an adapter, the underlying runtime's user-message echo or insertion event can serve as evidence of insertion. **"An ID assigned in advance is not by itself evidence of insertion."** (RFD `prompt.mdx:76`)
- The spec expects insertion to be delayed sometimes. The RFD lists "insertion is delayed" as a reason clients must not correlate by arrival order (`prompt.mdx:29`). It also chose to "keep the prompt request pending until insertion or rejection". An earlier "queued" receipt would be "a separate acknowledgment" that ACP does not define today (`prompt.mdx:324`).
- **Consequence:** for a prompt codex-acp holds in a queue, the `{messageId}` response **MUST NOT** be sent on receipt (R2). It is sent when the prompt is inserted, which in our design is when its turn starts. If the prompt is dropped before insertion, it gets a JSON-RPC error (R3).
- Option (2) from the Answer, inserting on receipt, is technically legal: codex-acp could declare the message inserted into the ACP conversation immediately and send the response and `user_message` right away. **Not recommended.** Its placement would fall in the middle of A's still-streaming output, while Codex records B's user message only after A's items. Live order and replay order would then disagree, and the thread history is what `session/resume` replays. It would also leave an inserted but unprocessed message behind if the user cancels (see §4).
- **SDK mechanics:** the TS SDK runs request handlers concurrently. `receiveMessage` is not awaited per message (`acp-typescript-sdk/src/jsonrpc.ts:1333-1343`). A `session/prompt` handler that stays pending does not block later `session/cancel`, `$/cancel_request` or other requests. The handler's `signal` aborts on `$/cancel_request` (`jsonrpc.ts:455-459`). An `AbortError` thrown after that abort is turned into a `-32800` response (`jsonrpc.ts:636-653`).

### 2. `user_message` for a queued prompt

- It is reported **when the prompt is inserted** (R5), which is the same moment the response becomes valid. It uses exactly the response's `messageId`. The order relative to the response is free (R6).
- Sending `user_message` before insertion would itself be an insertion claim, because the update "establishes its content and placement" (RFD `prompt.mdx:84`). So option (1) sends nothing for B while it waits.
- IDs: B's ID is distinct from A's and from every other submission (R7). If the message is replayed later, the ID stays the same (R8).
- Reference order in the SDK example: the response is queued first, then `user_message`, then `running` (`src/examples/dual-version-agent.ts:129-137,226-236`). The example defers processing with `setTimeout(0)` so that the "insertion receipt is queued first". That is style, not a requirement.

### 3. `state_update` sequence: A running, B queued, A completes, B runs, B completes

The spec gives two relevant MUSTs:
- `running` "when foreground work starts or resumes" (R10).
- `idle` "when the Agent is ready to process a new prompt", with a `stopReason` "when the transition ends foreground work" (R11).

It never addresses one turn following another. Two readings are consistent with it:

- **(a) Idle between turns. Recommended.**
  `running` (A) … `idle`/`stopReason(A)` → [B inserted: response + `user_message`] → `running` (B) … `idle`/`stopReason(B)`.
  - A's stop reason is reported. This matters most for `refusal`, which per `schema.json` StopReason means the user prompt and everything after it is dropped from the next prompt, and for `max_tokens`.
  - Every `idle`-with-`stopReason` is preceded by a `running` in the same turn, which is what the TCK checks (ACP-STATE-201).
  - Clients that treat each `idle` as the end of a turn stay correct.
- **(b) Continuous `running`.**
  `running` (A) … [B inserted] … one final `idle`/`stopReason(B)`.
  - Defensible: "A prompt starts **or contributes to** foreground work" (`prompt-lifecycle.mdx:6`), and the agent is never "ready" in between.
  - Drawback: A's `stopReason` is lost, because v2 has no other place to carry it (`migration.mdx:236,313`).
- **Not allowed:** `idle`+`stopReason` for B without a `running` since the previous idle. That breaks R10 and would fail ACP-STATE-201.
- `requires_action`/`running` pairs inside either turn follow R13 as usual. A queued B has no effect on them.
- A race comes with (a): after `idle(A)`, a client may send prompt C before B's `running` arrives. That is harmless. C is simply queued behind B.

### 4. Cancellation with a queue

- **Spec:** `session/cancel` cancels "active session work" (`prompt-lifecycle.mdx:530`). The agent aborts and then MUST send `idle`/`cancelled`, after every other update for the cancelled work (R16). The spec says **nothing** about queued prompts (R17).
- **Recommended choice: drop the queue.** Every queued, not-yet-inserted prompt gets a JSON-RPC **error `-32800` (Request cancelled)**. The code fits because it covers "aborted … due to a cancellation request … or because of resource constraints or shutdown" (`schema.json:4189`; also R19). Dropped prompts were never inserted, so they get **no `user_message`, no `state_update` and no `stopReason`**. The running turn A ends with exactly **one** `idle`/`cancelled`.
- **Why drop:**
  - The TCK's client-visible form of ACP-CANCEL-202 is "after the cancelled idle, no further `state_update` for this session arrives within the quiet period unless a new prompt was sent" (`requirements.py:407-418`; `test_cancel.py:189-240`). Starting B right after `idle(cancelled)` looks exactly like that failure.
  - Users expect "stop" to stop everything.
- **Keeping the queue** (start B after `idle(cancelled)`) is also spec-legal, since R17 is silent. It is not recommended, for the reasons above.
- **Race:** cancel arrives after B was dequeued and its turn start was requested, but before insertion is confirmed.
  - If insertion then succeeds, B **is** inserted. Report the response + `user_message`, then `running`, interrupt, then `idle`/`cancelled`. Skipping `running` would break R10 and ACP-STATE-201.
  - If B can still be aborted before insertion, respond `-32800` and send no `state_update`. The last reported state, `idle(A)`, is still true.
- **`$/cancel_request` for one queued B:** remove only B and respond `-32800` (R18). A and the rest of the queue are not affected.
- **`session/close`:** treat it as cancel (R20). Also answer every queued request with `-32800` before responding `{}` to the close.

### 5. Locally handled prompts (slash commands with no model turn)

- **Insertion:** the same contract as any prompt (`slash-commands.mdx:102`). The adapter inserts a **live-only** user message itself. It need not wait for a runtime event that will never come (`slash-commands.mdx:104`; RFD `prompt.mdx:308`). It sends the response `{messageId}` and a `user_message` with that ID.
  - Retaining it is optional.
  - If it is retained and replayed, it keeps the same ID and is **not executed again** (R9).
- **`state_update`:** the spec is silent. "Foreground work" is not defined for zero-model-turn commands, and the TCK itself notes "the spec doesn't say a zero-work prompt must still emit it" (`acp-tck/src/tck/v2/conformance/test_prompt.py:129-130`).
  - **Recommended:** `running` → command output (`agent_message`, `config_option_update`, etc.) → `idle`/`end_turn`.
  - Why: any client that waits for an `idle` after `session/prompt` would otherwise hang. The SDK's `ActiveSession.readText()` loops until a `stop`, which is produced only for an idle `state_update` (`src/v2/acp.ts:1916-1919,1945-1956,2838-2850`). The TCK's `run_prompt` ends a turn only on such an idle and otherwise times out (`acp-tck/src/tck/v2/conformance/_helpers.py:686-701`).
  - An `idle` with `stopReason` must not be sent without a preceding `running` (ACP-STATE-201).
  - **Also legal:** no `state_update` at all. The output then counts as updates emitted while idle (R14). Not recommended, because of the hang above.
- **When it arrives while A is running:** under the user decision (`.agents/state.md:186-193`), it waits in the same FIFO queue. Its request stays pending (R2), and it runs as its own mini-turn after `idle(A)`.
  - **Also legal, not recommended:** run it immediately, out of band. It would then be inserted mid-A, and it must send **no** `running`/`idle`, because an `idle` would falsely end A in the client's view. This mixes in-order and out-of-order semantics.
- **codex-acp specifics** (this repo, `src/CodexCommands.ts`):
  - **Truly local:** `/plan` (`:217`), `/status` (`:267`), `/rename` (`:274`), `/logout` (`:282`), `/skills` (`:289`), `/mcp` (`:303`), and the usage-message error paths (`:219,246,257,276`).
  - **Start real Codex turns:** `/compact` (`:228`), `/review*` (`:239-265`) and `/goal` (`:236`). These follow the normal prompt/queued-prompt flow. Codex may not emit its own user-message item for them (unverified hypothesis, see Open questions). If so, the adapter inserts an adapter-owned live-only user message when the turn starts.

### 6. Ordering and limits

- The spec is silent (R21, R22). FIFO order, queue size, and rejecting with an error when full are all our choices.
- Rejection must be a JSON-RPC error before insertion (R3). No ACP error code exists for "busy" or "queue full".
- The reference SDK example rejects **any** overlapping prompt with `-32600` invalidRequest (`dual-version-agent.ts:110-114`).
- Recommendation: strict FIFO per session. Add no limit unless needed. If a limit is added, reject with `-32603`, or a `-32000..-32099` implementation code with a clear message, and keep the TCK's "error, not silence" framing in mind.

### 7. What the TCK asserts here

| ID | Tier | What the test observes |
|---|---|---|
| ACP-PROMPT-201 | CAPABILITY | A single idle-session prompt's result is an object with a non-empty string `messageId` (`test_prompt.py:24-46`; `requirements.py:182-194`). |
| ACP-PROMPT-203 | CAPABILITY | A `user_message`/`user_message_chunk` arrives with the **same** `messageId`, before or after the response, no later than the turn-ending idle (`test_prompt.py:49-90`; `requirements.py:196-209`). |
| ACP-STATE-201 | CAPABILITY | If an idle with a `stopReason` is seen, a `running` for that session was seen earlier in the same `run_prompt` call. FAILs otherwise (`test_prompt.py:93-119`; `requirements.py:211-227`). |
| ACP-STATE-202 | CAPABILITY | If `running` was seen, an idle arrives within the timeout. SKIPs if no `running` was seen (`test_prompt.py:122-146`). |
| ACP-STATE-203 | CAPABILITY | The idle that ends an observed `running` carries a known or `_`-prefixed `stopReason` (`test_prompt.py:149-177`). |
| ACP-CANCEL-201/207 | CAPABILITY | After `session/cancel` during work, an `idle` with `stopReason:"cancelled"` arrives (`requirements.py:393-405,478-490`). |
| ACP-CANCEL-202 | CAPABILITY | No further `state_update` for the session within the quiet period after `idle(cancelled)` (`test_cancel.py:189-240`). |
| ACP-CANCEL-203 | CAPABILITY | Cancel never shows up as a JSON-RPC error on the (already answered) prompt, nor as an idle with a non-`cancelled` known reason (`requirements.py:420-432`). |
| ACP-CANCEL-208 / CLOSE-202 | CAPABILITY | `session/close` during work produces the same `idle(cancelled)` (`requirements.py:492-504`). |
| **ACP-INFO-CONCURRENT-201** | INFORMATIONAL | Sends two `session/prompt`s back-to-back, then only **records** what happens to the second one: "replied with error code X", "replied with a result", or silence within the quiet period. It never asserts, and silence (a pending request, which is our queued behavior) is an accepted outcome (`test_informational.py:72-100`; `requirements.py:367-380`). |

- No TCK requirement covers queueing, queue cancellation or slash commands.
- `run_prompt` itself says "Callers must serialize prompts per session … both reference agents reject it" (`_helpers.py:739-741`).

## Testability notes

- **Deferred response for a queued prompt (R1/R2).** With a fake Codex client that holds turn A open, send prompt B.
  - Conforming: no response for B's JSON-RPC id and no `user_message` for B until after A's `idle`.
  - Non-conforming: B's response arrives while A is still `running`.
  - Record one ordered wire transcript (responses and notifications interleaved) and snapshot it with `toMatchFileSnapshot()`. Replace `messageId` values with stable placeholders such as `<msg-A>` and `<msg-B>`, and assert the ID equalities separately.
- **ID correlation (R5/R7).** Assert that B's response `messageId` equals B's `user_message.messageId`, and that it differs from A's. Do not assert the relative order of response and `user_message`, because both orders are legal (R6).
- **Sequence (§3a).** Assert this subsequence on the transcript: `running`, `idle(stopReason A)`, `resp(B)`/`user_message(B)` in any order, `running`, `idle(stopReason B)`. Also assert that every `idle` with a `stopReason` is preceded by a `running` since the previous idle, which mirrors ACP-STATE-201.
- **Cancel with a queue (§4).** Hold A, queue B and C, then send `session/cancel`.
  - Assert B and C get error responses with code `-32800`.
  - Assert B and C have no `user_message`.
  - Assert exactly one `idle(cancelled)`, and no `running` after it unless a new prompt is sent.
  - For `$/cancel_request` on B: only B is answered `-32800`, and A keeps running.
- **Local command (§5).**
  - When idle: `/status` gives response + `user_message` (same ID) → `running` → `agent_message` → `idle(end_turn)`.
  - When queued behind A: nothing for `/status` until after `idle(A)`.
  - When replayed: if retained, same ID and no re-execution. The fake client must see no second `rate-limits`/`listSkills` call.
- **Unobservable:** "insertion" itself is a logical event. Only its proxies (the response and `user_message`) can be observed. "Stop as soon as possible" (R15) cannot be tested.

## Discrepancies

- **D1: `stopReason` strength.** The docs say MUST include `stopReason` when the idle ends foreground work (`prompt-lifecycle.mdx:377`; `migration.mdx:282`). The schema field doc says "Agents SHOULD include this" (`schema/v2/schema.json:4909`). The TCK enforces presence only on the idle that ends an observed `running` (ACP-STATE-203). Always include it.
- **D2: reference SDK agent rejects, spec allows queueing.** `dual-version-agent.ts:110-114` throws `invalidRequest` on any overlapping prompt. The spec neither requires nor forbids queueing (R21), and the TCK says "both reference agents reject it" (`_helpers.py:741`). codex-acp's queueing is a legal divergence from the reference, not a conflict with the spec.
- **D3: SDK client helper cannot attribute queued turns.**
  - `ActiveSession.beginPrompt` marks overlapping prompts as un-attributable (`src/v2/acp.ts:1195-1210`).
  - The **first** idle completes **all** outstanding prompts (`acp.ts:2838-2850`).
  - `readText()` documentation says to call prompts serially (`acp.ts:1916-1919`).
  - So with reading §3a, an SDK-helper client that overlapped A and B treats `idle(A)` as the end of both. This is a limitation of the documented client, not a spec violation.
- **D4: internal conflict with earlier codex-acp research.** `.agents/research/v2-prompt-lifecycle-and-turn-state-machine.md` §7.4, option 1, proposes "resolving the v2 RPC as soon as the queue accepts" a submission. That **violates R2** (`prompt-lifecycle.mdx:139`; `schema.json:4098`; RFD `prompt.mdx:41`). §7.3 also cites `prompt-lifecycle.mdx:139` as permitting clients to send prompts while running. That line is about when the **agent** responds. The spec neither forbids nor describes a client prompting while running; it only says "After the Agent reports `idle`, the Client may send another `session/prompt`" (`:565`). The user decision in `state.md:186-193` already replaces §7.4, but §7.4 should not be used as the insertion design.
- **D5: TCK citation drift.** TCK texts cite spec `8f76d6c` line numbers (e.g. `prompt-lifecycle.mdx:348` for the idle MUST). At HEAD `c245270` the same text is at `:377`. The wording is unchanged.

## Open questions

- **Codex app-server insertion evidence** (route to a Codex-side researcher). Which event proves insertion for a codex-acp turn: the `turn/start` response, `turn/started`, or an `item/started` userMessage? Does Codex emit a user-message item for `/review`, `/compact` or `/goal` turns? Does `turn/start` on a thread with an active turn error or queue? Prior research §7.3 suggests codex-acp already avoids overlapping `turn/start`.
- **Failures after insertion.** What should the agent report if a queued prompt's `turn/start` fails after we have inserted it, or a local command such as `/logout` fails after insertion? The spec defers this: "post-insertion failure reporting, cancellation races … are separate" (RFD `prompt.mdx:279`). A candidate is an `agent_message` describing the error plus `idle(end_turn)`, or a `_`-prefixed custom `stopReason`.
- **`session/cancel` while idle with an empty queue.** Unspecified (ACP-INFO-CANCEL-201).
- **One queue or two?** Should queued v2 prompts and `_session/steering` requests share one FIFO per session? This is internal design, and steering stays separate per the user decision.
- **Queued prompts and other connections.** Queued prompts are live-only state. What `session/resume` or a second connection should see of them is unspecified.

## Event sequence to implement

Notation: `→` means wire order. `resp(X)` is the JSON-RPC result `{messageId: mX}` for prompt X. `um(X)` is `session/update user_message {messageId: mX, content}`. `resp(X)` and `um(X)` may be sent in either order; both follow insertion. MUST, SHOULD and our-choice markers refer to the Requirements table above.

### A. Prompt P while idle
1. Receive `session/prompt(P)`. Do not respond yet.
2. Start the Codex turn. Once insertion is confirmed, P is inserted (R1, R2).
3. `resp(P)` + `um(P)`. The IDs are equal (MUST R5) and distinct from every other submission (MUST R7).
4. `state_update running` (MUST R10).
5. Output. During permission waits, `requires_action`, then `running` again (SHOULD R13).
6. `state_update idle` with `stopReason` (MUST R11): `end_turn` or the mapped reason.
- If rejected before insertion, send a JSON-RPC error only: no `um`, no `state_update` (R3).

### B. Prompt B queued behind running turn A (A already answered and `running`)
1. Receive `session/prompt(B)`. Push it to the per-session FIFO queue (our choice, R21/R22). Send **nothing**: no response, no `um(B)`, no `state_update` (MUST NOT R2).
2. A keeps streaming, then A ends → `state_update idle` with `stopReason(A)`. This is recommended reading §3a. The MUST R11 `stopReason` rule applies whenever idle is sent.
3. Dequeue B. Start its Codex turn. On insertion → `resp(B)` + `um(B)` → `state_update running` (MUST R10).
4. B's output → `state_update idle` with `stopReason(B)`.
5. Repeat for the next queued prompt.
- If B's turn start fails before insertion, send a JSON-RPC error for B, and no `um` or `state_update` (the state is still `idle` from step 2). Continue with the next queued prompt.

### C. `session/cancel` with A running and B, C queued
1. Receive `session/cancel`. Take B and C out of the queue. Send JSON-RPC **error `-32800`** for each (our choice, R17, with code per R19). They get no `um` and no `state_update`.
2. Interrupt A (SHOULD R15). Flush A's remaining updates.
3. `state_update idle` with `stopReason:"cancelled"`, **exactly once** (MUST R16).
4. No further `state_update` until a new prompt arrives (TCK ACP-CANCEL-202 form).
- **`$/cancel_request` targeting queued B:** remove B, send `-32800` for B only (R18). A and C are unaffected.
- **`session/close`:** steps 1–3, then respond `{}` to the close (R20).
- **Cancel while B's turn start is in flight:** if B ends up inserted, send `resp(B)` + `um(B)` → `running` → interrupt → `idle(cancelled)`. If B can be aborted before insertion, send `-32800` for B and no `state_update`.

### D. Locally handled slash command S (no model turn: `/status`, `/mcp`, `/skills`, `/plan`, `/rename`, `/logout`, usage errors)
- **While idle:**
  1. Receive `session/prompt(S)`.
  2. The adapter inserts a live-only user message (R9).
  3. `resp(S)` + `um(S)` (MUST R5, R8).
  4. `state_update running` (our choice, recommended; required by ACP-STATE-201 if an idle with `stopReason` follows).
  5. Command output (`agent_message`, `config_option_update`, `session_info_update`, …).
  6. `state_update idle`, `stopReason:"end_turn"`.
- **While A is running:** queue S in the same FIFO. Send nothing until it is reached (MUST NOT R2). After `idle(A)`, run steps 2–6 above.
- **On replay** (only if S was retained): `um(S)` with the same `messageId`. Do not re-execute the command (MUST R8, R9).
- Commands that start Codex turns (`/compact`, `/review*`, `/goal`) follow A or B. If Codex emits no user-message item for them, the adapter inserts its own live-only user message when the turn starts.

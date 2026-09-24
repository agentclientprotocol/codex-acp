# What does Codex do with `turn/interrupt` in the `/review` window between the `review/start` response (P) and `turn/started` (C), and what should codex-acp do?

**Sources checked:**
- Codex `openai/codex` @ `rust-v0.156.1` (matches `@openai/codex` `^0.156.1` in `package.json:69`; installed `codex-cli 0.156.1`). I used the read-only cache in `/tmp/codex-research/src/` from the earlier research, plus files fetched with `gh api` at the same tag: `core/src/agent/status.rs`, `core/src/codex_delegate.rs`, `prompts/src/review_request.rs`, `git-utils/src/branch.rs`, `app-server/src/request_processors/thread_lifecycle.rs`. Paths are relative to `codex-rs/`.
- Live probes against real Codex 0.156.1 (`codex app-server` over stdio, workspace `/tmp/codex-research/ws`, not a git repo). The probe script was passed on stdin and written nowhere. Scenarios: `spamP`, `acpSchedule` (cold thread and warm thread), `waitC`, `lateP`, `emptyId`, `failbranch`.
- ACP spec `agent-client-protocol` @ `c16d6bf` (2026-09-23), used only to classify the cancel requirements.
- codex-acp working tree on `eugenethedev/acp-v2` @ `3a1a93a`.

**Confidence:** high for Codex behavior: the source and 7 live runs agree. Medium on how wide the windows get under load: I only measured on an idle local machine.

## Answer

The window between the `review/start` response and `turn/started(C)` has **two sub-windows**, and Codex treats P differently in each:

- **S0 (about 1–9 ms after the response).** The server has sent the response, but the Codex core has not yet processed `Op::Review`. Any real turn id is rejected with `-32600 "no active turn to interrupt"`, and that includes P.
- **S1 (the next ~60–70 ms, until `turn/started(C)` is tracked).** **P is accepted.** The review task is aborted before the child ever starts. The `turn/interrupt` response `{}` arrives, then exactly one `turn/completed{id: P, status: "interrupted"}`. No `turn/started(C)` is ever sent.
- **After `turn/started(C)` (S2).** P gets `-32600 "expected active turn id P but found C"` and C is accepted. This was already known.

Waiting for `turn/started(C)` and then interrupting with C works (observed). But it is **not safe as the only strategy**, because the child turn can legitimately never start:
1. **Observed:** `review/start` succeeds, but review-request resolution then fails (`/review-branch` with a non-git cwd). Codex sends one `error{turnId: P, willRetry: false}` and then **nothing else**: no `turn/started`, no `turn/completed`, ever.
2. **Observed:** an interrupt accepted in S1 aborts the review before the child starts.
3. **Source-only:** the reviewer sub-session fails to start. The review then completes under P and C never exists.

**Recommendation:** keep sending the best id known now: `interruptTurnId ?? P`, as 2(r) does. Make the retry robust:
- recompute the id on **every** attempt;
- also treat `-32600 "expected active turn id <P> but found <Y>"` as retryable when P is the session's current completion id, and retry with Y.

Do **not** defer the interrupt until `turn/started`. It delays the abort, lets the reviewer model request start, and needs a timeout whose fallback is P anyway.

Today's v1 cancel in this window works in practice (observed with codex-acp's exact retry schedule). It has a narrow, low-severity hole: a fixed-id retry that jumps over S1 lands on the non-retried "found C" error and silently drops the cancel. Two adjacent, more serious v1 issues came up and are listed under Open questions: the resolve-failure hang, and the `Close`-named interrupt paths never retrying.

## Requirements

| # | Requirement | Tier | Citation |
|---|-------------|------|----------|
| R1 | On `session/cancel`, the agent SHOULD stop all LLM requests and tool invocations as soon as possible | SHOULD | ACP `docs/protocol/v1/prompt-turn.mdx:352`; v2 `docs/protocol/v2/prompt-lifecycle.mdx:546` |
| R2 | After aborting, the agent MUST answer the original `session/prompt` with `cancelled` (v1), or send an idle `state_update` with `cancelled` (v2). A dropped `turn/interrupt` that lets the review finish would answer `end_turn` and violate this | MUST | v1 `prompt-turn.mdx:354`; v2 `prompt-lifecycle.mdx:548` |
| C1 | `turn/interrupt` validates `turnId` against the app-server's `active_turn_id()`. If one exists and differs, the error is `expected active turn id {sent} but found {active}`. If none exists and the thread is not `Running` (or the id is the last terminal one), the error is `no active turn to interrupt`. Both are `-32600` | Codex fact (source + observed) | `app-server/src/request_processors/turn_processor.rs:1605-1622`; probes `lateP`, `spamP` |
| C2 | `active_turn_id()` is the builder's current turn, falling back to the last finished turn. The builder is reset after each terminal event when no turn is open | Codex fact (source) | `app-server-protocol/src/protocol/thread_history.rs:304-309`; `app-server/src/thread_state.rs:197-218` |
| C3 | An `enteredReviewMode` item with `turnId: P` opens a builder turn with id P when none matches, so P becomes the active turn id | Codex fact (source + observed) | `thread_history.rs:626-665` (`handle_materialized_item_lifecycle`), `:1213-1229` (`upsert_review_mode_item`); probe `spamP` (P accepted right after `enteredReviewMode`) |
| C4 | Agent status becomes `Running` only on `TurnStarted`. For a review that is the forwarded child C, so in S0 the thread is not `Running` | Codex fact (source) | `core/src/agent/status.rs:6-8`; `core/src/session/mod.rs:2572-2576` |
| C5 | The `review/start` response is sent as soon as `Op::Review` is queued, before the core processes it | Codex fact (source + observed) | `turn_processor.rs:1425-1445` (`submit_core_op`, then `emit_review_started`), `:490-499`, `:1410-1422` |
| C6 | Core ops run one at a time. `Op::Review` runs `list_models` and `spawn_task`, then emits `enteredReviewMode`. A later `Op::Interrupt` is processed only after that | Codex fact (source) | `core/src/session/handlers.rs:419-431,588-591,374-407`; `core/src/session/review.rs:19-26,217-230` |
| C7 | `Op::Interrupt` does not look at turn ids: it aborts whatever task is active. The pending `turn/interrupt` is answered on `TurnAborted` or `TurnComplete` | Codex fact (source + observed) | `core/src/session/mod.rs:4855-4862`; `app-server/src/bespoke_event_handling.rs:186-188,1204-1207,1556-1570` |
| C8 | The app-server tracks each event in thread state **before** it emits the notification. A `-32600 "...found C"` response can therefore reach the client before the `turn/started(C)` notification | Codex fact (source); ordering race not observed | `app-server/src/request_processors/thread_lifecycle.rs:319-326` then `:344` |
| C9 | If review-request resolution fails after `review/start` succeeded, Codex emits `Error` under P and spawns no task. There is never a `TurnComplete(P)` and never a child turn | Codex fact (source + observed) | `handlers.rs:386-406`; `prompts/src/review_request.rs:42-63`; `git-utils/src/branch.rs:15-19`; probe `failbranch` |
| C10 | If the reviewer sub-session fails to start, the review finishes under P ("Review was interrupted") without a child `TurnStarted` | Codex fact (source only; not probed) | `core/src/tasks/review.rs:77-90,138-142`; `core/src/codex_delegate.rs:204-240` |

## Details

### Codex state timeline after `review/start` (0.156.1)

| Sub-window | Codex state | `turn/interrupt{P}` | `turn/interrupt{C}` | `turn/interrupt{""}` |
|---|---|---|---|---|
| **S0**: response sent → `enteredReviewMode(P)` tracked. Observed 3–9 ms | builder empty (`active_turn_id` None); status not `Running` (C2, C4, C5) | `-32600 no active turn to interrupt` (observed in 6/6 immediate sends) | C is unknown | `{}` right away; the queued `Op::Interrupt` aborts the review once it spawns (observed `emptyId`) |
| **S1**: `enteredReviewMode(P)` tracked → `turn/started(C)` tracked. Observed 64–69 ms | `active_turn_id = P` (C3); status still not `Running` | **accepted**: review aborted, child never starts, `{}` then `turn/completed(P, interrupted)` (observed `spamP`, `acpSchedule` ×2) | C is unknown | (not probed; same mechanism) |
| **S2**: after `turn/started(C)` | `active_turn_id = C`; `Running` | `-32600 expected active turn id P but found C` (observed `lateP`) | accepted; `turn/completed(P, interrupted)` (observed `waitC`, `lateP`) | — |
| **S-fail**: resolve error (C9) | no task; status `Errored`; no active turn | `-32600 no active turn to interrupt`, at +1 ms and at +6 s (observed) | never exists | `{}` with no effect |

### Observed traces (ms since process start)

- **`spamP`** (P every ~3 ms, starting at the response):
  - response 129; P rejected "no active turn" at 129 and 132;
  - `enteredReviewMode` 133; P sent at 135 accepted;
  - `exitedReviewMode` and agentMessage "Review was interrupted…" 137–139;
  - interrupt `{}` 141; `turn/completed(P, interrupted)` 141;
  - no `turn/started` ever; history has one turn, P, `interrupted`.
- **`acpSchedule`** (codex-acp's exact `Cancel` schedule, fixed id P):
  - cold: response 139; P at 140 rejected; `enteredReviewMode` 143; retry at 166 (+25 ms) accepted; `turn/completed(P, interrupted)` 179.
  - warm (after one normal turn): response 2428; P at 2428 rejected; `enteredReviewMode` 2437; retry at 2456 accepted; `turn/completed(P, interrupted)` 2482.
- **`waitC`**: response 127; `enteredReviewMode` 131; `turn/started(C)` 200; interrupt C at 200; `{}` and `turn/completed(P, interrupted)` 206.
- **`lateP`**: `turn/started(C)` 195. P at 195 is rejected with `"expected active turn id 01a0d0d8-32d2-… but found 01a0d0d8-3310-…"`. C at 196 is accepted, and `turn/completed(P, interrupted)` arrives at 202.
- **`failbranch`** (`target: {type: "baseBranch", branch: "main"}` in a non-git cwd):
  - response 130; P at 130 rejected "no active turn";
  - `thread/status/changed systemError` and `error{turnId: P, willRetry: false, "…is not a git repository"}` at 141;
  - after that **nothing for 20 s**; P at +6 s rejected "no active turn"; empty id `{}`.
  - A following `turn/start` completed as `failed` with the **stale** "not a git repository" error, although its history status reads `completed`.

### What codex-acp does today (after 2(r))

- **Cancel**: `session/cancel` → `interruptSessionTurn` → `requestTurnInterrupt({turnId: codexRunningTurnId(state, P)}, "Cancel")` (`src/CodexAcpServer.ts:2899-2931`). Before `turn/started` that sends P. `observePromptRequestCancellation` does the same (`:2790-2815`).
  - It retries only on `"no active turn to interrupt"` (`src/CodexThreadErrors.ts:53-55`), with delays `[25, 50, 100, 200, 400]` ms (`src/CodexAcpServer.ts:256`), and **the same `turnId` on every attempt** (`:2856-2889`: the id is computed once by the caller).
- **Close / late start**: `interruptLateStartedTurn` → `interruptPromptTurn(turn, "Close")` (`:2891-2893`, `:2834-2851`). It fires synchronously on the `review/start` response (`onTurnStarted`, `:3172-3178`), which always falls in S0. `Close` is never retried (`:2869-2872`).
- `runReview` waits only for `turn/completed(P)`, with no timeout or error exit (`src/CodexAppServerClient.ts:317-338,768-773`).

### Risk in the current Cancel path

The retry keeps P. For the cancel to be dropped, S0 has to outlast the early retries so that a later, wider gap (100/200/400 ms) jumps over all of S1 (~65 ms). The next attempt then lands in S2 and gets "found C", which is not retried. The cancel is dropped, the review runs to completion, and ACP gets `end_turn` (R2 violated).

S0 covers the time from queuing `Op::Review` through `list_models(OnlineIfUncached)` and `get_model_info` to `spawn_task` (`review.rs:19-31,220`). It also includes any time `Op::Review` waits behind an earlier op in the core's op queue (C6). On an idle machine S0 was ≤9 ms, so the gap was never hit. Under a cold model cache or a busy op loop this is plausible but unmeasured (hypothesis).

### Options evaluated

| Option | S0 | S1 | S2 | S-fail / child-fail | Verdict |
|---|---|---|---|---|---|
| **A. Keep P, as today** (fixed id, retry only on "no active turn") | retried | ✓ | ✗ drop ("found C" not retried) | retries run out → dropped; prompt hangs (S-fail) | Works in practice; narrow hole |
| **B. A + recompute `codexRunningTurnId` on each attempt + retry "expected active turn id P but found Y" with Y** | retried | ✓ | ✓ (retry with C) | S-fail: dropped after 5 retries (nothing to abort anyway); child-fail: P works | **Recommended** |
| **C. Defer until `turn/started`, with a timeout, then C** | waits | waits (the child starts its model request first) | ✓ | never fires → timeout → must fall back to P or give up | Rejected: slower (R1), more state, still needs the P fallback |
| **D. `turnId: ""` (startup interrupt)** | ✓ | ✓ (not probed; same mechanism) | ✓ (same mechanism) | no-op | Works, but uses an undocumented path meant for MCP startup (`turn_processor.rs:1598-1603`; not in the README). Its response is immediate and does not confirm an abort. Not recommended as the primary path |

### Implementation notes for option B

- Inside the retry loop, compute the id per attempt, for example with a `turnIdProvider` closure: `() => codexRunningTurnId(sessionState, completionTurnId)`. The pinned 2(r) behavior still holds: the first attempt before `turn/started` sends P.
- Add a predicate `expectedActiveTurnMismatch(err): {expected, found} | null`. Match `-32600` with message `expected active turn id <a> but found <b>` (`turn_processor.rs:1612-1614`). Retry once or twice with `found` only if **all** of these hold:
  - `expected` equals the session's current completion id;
  - the prompt is still active;
  - `found` is non-empty.
- Prefer `interruptTurnId` when it is already set. Because of C8 the `turn/started(C)` notification may still be in flight, so fall back to the parsed `found`. Retrying with `found` is safe here: codex-acp owns the thread, P has not completed, and Codex just reported `found` as the only active turn.
- v2 (2(a2)) can reuse this unchanged: `completionTurnId = P`, `interruptTurnId = latest turn/started`.

## Testability notes

- **Fake app-server, Vitest (event-driven):**
  1. `review/start` → P. `turn/interrupt{P}` fails once with `-32600 no active turn to interrupt`, then succeeds. Assert the second call also uses P and that `cancelled` is reported. This works today.
  2. `review/start` → P. The first `turn/interrupt{P}` gets "no active turn". Before the retry fires, emit `turn/started(C)`. Assert the retry uses **C** (option B; today it sends P).
  3. `turn/interrupt{P}` → `-32600 "expected active turn id P but found C"` **before** any `turn/started` notification (C8 race). Assert a follow-up `turn/interrupt{C}` and a `cancelled` stop reason. Today the cancel is dropped: the prompt ends `end_turn` or hangs until the fake sends `turn/completed`. Record that as a known bug rather than asserting it.
  4. Negative case: "found X" where the expected id is **not** the current completion id → no retry.
  - Snapshot the ordered `turn/interrupt` params with `toMatchFileSnapshot()`.
- **S-fail hang** (adjacent): fake `review/start` → P, then `error{turnId: P, willRetry: false}` and nothing else. Today the prompt never resolves, so a test needs a timeout-based assertion and would currently fail.
- **Not observable with fakes:** the real S0/S1/S2 boundaries and their widths, and whether S0 ever gets long. Use the stdin probe approach (`spamP`/`acpSchedule`) or `/run-codex`. The C8 notification/response reordering was not observed live and is source-only.

## Discrepancies

- **Codex vs itself:** the id reported in the review's items, errors and completion (P) is accepted by `turn/interrupt` only in S1. In S2 only C is accepted, and in S0 no id is. Nothing in the README documents this (the README grep has no `turn/interrupt` id semantics beyond "Interrupt … remain available", `README-0.156.1.md:181`).
- **Codex vs ACP:** for the S-fail path, Codex never terminates the turn it announced (no `turn/completed`). ACP requires the agent to eventually answer the prompt / go `idle` (v1 `prompt-turn.mdx:354`, v2 `prompt-lifecycle.mdx:377`), so codex-acp must synthesize the end itself.
- **Codex bug (observed):** after S-fail, the stale error leaks into the **next** `turn/completed` (`status: failed`, same message), while `thread/turns/list` reports that turn as `completed`. The likely cause is `turn_summary.last_error` never being cleared because no terminal event came for P (hypothesis; `bespoke_event_handling.rs:188-189`).
- ACP spec vs TypeScript SDK: not relevant to this question; not checked.

## Open questions

1. **v1 hang, `/review-branch` or `/review` whose resolution fails** (medium; reachable via `/review-branch <name>` in a non-git cwd, `src/CodexCommands.ts:286-295`). `runReview` waits forever for `turn/completed(P)`. `session/cancel` cannot help, because every interrupt is "no active turn". Suggested discriminator, to be decided by whoever owns 2(a2) or the v1 review path: an `error{turnId: P, willRetry: false}` that arrives **before** any `enteredReviewMode` item for P means Codex never spawned the task. In every spawned path, `enteredReviewMode(P)` comes before any error (`review.rs:220-230`; `handlers.rs:386-406`). The stale-error leak into the next turn also needs handling.
2. **`Close`-named interrupts are never retried** (`interruptLateStartedTurn`, and `interruptSessionTurn(…, "Close")` on session close). `interruptLateStartedTurn` fires on the start response, which is always in S0 for a review, so it is rejected and the review keeps running in Codex after the ACP prompt returned `cancelled`. The same S0 exists for plain `turn/start` (warm probe: response 133, `turn/started` 137), so this is a general race, not review-specific, and the id is not the cause. It needs its own decision (retry "no active turn" for Close too?) and belongs to topic 3 (cancellation).
3. Can S0 grow large in practice (cold `list_models` refresh, a busy core op loop)? Measuring that needs a probe with a cold model cache; that decides how urgent the option-B fix is.
4. How the interrupted review's history (`C` stored as a separate empty `interrupted` turn before P, observed in `waitC`/`lateP`) should replay under topic 5b.

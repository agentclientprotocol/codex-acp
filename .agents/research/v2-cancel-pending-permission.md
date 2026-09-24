# On `session/cancel`, whose job is it to cancel a pending `session/request_permission`, and what does codex-acp do today?

**Sources checked:**
- ACP spec: `agent-client-protocol` @ `03f9574dee8994df3c13049a66326154e7b33736` (2026-09-24, pulled fresh)
- ACP TypeScript SDK: `acp-typescript-sdk` @ `69fda3703bfb3a33d2f0e9fa6b90081270297d4c` (2026-09-23, pulled, already up to date)
- ACP TCK: `acp-tck` @ `64b62b67d473cddcc527f89253695019e7a82add` (local checkout, not pulled)
- Codex: `openai/codex` tag `rust-v0.156.1` (commit `b412ff32c417f855c2b2d1581b77058eed87c84b`). Sparse, read-only clone in `/tmp/codex-src`: `codex-rs/app-server`, `app-server-protocol`, `core/src`
- codex-acp: branch `eugenethedev/acp-v2` @ `07ef0da`

**Confidence:** high for 1 and 2: the spec text is explicit, and Codex has a dedicated upstream test. Medium-high for 3: it is derived from the code; I did not run a live probe (see Testability notes). Medium for the side effects of option (a), because the full `requestCancel()` path touches several prompt-flow branches.

## Answer

- **Spec, v1 and v2 alike.** The only normative rule is on the **client**: it "**MUST** respond to all pending `session/request_permission` requests with the `cancelled` outcome" after it sends `session/cancel`. Agent-side `$/cancel_request` cascading is allowed but never required:
  - it is a MAY, plus a non-normative sequence diagram in `cancellation.mdx`;
  - the TCK records it as INFORMATIONAL (`ACP-INFO-CANCEL-202`);
  - the reference SDK's example agents don't do it.
- **Codex.** When Codex 0.156.1 gets `turn/interrupt` while an approval is outstanding, it resolves the approval internally:
  - it drops its callback with a `turnTransition` error;
  - it emits `serverRequest/resolved` for that request id;
  - it then emits `turn/completed{status:"interrupted"}`;
  - it never sends codex-acp anything that cancels the JSON-RPC request itself.

  codex-acp ignores `serverRequest/resolved` for approvals, so the ACP permission request stays open until the ACP client answers. When the answer eventually comes, Codex discards it ("could not find callback").
- **What clients see today.** The turn still ends correctly and nothing hangs: v1 gets `stopReason:"cancelled"`, v2 gets one `idle/cancelled`. A spec-conforming client has already answered `cancelled` itself. A non-conforming client leaves a stale dialog open, and clicking it later has no effect on Codex.
- **One real bug.** If `session/cancel` arrives while the **plan-implementation review** permission is pending (after the plan turn has completed), the prompt ends with **`end_turn`**, not `cancelled`. This breaks v1 `prompt-turn.mdx:354` and v2 `prompt-lifecycle.mdx:548`/TCK `ACP-CANCEL-203`.
- **Recommendation:** a narrow version of (a), on both v1 and v2. Make `cancel()` abort a per-prompt signal used only for interactions, which sends the `$/cancel_request` cascade. Also mark the prompt as cancel-requested so the plan-review branch returns `cancelled`. Don't route plain `session/cancel` through the full `activePrompt.requestCancel()`, which also changes the pre-turn-start flow.

## Requirements

| # | Requirement | Tier | Citation |
|---|---|---|---|
| R1 | After sending `session/cancel`, the Client responds to every pending `session/request_permission` with outcome `cancelled` (v1) | MUST (client) | spec `docs/protocol/v1/prompt-turn.mdx:350`; `docs/protocol/v1/tool-calls.mdx:193` |
| R2 | Same rule for v2 ("current active work gets cancelled") | MUST (client) | spec `docs/protocol/v2/prompt-lifecycle.mdx:544`; `docs/protocol/v2/tool-calls.mdx:304`; restated in `docs/protocol/v2/migration.mdx:317` |
| R3 | On `session/cancel` the Agent should stop LLM requests and tool invocations ASAP | SHOULD (agent) | v1 `prompt-turn.mdx:352`; v2 `prompt-lifecycle.mdx:546` |
| R4 | Agent ends the turn with `cancelled`: v1 as the `session/prompt` result, v2 as an idle `state_update` | MUST (agent) | v1 `prompt-turn.mdx:354`; v2 `prompt-lifecycle.mdx:548` |
| R5 | Agent must not surface cancellation as another stop reason or a failure | MUST (agent) | v1 `prompt-turn.mdx:361`; v2 `prompt-lifecycle.mdx:555`; TCK `ACP-CANCEL-203` (`src/tck/v2/requirements.py:420-432`) |
| R6 | `$/cancel_request` is optional. A receiver MAY cancel the activity and nested activities, and MUST still send a response (a result or `-32800`) | MAY + MUST respond (receiver) | v1 `cancellation.mdx:14-22`; v2 `cancellation.mdx:14-22`; method is stable in `schema/v1/meta.json:32` and `schema/v2/meta.json` |
| R7 | Agent sending `$/cancel_request` for its own pending permission requests after `session/cancel` | Illustrative only (non-normative diagram) | v1 `cancellation.mdx:40-68` (steps 4-5, lines 58-64); v2 `cancellation.mdx:40-69` (lines 59-65) |
| R8 | "Internal cancellation" by the executing party SHOULD produce a `-32800` like `$/cancel_request` would | SHOULD (executing party = client for permission requests) | v1/v2 `cancellation.mdx:28-38` |
| R9 | v2: while blocked on a permission response, report `requires_action`, then `running` when work resumes | SHOULD | v2 `prompt-lifecycle.mdx:400`; TCK `ACP-PATCH-209` (ADVISORY, `requirements.py:1241-1252`) |
| R10 | TCK: whether the agent sends `$/cancel_request` for pending permission/elicitation on cancel is "not required, only illustrated (MAY at best)" | INFORMATIONAL (record-only) | TCK `src/tck/v2/requirements.py:515-527`; test `src/tck/v2/conformance/test_cancel.py:448-478` (the TCK client itself answers `cancelled`, per `:453-458`) |

RFD context (a proposal, not a requirement): `docs/rfds/request-cancellation.mdx:192-201` says implementations "should … propagate cancellation to any nested/child requests". At `:5-6` and `:205` it is marked Completed and stabilized. The stabilized docs soften this to a MAY (`cancellation.mdx:18`).

## Details

### 1. Spec, reference SDK, TCK

- **Both mechanisms are in the docs, and only one is normative.** `prompt-turn.mdx` and `prompt-lifecycle.mdx` put the obligation on the client (R1/R2). `cancellation.mdx`, in both v1 and v2, shows an agent cascading `$/cancel_request` to pending `session/request_permission` requests, as an example. Its normative text is only MAY (`:18`).
- **Both are allowed and they don't conflict.** If the client already answered `cancelled`, the agent's `$/cancel_request` has nothing left to cancel. The SDK won't even send it (see below).
- **v1 → v2 is unchanged:** `migration.mdx:55` says "`$/cancel_request` | Unchanged", and `:317` says "Clients still respond to all pending `session/request_permission` requests with the `cancelled` outcome".
- **Reference SDK example agents do not cascade:**
  - `src/examples/agent.ts:181-209` calls `cx.request(session.requestPermission, …)` with **no** `cancellationSignal`, even though `cancel()` (`:276-277`) aborts `pendingPrompt`. It only handles the client-supplied `cancelled` outcome (`:211-213`), which relies on R1.
  - `src/examples/dual-version-agent.ts` never requests permission. Its v2 cancel (`:150-151`, `:182-189`) aborts the turn's controller and emits `idle/cancelled` (`:256-266`).
- **SDK machinery:**
  - `src/jsonrpc.ts:97-105`: aborting `SendRequestOptions.cancellationSignal` sends `$/cancel_request`, and "the returned promise is still settled by the peer's eventual response". Cancellation is cooperative: it does **not** reject locally.
  - `:1128-1144`: `cancel()` is idempotent, and the abort listener is removed once the response settles, so no `$/cancel_request` goes out for a request that is already answered.
  - Receiving side, `:1508-1524`: an inbound `$/cancel_request` aborts the handler's `signal` with `RequestError.requestCancelled`. The client handler has to cooperate; `$/cancel_request` for an unknown or finished id is ignored.

### 2. Codex 0.156.1 on `turn/interrupt` with an outstanding approval

Paths below are in `openai/codex @ rust-v0.156.1`.

1. **Core aborts the turn.** `EventMsg::TurnAborted` → `outgoing.abort_pending_server_requests()` runs first. Then `respond_to_pending_interrupts`, then `handle_turn_interrupted`, which emits `turn/completed` with `interrupted` (`codex-rs/app-server/src/bespoke_event_handling.rs:1203-1215`). `TurnComplete` (`:184-187`) and `TurnStarted` (`:154-157`) do the same.
2. **Pending callbacks are dropped.** `abort_pending_server_requests` (`codex-rs/app-server/src/outgoing_message.rs:215-229`) calls `cancel_requests_for_thread` with an internal error whose `data.reason = "turnTransition"`. `cancel_requests_for_thread` (`:598-630`) **removes** every pending callback for the thread and sends that error to each waiter.
   - Nothing goes out on the wire to cancel the JSON-RPC request Codex sent to codex-acp. There is no `$/cancelRequest` equivalent.
3. **The approval task emits `serverRequest/resolved`.** In `on_command_execution_request_approval_response` (`bespoke_event_handling.rs:1958-2024`), `receiver.await` returns the error. The task then calls `resolve_server_request_on_thread_listener` (`:1972`), which emits `serverRequest/resolved {threadId, requestId}` (`thread_state.rs:227-258` → `request_processors/thread_lifecycle.rs:545-555, 864-886`).
   - The `turnTransition` error then hits `Ok(Err(err)) if is_turn_transition_server_request_error(&err) => return` (`:2024`), so **no decision is submitted to core**.
   - File-change, permissions, elicitation and user-input approvals follow the same pattern (`:1636/1640`, `:1723`, `:1799/1855`, `:1925/1935`).
4. **Upstream test.** `turn_interrupt_resolves_pending_command_approval_request` (`codex-rs/app-server/tests/suite/v2/turn_interrupt.rs:221-330`) asserts that after `turn/interrupt` the client receives `serverRequest/resolved` with the approval's `request_id` (`:311-318`) and then `turn/completed` with `status: Interrupted` (`:320-327`).
   - Relative wire order of the two is not something I'd rely on: `serverRequest/resolved` goes through the thread-listener command channel from a spawned task (hypothesis based on the code structure).
5. **Late answers are ignored.** A later client response to the removed request logs `warn!("could not find callback for {id:?}")` and is dropped (`outgoing_message.rs:467-495`). A stale "allow" therefore cannot approve anything.
6. The app-server README does not document `serverRequest/resolved` (grep finds no hits in `codex-rs/app-server/README.md`).

**codex-acp's reaction** (paths in this repo):
- `serverRequest/resolved` is only used to:
  - clear MCP-approval correlation state (`src/permissions/lifecycle.ts:43-45`);
  - complete URL elicitations (`src/CodexElicitationHandler.ts:171-177`);
  - otherwise it is an explicit no-op in `src/CodexEventHandler.ts:677`.
- Nothing cancels the ACP `session/request_permission` that `CodexApprovalHandler` sent.
- The vscode-jsonrpc `onRequest` handler keeps awaiting the ACP client's response (`src/CodexAppServerClient.ts:220-251` → `src/permissions/CodexApprovalHandler.ts:105-111`).
- `CodexApprovalHandler.requestPermission` passes `activePrompt.signal` (`src/CodexAcpServer.ts:3520-3530`), but that signal is aborted only by `activePrompt.requestCancel()` (`:2985-2991`), which is called from:
  - `requestClose()` (`:2992-2999`, via `closeSession` at `:1254-1257`);
  - `observePromptRequestCancellation` (`:3025-3040`, v1 `$/cancel_request` on `session/prompt`).
- `cancel()` (`:4125-4137`) calls only `cancelQueuedV2Prompts` + `interruptSessionTurn(…, "Cancel", false)` (`:3201-3231`), which sends only `turn/interrupt`.
- So the programmer's finding is correct, and `.agents/research/v2-cancellation-semantics.md` §4 (line 229, "already implemented") is wrong for plain `session/cancel`. It is only true for close and for v1 `$/cancel_request` on the prompt.

### 3. What a client sees today on cancel during `requires_action` (code-derived)

Setup: a Codex command/file/permissions approval is pending, and the client sends `session/cancel`.

1. `cancel()` sends `turn/interrupt`.
2. Codex emits `serverRequest/resolved` and `turn/completed{interrupted}`. `sendPrompt` resolves, and `prompt()` returns `cancelledPromptResponse()` (`src/CodexAcpServer.ts:3730-3754`).
3. Result:
   - **v1:** `session/prompt` → `{stopReason:"cancelled"}`.
   - **v2:** `promptV2` emits exactly one `idle/cancelled`.
   - **No hang:** nothing in `prompt()` or its `finally` (`:3945-3995`) awaits the approval handler, and vscode-jsonrpc request handlers don't block notification dispatch.
4. The ACP permission request stays pending until the client answers:
   - **Conforming client** (R1/R2): it has already answered `cancelled` → `{decision:"cancel"}` → Codex drops it.
   - **Non-conforming client:** the dialog stays open, and one handler promise per stale request is retained until it answers. A later answer is dropped by Codex.
   - **v2 only:** `AcpV2Connection.requestPermission`'s `finally` (`src/ACPSessionConnection.ts:71-86`) sends `running` only if `isSessionBusy` (`src/CodexAcpServer.ts:1025-1027`, wired at `:464`).
     - If the client answers **before** the idle, the sequence is `requires_action → running → idle/cancelled` (conforming).
     - If it answers **after** the idle while a *new* prompt is busy, a stale `running` is sent into that new turn. Edge case, hypothesis: harmless unless the new turn is itself in `requires_action`.
   - If the client answers `cancelled` before `turn/interrupt` lands, Codex receives `decision:"cancel"` → `ReviewDecision::Abort` (`bespoke_event_handling.rs:2011-2014`). The turn aborts either way, and the result is still `cancelled`.

**Bug: plan-implementation review window.** After a plan-mode turn *completes*, `prompt()` awaits `requestPlanImplementationPermission(…, activePrompt.signal)` (`src/CodexAcpServer.ts:3780-3793`, `:3998-4026`).
- `sessionState.currentTurnId` still points at the completed turn (it is cleared only at `:3807`/`:3987`).
- So `cancel()` sends `turn/interrupt` for a finished turn. Codex rejects it (cf. `turn_interrupt_rejects_completed_turn`, `turn_interrupt.rs:153`), and `requestTurnInterrupt` retries and then gives up (`:3143-3190`).
- The signal is never aborted, so `promptShouldStop()` (`:3197-3198`) stays false.
- The conforming client answers `cancelled` → `planImplementationApproved` is false (`src/permissions/plan-review.ts:32-34`) → the prompt falls through to **`stopReason:"end_turn"`** (`:3918`). On v2 that becomes `running` → `idle/end_turn`.
- This violates R4/R5 on both versions. Existing tests only cover the "cancelled outcome without `session/cancel`" case, which correctly returns `end_turn` (`src/__tests__/CodexACPAgent/plan-review-events.test.ts:236-244`).

### 4. Options

**(a) `cancel()` calls `activePrompt.requestCancel()`, on v1 and v2.**
- Pros:
  - Cascades `$/cancel_request` to all pending Codex approvals, MCP elicitations and the plan-review permission.
  - Fixes the plan-review `end_turn` bug, because `promptShouldStop` becomes true (`:3791-3792`).
- The same abort also changes the prompt flow:
  - `cancelBeforeTurnStarted` (`:3016-3023`) resolves → `prompt()` returns `cancelled` **immediately** in the pre-turn window (`:3629-3638`, `:3735-3742`), not after `cancel()`'s awaited interrupt.
  - Local commands that never start a turn would return `cancelled` rather than finish `end_turn` while the command keeps running.
  - `waitForNativeSubagents` returns early (`:3747-3748`).
  - The user-input elicitation auto-resolves at once (`CodexElicitationHandler.ts:294-303`).
  - A late-started turn goes through `interruptLateStartedTurn` (`:3193-3195`).
- Hypothesis, not verified: on v2 the immediate return could let a late-started turn's `turn/started` report an unowned `running` after `idle/cancelled` (`trackCodexTurnStart`, `:1033-1039`), which would break `ACP-CANCEL-202`. It is probably masked by `markTurnStale`.
- These paths already run for v1 `$/cancel_request` and `session/close`, so they are exercised code. But they would reshape `session/cancel` timing relative to the 3(a) S0/S1/S2 fix (`78a8666`).
- v1-visible impact:
  - an extra `$/cancel_request` per pending interaction;
  - earlier `cancelled` responses in pre-turn windows;
  - `cancelled` instead of `end_turn` for cancelled local commands and for the plan review.

**(a′) Narrow variant (recommended).** Give `ActivePrompt` a second `AbortController`, used only for interactions:
- `cancel()`, `requestCancel()` and `requestClose()` abort it.
- Pass it to `CodexApprovalHandler`, `CodexElicitationHandler` and `requestPlanImplementationPermission` in place of `activePrompt.signal`.
- Add a `cancelRequested` flag, set by `cancel()`, that the plan-review branch (`:3791`/`:3794`) checks so it returns `cancelledPromptResponse()`.
- Leave `promptShouldStop`/`cancelBeforeTurnStarted` untouched, so the pre-turn race handling stays as it is.
- Fire the abort synchronously in `cancel()` before awaiting `interruptSessionTurn`, because that call can wait on `pendingTurnStart` (`:3250-3256`).
- v1-visible impact:
  1. One `$/cancel_request` per still-pending permission/elicitation after `session/cancel`. It is not sent for requests the client already answered (SDK `jsonrpc.ts:1128-1144`). v1 clients that don't implement it ignore it (R6: optional). SDK-based clients get their handler `signal` aborted, and a cooperating one closes the dialog with `-32800`, which `CodexApprovalHandler` maps to `cancel` (`:61-64`, `:76-80`, `:99-102`).
  2. The plan-review cancel returns `cancelled`, not `end_turn`. This is a bug fix per R4/R5.

  Nothing else changes.

**(b) v2 only.** Same mechanism, gated on `protocolVersion === 2`.
- Keeps v1 byte-identical, but leaves the plan-review `end_turn` bug on v1, which is a real R4 violation.
- `$/cancel_request` is unchanged between v1 and v2 (`migration.mdx:55`), so there is no protocol reason to branch. I don't recommend it.

**(c) Leave as is (client's job).**
- Spec-conformant: R1/R2 put the MUST on the client, and the TCK only records the behavior.
- Downsides:
  - Doesn't fix the plan-review bug.
  - Non-conforming clients keep stale dialogs open.
  - codex-acp keeps holding stale handler promises.
- `session/close` already cascades (`:1256`), so `session/cancel` and `session/close` stay inconsistent.

**Recommendation: (a′) on v1 and v2.** It aligns with the stabilized RFD intent and the `cancellation.mdx` diagram, stays within the MAY, and fixes a real v1/v2 MUST violation (plan review). Its only other v1-visible effect is an optional notification that conforming clients handle or ignore. If the orchestrator prefers the smallest diff, the minimum acceptable change is:
- the `cancelRequested` flag, to fix the plan-review bug;
- plus aborting the existing `activePrompt.signal` **only** for interactions, via the separate controller.

Avoid full (a) unless someone re-verifies the pre-turn and unowned-turn paths.

## Testability notes

- **Cascade on cancel (unit, mock connection).**
  - The ACP mock in `src/__tests__/acp-test-utils.ts:301-320` records `request` args, including the options arg.
  - Set `permissionState.response` to a never-resolving deferred. Start a prompt, fire `item/commandExecution/requestApproval` via `fixture.sendServerRequest`, wait for `requestPermission`, then call `cancel()`.
  - Assert the recorded `args[2].cancellationSignal.aborted === true`. Today it is `false`; with the fix, `true`.
- **Wire-level `$/cancel_request`.** This needs a real SDK connection pair, like the v2 harness (`src/__tests__/CodexACPAgent/v2-prompt-harness.ts`) or the e2e fixtures.
  - Assert that exactly one `$/cancel_request {requestId}` appears for each pending permission after `session/cancel`, and none for a permission the client already answered.
- **Turn end.**
  - v1: `session/prompt` resolves `{stopReason:"cancelled"}` once the fixture sends `turn/completed{status:"interrupted"}`.
  - v2: exactly one `idle/cancelled`, with no `state_update` after it. Mirrors TCK `ACP-CANCEL-201/202`.
- **Plan-review bug (regression test).**
  - Reuse `startPlanPrompt(null, {permissionResponse: deferred})` in `plan-review-events.test.ts`, wait for `requestPermission`, call `cancel()`, then resolve the permission with `{outcome:"cancelled"}` (or `-32800`).
  - Expect `stopReason:"cancelled"`, and `turnStart` called once. Today this returns `end_turn`.
- **Codex side.** The late-answer drop and `serverRequest/resolved` are Codex-internal. They can only be seen with real Codex (the `/run-codex` skill with an approval-requiring command, `approval_policy: on-request`) or by trusting the upstream test. I did **not** run a live probe: the `run-codex` script drives a prompt, but it has no pending-approval + cancel scenario, so a probe isn't cheap.
- **Can't be tested with a client-only harness:** whether a client "closes the dialog", and "stops ASAP" (R3, TCK `ACP-CANCEL-204` always SKIPs).

## Discrepancies

- **Spec docs vs. diagram/RFD.** `prompt-turn.mdx:350` / `prompt-lifecycle.mdx:544` make the client responsible. `cancellation.mdx:40-69` and RFD `request-cancellation.mdx:192-201` show or advocate an agent-side cascade. Not a contradiction: both can hold at once. But the normative weight is only on the client.
- **Spec diagram vs. reference SDK example.** The diagram shows the agent cascading. `src/examples/agent.ts:181-209` does not pass a `cancellationSignal` to its permission request.
- **ACP vs. Codex.** Codex resolves its own approval on interrupt (`serverRequest/resolved`) but sends no JSON-RPC cancel to codex-acp. codex-acp has to bridge that itself: either cascade on `session/cancel`, or react to `serverRequest/resolved`.
- **Prior research.** `.agents/research/v2-cancellation-semantics.md` §2 (line 79) and §4 (line 229) say the cascade is "already implemented". That is false for `session/cancel`; it holds only for `session/close` and v1 `$/cancel_request` on `session/prompt`.

## Open questions

1. **React to `serverRequest/resolved` instead?** codex-acp could cancel the matching ACP permission when Codex sends `serverRequest/resolved`, correlated by the Codex request id that the vscode-jsonrpc handler received. That also covers turns Codex aborts by itself (e.g. `TurnComplete`/`TurnStarted` aborts, `bespoke_event_handling.rs:154-187`). It would need handler-level correlation that `CodexAppServerClient` doesn't expose today. This is a separate design question.
2. **Stale `running` on v2.** A permission answered after `idle` while a later prompt is busy re-sends `running` (`ACPSessionConnection.ts:82-84`). Should the trailing `running` be scoped to the turn or prompt that issued the request?
3. **Elicitation cascade scope.** Should `elicitation/create` URL-mode requests follow the same rule? Auth-flow elicitations use a different requester (`CodexAcpClient.ts:219-259`).
4. **Wire order.** Is the order of `serverRequest/resolved` vs. `turn/completed` guaranteed in Codex? Only matters if option (1) above is pursued.

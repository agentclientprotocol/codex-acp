# Q-IDLE-RA: session-scoped permission/elicitation while no turn is running (ACP v2)

**Sources checked:**
- codex-acp @ `61928b2` (branch `eugenethedev/acp-v2`, clean)
- Codex source @ `rust-v0.156.1` (`b412ff3`), a sparse blobless clone at `/tmp/codex-src`. `codex-rs/codex-mcp/src/elicitation.rs` was read with `git show HEAD:…` into `/tmp/codex-mcp-elicitation.rs`. The worktree was not modified.
- agent-client-protocol @ `d880573` (`git pull --ff-only`: already up to date)
- acp-typescript-sdk @ `69fda37` (1.5.0, same as the installed `@agentclientprotocol/sdk`; pull: already up to date)
- acp-tck @ `64b62b6` (`src/tck/v2/requirements.py`)

**Confidence:** high for the codex-acp paths and the spec text. Medium for how often the Codex MCP
out-of-turn elicitation happens: it depends on the MCP server, and the code shows it is possible
but does not show it is common.

## Answer

**1. Yes, it can happen.** Two paths are real on v2:
- **(i) codex-acp's own MCP OAuth re-auth.** After `session/new`/`session/resume` with
  `mcpServers`, `authenticateMcpServer` runs in the background. No turn is involved. It is a
  **deterministic** repro whenever a requested server fails startup with
  `reauthenticationRequired` and the client advertises URL elicitation.
- **(ii) A Codex `mcpServer/elicitation/request` with `turnId: null` while idle.** This can only
  reach the client after at least one prompt has run on the session, because the prompt's
  `CodexElicitationHandler` stays registered for good.

Not affected:
- plan-implementation permission (covered by `v2PromptsInFlight`)
- command/file/permissions approvals and `requestUserInput` (their `turnId` is non-null)
- anything answered by the baseline `DENY_ALL_*` handlers (they send nothing)
- device-code / auth URL elicitation (request-scoped, so no state updates)

**2. The spec does not define `requires_action` outside foreground work.** Its own definitions
rule it out:
- `requires_action` means "foreground work is blocked on user action".
- The agent MUST report `idle` when it is ready for a new prompt.

So leaving the client at `requires_action` after the request settles (today's behavior) breaks
that idle MUST. No TCK row covers this case. The SDK client ignores `requires_action` and treats
**any** `idle` as the end of a pending prompt.

**3. Recommendation: option (a).** Only send `requires_action` (and the trailing `running`) when
the session is busy at the moment the request is sent. No v1 impact.

## Requirements

| # | Requirement | Tier | Citation |
|---|---|---|---|
| R1 | While foreground work is blocked on a permission response or other user action, report `requires_action`; report `running` when work resumes | SHOULD | agent-client-protocol `docs/protocol/v2/prompt-lifecycle.mdx:400`; `docs/protocol/v2/migration.mdx:309,530` |
| R2 | `requires_action` = "Foreground work is blocked on user action" (definition, not a rule) | definition | `prompt-lifecycle.mdx:522-524`; `schema/v2/schema.json:4928-4929`; RFD `docs/rfds/v2/prompt.mdx:235` ("the agent is trying to run, but needs to wait on user input", i.e. a proposal-level intent) |
| R3 | When the agent is ready to process a new prompt it MUST report `idle`; when that transition ends foreground work it MUST include a `stopReason` | MUST | `prompt-lifecycle.mdx:377`; `migration.mdx:282,308` |
| R4 | `stopReason` on idle is optional in the schema: "Agents SHOULD include this when the idle transition ends foreground work" | SHOULD (schema) | `schema/v2/schema.json:4909` (conflicts with R3, see Discrepancies) |
| R5 | Agents MAY stop foreground work at any time with an idle `state_update` plus a stop reason | MAY | `prompt-lifecycle.mdx:394` |
| R6 | Background activity MAY emit other `session/update`s while `idle`, and they do not change the state | MAY | `prompt-lifecycle.mdx:39,526`; `schema.json` `StateUpdate` description; `tool-calls.mdx:10` |
| R7 | Elicitation scope: `sessionId` (session-scoped, optional `toolCallId`) or `requestId` (outside a session). No state/turn coupling is stated | capability:`elicitation` | `docs/protocol/v2/elicitation.mdx:63-67` (the doc never mentions `state_update`) |
| R8 | TCK STATE-201/202/203 are scoped to prompted turns. STATE-201 fails a stop-reason-bearing idle that has no prior `running` in the prompt window. An unscoped "every idle has a stopReason" check is explicitly forbidden | capability:`capabilities.session` | acp-tck `src/tck/v2/requirements.py:211-257` |
| R9 | PATCH-209: `requires_action` while blocked on `session/request_permission`, then `running` | ADVISORY (TCK) | `requirements.py:1241-1253` |

## Details

### 1. Can a session-scoped request go out with no turn running? Path by path

All v2 sends go through `AcpV2Connection`, via `extensionOnlyV1View()`
(`src/ACPSessionConnection.ts:150-160`):
- `requestPermission()` always sends `requires_action` (`:76`). It sends `running` in `finally`
  only if `isTurnRunning(sessionId)` (`:84-87`).
- `createElicitation()` does the same when a `sessionId` is present (`:111`, `:119-122`).
- On v2, `isTurnRunning` is `isSessionBusy` = `isCodexTurnRunning || v2PromptsInFlight.has`
  (`src/CodexAcpServer.ts:474`, `:1035-1037`).

| Path | Session-scoped? | Can it run with no turn? | Result today |
|---|---|---|---|
| **MCP OAuth re-auth** (`authenticateMcpServer`, `CodexAcpServer.ts:2943-2970`). **Not** in `CodexElicitationHandler` | yes: URL `elicitation/create` with `sessionId` (`:2949-2958`) | **Yes, always.** Started by `tryCreateSession` for new/resume (not fork) when `mcpServers` were requested (`:914-921`). Runs fire-and-forget (`publishMcpStartupStatusAsync`, `:2865-2867`). Waits for Codex MCP startup (`:2876-2881`). For each failure with `failureReason === "reauthenticationRequired"`, and only if the client supports URL elicitation, it calls `authenticateMcpServer` (`:2911-2922`). Codex emits `mcpServer/startupStatus/updated` from `EventMsg::McpStartupUpdate` (`/tmp/codex-src/codex-rs/app-server/src/bespoke_event_handling.rs:202-228`). The reason is derived from MCP auth state at startup (`codex-mcp/src/connection_manager/startup.rs:54-64`). codex-acp only watches startup at session creation, not from later `mcpServer/*` notifications. `session/load` (`:2401-2407`) is v1-only: v2 has no `session/load` (`src/AcpAgentRouter.ts:140`) | `requires_action` is sent. When the elicitation settles, `isSessionBusy` is false, so **nothing follows**. The client stays in `requires_action` until the next prompt's `running`/`idle` |
| **Codex MCP elicitation** (`mcpServer/elicitation/request`, into `CodexElicitationHandler.handleElicitation`, `src/CodexElicitationHandler.ts:181-247`). Sends `elicitation/create` (`:187`), or the `session/request_permission` fallback for URL-without-support / message-only forms (`:209`) | yes (`sessionId: params.threadId`) | **Yes, but only after a prompt has run.** Codex's generic MCP elicitation router sends `ElicitationRequestEvent { turn_id: None }` (`codex-mcp/src/elicitation.rs:205-216`), with no active-turn gate (`:269-540`; gated only by auto-deny, policy, reviewer). The app-server falls back to the active turn id if there is one, else `null` (`bespoke_event_handling.rs:880-886`). The generated type documents `turnId` as nullable (`src/app-server/v2/McpServerElicitationRequestParams.ts`). Before any prompt, the baseline tracker's `DENY_ALL_ELICITATIONS` cancels it with no ACP send (`CodexAcpServer.ts:318-321`, `:1003-1015`). After the first prompt, `prompt()`'s subscription **permanently** replaces `session.current` (`CodexAcpServer.ts:3602-3642`; `src/subagents/CodexSubagentSubscriptions.ts:31-36`, `:116-124`), so a later idle-time elicitation reaches the last prompt's real handler | Same as the OAuth row: `requires_action`, then nothing. (In-turn MCP elicitations use `request_mcp_server_elicitation` with `turn_id: Some(sub_id)`, `core/src/session/mcp.rs:551-603`. Those are fine.) |
| **`item/tool/requestUserInput`** (`handleUserInput`, `CodexElicitationHandler.ts:250-318`) | yes | No: `turnId: string` is non-null (`src/app-server/v2/ToolRequestUserInputParams.ts`) | Bracketed correctly |
| **Command / file / permissions approvals** (`CodexApprovalHandler`) | yes | No: `turnId: string` on all three params types (`src/app-server/v2/{CommandExecution,FileChange,Permissions}RequestApprovalParams.ts`). Codex-started (unowned) turns set `codexReportedRunningTurnId` via `trackCodexTurnStart` (`CodexAcpServer.ts:1042-1048`). Ordering is safe: every handler first awaits `waitForRootNotifications()` (`CodexSubagentSubscriptions.ts:90,98,106,118,127`), so any queued `turn/started` has been processed before the request is sent | Bracketed correctly. A turn that completes while the request is pending gives `requires_action → idle(stopReason)`, with no trailing `running` (4(a), intended) |
| **Plan-implementation permission** (`requestPlanImplementationPermission`, `CodexAcpServer.ts:4062-4070`, called at `:3845-3850`) | yes | It runs between Codex turns, but inside the v2 prompt: `v2PromptsInFlight` is added at `:3326` and removed only when `run()` settles (`:3413`, `:3440`, `:3463`) | Covered: `running, requires_action, running, idle` (`.agents/state.md` 2(a2-v)-1f) |
| **Baseline tracker `DENY_ALL_*`** (`CodexAcpServer.ts:312-321`) | n/a | Handles requests before the first prompt | **Sends nothing to ACP.** Returns cancel / empty answers directly |
| **Device-code login / `authenticate` URL elicitation** (`createUrlElicitationRequester`, `CodexAcpServer.ts:1370-1395`) | no: `requestId`-scoped | n/a | No state updates (`ACPSessionConnection.ts:103-110`) |

Neither real path is covered by a v2 test today:
- The v2 "OAuth re-auth" tests in `src/__tests__/CodexACPAgent/elicitation-v2.test.ts:36-58,84-109` drive a Codex `mcpServer/elicitation/request` URL elicitation **inside** a running turn.
- The only `authenticateMcpServer` test is v1 (`elicitation-events.test.ts:720-754`).

### 2. What v2 says

- Session states (`prompt-lifecycle.mdx:512-526`):
  - `running`: "Foreground work is in progress."
  - `idle`: "The Agent is ready to process a new prompt."
  - `requires_action`: "Foreground work is blocked on user action."
- The only `requires_action` rule is R1, and its trigger is "while **foreground work** is blocked".
  With no foreground work, that SHOULD does not apply, so omitting `requires_action` is conformant.
- Sending it anyway contradicts the state's definition (R2). More importantly, it leaves the last
  reported state as non-idle while codex-acp is in fact ready for a prompt. That conflicts with the
  R3 MUST: "When the Agent is ready to process a new prompt, it MUST report idle". This is an
  interpretation; the spec has no explicit "outside a turn" rule.
- What must follow `requires_action` is only stated for the in-work case: `running` when work
  resumes (SHOULD), or `idle` + `stopReason` if work stops (R3/R5).
- The spec is silent on a `requires_action` that was never inside foreground work. If an agent
  returns such a client to `idle`:
  - Docs: that transition arguably "ends foreground work", so `stopReason` is a MUST
    (`prompt-lifecycle.mdx:377`). None of the five reasons fits, so it would need a custom `_…`
    reason.
  - Schema: `stopReason` is only SHOULD (`schema.json:4909`), so a bare `idle` is schema-valid.
- The elicitation doc (`elicitation.mdx`) never mentions `state_update`.
- The TCK has no row for out-of-turn `requires_action`. STATE-201 would **fail** an
  `idle{stopReason}` without a prior `running` if it landed in a prompted session's window
  (`requirements.py:211-227`). A bare `idle` is not "turn-ending", so no STATE row checks it.
- **SDK client** (`acp-typescript-sdk/src/v2/acp.ts:2835-2861`):
  - Only `idle` is interpreted. `requires_action` and `running` are passed through as plain
    `session_update` messages; nowhere else in `src/` does the SDK handle `requires_action`.
  - **Any** `idle`, with or without `stopReason`, ends the prompt awaiting completion (`kind: "stop"`).
  - "Awaiting" starts synchronously when `ActiveSession.prompt()` is called (`acp.ts:1195-1213`,
    `:1886-1888`), before the agent has even received the request.
  - So a stray `idle` that races a just-sent prompt would end that prompt's `readText()` early.
  - For a stock SDK client, the stuck `requires_action` is harmless. It matters to UIs that track
    state (e.g. a "needs your input" badge that never clears).

### 3. Options

**(a) Bracket only when busy (recommended).** Decide at send time:
`const bracket = this.isTurnRunning(sessionId)`.
- If `bracket` is true, send `requires_action`. In `finally`, send `running` only if both
  `bracket` and `this.isTurnRunning(sessionId)` are true.
- Otherwise send neither. The request itself is still sent; the state stays `idle`, which is true.
- Apply the same change to `requestPermission()` (`ACPSessionConnection.ts:72-89`) and to the
  session-scoped branch of `createElicitation()` (`:98-124`). Update the `setTurnRunningCheck`
  doc comment (`:28-35`).

Why it holds up:
- Matches R1 (the SHOULD only covers blocked foreground work), R2, and R3. It sends no invented
  `idle`/stop reason and has no SDK-client race.
- Edge: a request starts idle, then a v2 prompt or Codex turn starts while it is pending. The turn
  sends its own `running`/`idle`, and (a) sends nothing extra, which is correct.
- Remaining edge (hypothesis, not observed): a prompt is between `session/prompt` receipt and
  `v2PromptsInFlight.add` (`CodexAcpServer.ts:3326`, after the FIFO reservation) when an idle-time
  request arrives. It gets no bracket. That is still correct, since the prompt then sends
  `running` itself.

**(b) `requires_action` then `idle` in `finally`.**
- Sends a state for work that does not exist.
- A `stopReason` is needed per the docs (R3), but no standard reason fits, so it needs a custom `_…`.
- A bare `idle` is schema-valid but arguably violates the docs' MUST.
- Races the SDK client: any `idle` completes a prompt the client has just sent (`acp.ts:2845-2851`).
- An `idle{stopReason}` without `running` risks TCK STATE-201.
- Not recommended.

**(c) Leave as is.**
- The client is stuck at `requires_action` after the request settles, until the next prompt.
- Deterministic on MCP OAuth re-auth at session open.
- Arguably violates R3 (MUST report `idle` when ready).
- Not recommended.

**v1 impact of (a): none.**
- `AcpV2Connection` is used only on v2. `setTurnRunningCheck` is wired only when the connection is
  an `AcpV2Connection` (`CodexAcpServer.ts:466-478`).
- v1 sends `session/request_permission` / `elicitation/create` directly through the plain connection.
- The default check `() => true` (`ACPSessionConnection.ts:21`) keeps unwired callers bracketed
  exactly as today.

## Testability notes

- **OAuth at session open (v2).** Connect a v2 session with `clientCapabilities: {elicitation: {url: {}}}`.
  Mock `mcpServerOauthLogin`/`awaitMcpServerOauthLoginCompleted` as `elicitation-events.test.ts:726-734`
  does, and invoke `(agent as any).authenticateMcpServer(sessionId, 'linear')`. Better: drive
  `session/new` with `mcpServers` plus a mocked `awaitMcpServerStartup` returning
  `failed: [{server, failureReason: "reauthenticationRequired"}]`.
  - Assert the transcript has the `elicitation/create` (with `sessionId`) and
    `stateUpdates(transcript)` equals `[]`.
  - A non-conforming result is `[{state: "requires_action"}]` with nothing after it (today's behavior).
- **Idle-time Codex MCP elicitation (v2).** Run a prompt to `idle` with `startRunningPrompt` +
  `finishTurn`. Then `client.triggerApproval('mcpServer/elicitation/request', oauthReauthParams({turnId: null}))`
  (helper in `elicitation-v2.test.ts:60-71`).
  - Assert the elicitation is sent and no `state_update` follows the prior `idle`.
  - Repeat with the `session/request_permission` fallback (client without URL support) to cover
    `requestPermission()`.
- **Regression pins (unchanged):**
  - in-turn elicitation/permission: `[requires_action, running]` (`elicitation-v2.test.ts:108`)
  - plan-implementation: `running, requires_action, running, idle`
  - late request after turn end: `requires_action … idle`, no `running`
- **Overlap.** Start an idle-time elicitation, then send a prompt while it is pending, then settle it.
  Assert exactly the prompt's own `running`/`idle`, with no extra `running` from the elicitation's `finally`.
- **Unobservable:** whether a real MCP server ever sends idle-time elicitations. Snapshot the
  mocked path only.

## Discrepancies

- **Docs vs schema on idle `stopReason`:** `prompt-lifecycle.mdx:377` / `migration.mdx:282` say
  MUST when the transition ends foreground work; `schema/v2/schema.json:4909` says SHOULD. This
  only matters for option (b).
- **Spec vs SDK:** the spec gives `idle` "ready for a new prompt" semantics that are independent
  of prompts. The SDK client ties any `idle` to the pending prompt (`acp.ts:2845-2851`), with no
  prompt id on `state_update`. This is already noted in `.agents/state.md`.
- **codex-acp test comment vs code:** `elicitation-v2.test.ts:36-38` says "the MCP OAuth re-auth
  flow only ever fires mid-turn". codex-acp's actual MCP OAuth re-auth (`authenticateMcpServer`)
  fires at session open, outside any turn. The test exercises Codex's `mcpServer/elicitation/request`
  URL mode, a different path.

## Open questions

- **Subagent child sessions (adjacent).** With the subagents capability, interaction requests are
  retargeted to the child ACP session id (`CodexSubagentSubscriptions.ts:139-146`). `isSessionBusy(childId)`
  is always false: child sessions are not in `this.sessions`, and codex-acp sends no child
  `running`. So a child-session permission produces `requires_action` on the child and never
  anything after it. This is code-derived. Whether child sessions should get `state_update`s at
  all belongs to topic 10.
- **Stale prompt handlers after the prompt ends (adjacent).** After a prompt completes, its handlers
  keep its `interactionSignal`, and `session/cancel` can no longer abort it: `activePrompts` has
  dropped the entry (`CodexAcpServer.ts:3015-3025`, `:4196-4203`). So an idle-time elicitation
  cannot be cancelled with `session/cancel`. Is that intended?
- **Ordering vs the `session/new` response (unverified).** The OAuth elicitation is fire-and-forget
  from inside `tryCreateSession`. It normally lands after the response, but nothing orders it. A
  session-scoped `elicitation/create` could theoretically reach the client before the client knows
  the `sessionId`.

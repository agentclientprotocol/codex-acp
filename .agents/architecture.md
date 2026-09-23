# ACP v2 Migration — Proposed Architecture

> Research-only. Each section below is owned by one research subagent (see matching topic in
> `.agents/research/<topic-slug>.md` and `.agents/prompt.md`). Do not edit another section.

## 1. Capability negotiation & initialize (`v2-capability-negotiation-and-initialize`)

**v1 is preserved; v2 is added alongside it.** Full detail:
`.agents/research/v2-capability-negotiation-and-initialize.md`.

- **Dispatch layer (`src/index.ts`):** replace the single `.connect(acpJsonStream)` call at the end of
  `startAcpServer()` with `acpV2.agentProtocolRouter().withV1(v1Agent).withV2(v2Agent).connect(acpJsonStream)`, where
  `v1Agent` is today's existing `acp.agent({...}).onRequest(...)` chain (unchanged, imported from
  `@agentclientprotocol/sdk`) and `v2Agent` is a new, parallel chain built with
  `acpV2.agent({...})` (imported from `@agentclientprotocol/sdk/experimental/v2`). The router reads only the first wire
  message's `protocolVersion` and hands the rest of the raw stream, untouched, to whichever chain matches — no
  hand-written version-sniffing code needed. Each connection is served by exactly one chain for its lifetime, per spec (
  "one protocol version per connection").
- **Business logic (`src/CodexAcpServer.ts`):** add a new `initializeV2(params: v2.InitializeRequest):
  Promise<v2.InitializeResponse>` method alongside the existing `initialize` (`:359-433`), sharing the same
  `codexAcpClient`, auth-method sourcing (`getCodexAuthMethods`), elicitation-capability checks, and extension `_meta`
  blocks (`steering`, `goal`, JetBrains AIR keys) that `initialize`
  already assembles — those extension mechanisms are unchanged by v1→v2 since v2's `_meta` is the same kind of
  passthrough bag. `initializeV2` builds the response as:
  `{ protocolVersion: 2, info: {name, title, version}, capabilities: { session: {...}, auth: {} },
  authMethods }`, with `capabilities.session` populated as `{ prompt: {image:{}, audio:{},
  embeddedContext:{}}, mcp: {stdio:{}, http:{}}, delete: {}, additionalDirectories: {} }` (booleans → object markers;
  `list`/`resume`/`close` markers dropped entirely since advertising
  `capabilities.session` now implies the full 7-method baseline; `loadSession` dropped). Do not try to share a single
  builder function between v1's and v2's capability objects — the shapes are incompatible by design (booleans vs.
  objects, different nesting), so deliberate duplication between `initialize` and `initializeV2` is expected and
  reviewable, not a code smell.
  `protocolVersion` in the v2 path is always `2` (the router already guarantees the connection was routed to `v2Agent`
  only when the client requested `>= 2`), so no per-request negotiation logic is needed inside `initializeV2` itself.
- **Types touched:** `src/ElicitationCapabilities.ts` (swap `acp.ClientCapabilities` for the v2 type when called from
  the v2 path — its `form`/`url` logic is unchanged, elicitation was already object-shaped in v1),
  `src/CodexAuthMethod.ts`'s `getCodexAuthMethods` (needs a v2-typed overload or parameter, and must gate any future
  `type: "terminal"` auth method on
  `capabilities.auth.terminal`, the v2 nested marker, per `ACP-AUTH-202`), and
  `src/subagents/AcpSubagents.ts`'s `SubagentAwareSessionCapabilities` (needs a v2-shaped counterpart, since `fork`/
  `subagents` aren't part of the standard v2 `SessionCapabilities` and need a `_meta` home or an extension proposal).
- **No transport-layer changes needed:** the installed SDK's stdio `Connection` already parses and emits JSON-RPC batch
  frames by default (`allowBatches` defaults to `true`), and every v2 type already carries a passthrough `_meta` field
  honored by the generated Zod schemas — batching and
  `_meta` extensibility require no new code here or in a separate topic.

## 2. Prompt lifecycle & turn state machine (`v2-prompt-lifecycle-and-turn-state-machine`)

**Multi-milestone; all 3 milestones designed.** Full detail:
`.agents/research/v2-prompt-lifecycle-and-turn-state-machine.md` (§§1-5 milestone (a), §6 milestone (b), §7 milestone
(c), §8 final risk verdict).

- **Wire shape (milestone (a)):** the v2 `session/prompt` request is unchanged from v1 (`sessionId`,
  `prompt: ContentBlock[]`). The response drops `stopReason`/`usage` and becomes
  `{ messageId }` — an insertion acknowledgment sent as soon as the user message is in the ACP conversation, decoupled
  from turn completion (which moves to `state_update` `session/update`
  notifications, see below).
- **Why this is not a parallel-construction handler like `initializeV2`:** v1's
  `CodexAcpServer.prompt()` (`src/CodexAcpServer.ts:2801`) is a single linear `async` method whose own promise lifetime
  **is** today's turn-completion signal — it `await`s
  `codexAcpClient.sendPrompt` → `CodexAppServerClient.runTurn` (`src/CodexAppServerClient.ts:295`)
  all the way to the app-server's `turn/completed` notification (sometimes running a *second*, internal turn for its
  plan-approval sub-flow, `CodexAcpServer.ts:3116-3179`) before constructing a `{stopReason}` result. A v2 handler
  cannot simply build a different response object from the same inputs the way `initializeV2` does; it must **return as
  soon as the message is accepted**
  (the existing `onTurnStarted` callback threaded through `CodexAppServerClient.ts:303` and
  `CodexAcpServer.ts:2917/:3031/:3131` is the best existing hook for that moment) while the rest of turn execution —
  event handling, plan-approval, subagent waiting, cancellation — keeps running in the background and reports its
  outcome via notifications instead of the RPC return value.
- **This pattern is already proven in the codebase, not hypothetical:**
  `startNewTurnFromExternalPrompt` (`CodexAcpServer.ts:1666-1721`), used today by the
  `_session/steering` extension, already calls `this.prompt(...)` and resolves its own returned promise early from the
  `onTurnStarted`-style callback, letting `prompt()`'s own promise settle in the background afterward (handled only for
  logging/outcome purposes). The v2 handler design target is to generalize this exact shape to the primary
  `session/prompt` RPC, not invent a new control-flow pattern.
- **`state_update` mapping (milestone (b)) — no new decision logic needed:**
    - `running`: emitted from the same `onTurnStarted` hook used for the `{messageId}` response, and again whenever a
      `requires_action` period ends.
    - `idle` + `stopReason`: reuses the exact two-value mapping (`"end_turn"` /
      `"cancelled"`) `CodexAcpServer.ts:3330-3356` (`cancelledPromptResponse`,
      `terminalFailurePromptResponse`) already computes from `turnCompleted.turn.status` — a pre-existing fidelity gap
      (codex-acp never distinguishes `refusal`/`max_tokens`/
      `max_turn_requests` today) that v2 migration does not need to fix, just relocate from a response field to a
      notification field.
    - `requires_action`: wrap the four existing `session/request_permission` call sites
      (`CodexApprovalHandler.ts:51,70,87` and `CodexAcpServer.ts:3306`,
      `requestPlanImplementationPermission`) with `state_update: requires_action` immediately before the request and
      `state_update: running` immediately after it resolves — no existing
      "blocked" flag exists to reuse (`PermissionLifecycleContext`/`PermissionPromptContext` in
      `src/permissions/lifecycle.ts` only handle MCP tool-call correlation), but none is needed beyond bracketing these
      four call sites.
    - Cancellation confirmation is simply the idle `state_update` carrying `stopReason: "cancelled"`
      — there is no separate ack notification (feeds directly into the `v2-cancellation-semantics`
      topic; don't re-derive this there).
    - No SDK gap: the installed `1.4.0`'s `state_update`-related types are byte-identical to
      `origin/main`, unlike milestone (a)'s `PromptResponse.messageId` bug.
- **Steering/queued-prompt convergence (milestone (c)):** the spec explicitly permits a client to send `session/prompt`
  while `running` (`migration.mdx:321` names "queued work" as a first-class v2 case), but `trackActivePrompt`
  (`CodexAcpServer.ts:2574-2626`) has no protection against two concurrent `prompt()` calls per session — a race never
  exercised today only because v1 clients wait for the blocking response and codex-acp's own steering code
  (`SteeringQueue.ts`,
  `getSteerableTurnId`, `CodexAcpServer.ts:1523-1721`) deliberately serializes around it
  (`await previousPrompt?.completion`, `:1674-1675`). **Design: do not give v2 `session/prompt` an independent naive
  path.** Route it through the same turn-liveness check (`getSteerableTurnId`)
  and the same per-session `SteeringQueue` the `_session/steering` extension already uses — inject into a live turn or
  queue behind it when running, start a new turn when idle — converging plain v2 `session/prompt` and the custom
  extension onto one shared "insert new foreground work, running-or-not" primitive. Keep `_session/steering` registered
  unchanged on both v1 and v2 chains (its `injected`/`startedNewTurn`/`failed` outcome enum remains useful for clients
  that want it explicitly). Fallback if this proves too invasive to land safely: make v2
  `session/prompt` reject outright when a turn is already live for the session — spec-legal, but forgoes the redesign's
  stated benefit.
- **Dependency prerequisite:** the installed `@agentclientprotocol/sdk@1.4.0`'s v2 `PromptResponse`
  generated type is missing `messageId` (stale relative to both the current spec and the SDK's own
  `origin/main`). The already-published `@agentclientprotocol/sdk@1.5.0` has it fixed — bump the dependency before
  implementing this handler. (This is the only SDK-version prerequisite in this topic; `state_update`'s types need no
  bump.)
- **Final risk verdict:** the wire-shape and notification-mapping work is cheap (no new decision logic anywhere). The
  RPC-resolution/turn-lifetime decoupling has a working precedent already shipping (`startNewTurnFromExternalPrompt`),
  lowering it from "unproven redesign" to "generalize an existing pattern to the primary call site." The one genuine
  remaining structural risk is generalizing the single-flight `activePrompts`/`pendingTurnStarts`/`currentTurnId`
  bookkeeping to safely support concurrent prompt-shaped operations per session, which milestone (c)'s converged design
  requires — that, not the response/notification shapes, is where implementation effort and risk actually concentrate.

## 3. Cancellation semantics (`v2-cancellation-semantics`)

**No new abort logic; only route the existing `cancelled` outcome through the notification fork the prompt-lifecycle
topic already designed.** Full detail:
`.agents/research/v2-cancellation-semantics.md`.

- **Dispatch layer:** register `session/cancel` on the `v2Agent` chain (`acpV2.methods.agent.session.cancel`) delegating
  to the **same** `CodexAcpServer.cancel()`
  method the v1 chain already calls (`CodexAcpServer.ts:3413-3422`) — the params shape (`{sessionId, _meta?}`) and
  notification-not-request semantics are identical in both versions (schema-codegen type renamed `CancelNotification`→
  `CancelSessionNotification`, wire format unchanged, `migration.mdx:710`), so `cancel()`'s body needs zero
  modification.
- **Abort machinery (`interruptSessionTurn`, `requestTurnInterrupt`,
  `observePromptRequestCancellation`, `getInterruptibleTurnId`):** stays exactly as-is, called identically from both
  versions' `cancel()` invocation — none of this code reads
  `clientCapabilities`/`protocolVersion` or otherwise branches on ACP version.
- **The one fork — where the `cancelled` outcome gets reported — is owned by topic 2's milestone (b), not built here:**
  v1 keeps constructing `cancelledPromptResponse()` (`:3330-3336`) and returning it from `prompt()`'s pending promise,
  unchanged. v2's background turn-execution task (topic 2's decoupled continuation) must, on observing
  `activePrompt.signal.aborted` /
  `turn.status === "interrupted"` — the same signal/status v1 already reads — send
  `session/update{sessionUpdate:"state_update", state:"idle", stopReason:"cancelled"}` instead of returning a value.
  This is the `cancelled` branch of the exact same two-value `end_turn`/
  `cancelled` decision milestone (b) already designed for normal turn completion; this topic supplies no new decision
  logic, only confirms the cancellation branch routes through the same fork point. The SDK's own reference example
  (`acp-typescript-sdk/src/examples/dual-version-agent.ts:139-141,171-179,251-264`) confirms this exact shape — a
  `session/cancel` handler that only calls `controller.abort()`, with the turn's own
  `catch (signal.aborted)` block emitting the idle-cancelled `state_update` — matching codex-acp's existing v1 split
  between `observePromptRequestCancellation` (aborts a signal) and
  `cancelledPromptResponse()` (reports the outcome from that signal/turn status), a structure that generalizes directly
  rather than needing a redesign.
- **Pending-permission-request cascade needs no new code.** `CodexApprovalHandler`/
  `CodexElicitationHandler` are already constructed with `activePrompt.signal` as a
  `cancellationSignal` (`CodexAcpServer.ts:2870-2880`), and the SDK's generic
  `connection.request(..., {cancellationSignal})` (`acp-typescript-sdk/src/jsonrpc.ts:1120-1136`)
  already sends `$/cancel_request` for that pending outbound request when the signal aborts — this is the exact
  (non-normative, `ACP-INFO-CANCEL-202`) cascade `cancellation.mdx`'s mermaid diagram illustrates, and the general
  `$/cancel_request` mechanism itself is unchanged between v1 and v2 (diffed the two `cancellation.mdx` docs
  word-for-word). The only action needed is threading whatever abort signal the v2 background turn task uses into the
  same
  `CodexApprovalHandler`/`CodexElicitationHandler` constructors — a wiring detail inherited from topic 2's design, not
  new cancellation logic.
- **`session/close` needs no restructuring** for `ACP-CANCEL-208`/`ACP-CLOSE-202` ("close cancels in-flight work the
  same way `session/cancel` does"): `closeSession`
  (`CodexAcpServer.ts:899-919`) already `await`s `interruptSessionTurn` to completion before responding `{}` — the idle
  `state_update` and the close response are independent channels, so the existing blocking-close shape already
  accommodates the v2 requirement once the state_update mechanism exists.
- **No SDK gap:** `CancelSessionNotification` is byte-identical across the installed
  `@agentclientprotocol/sdk@1.4.0`, the local SDK checkout, and `origin/main` — unlike topic 2's
  `PromptResponse.messageId` staleness finding, no dependency bump is required specifically for this topic.

## 4. Permission requests & approvals (`v2-permission-requests-and-approvals`)

**Fork request construction at the shape boundary; keep decision/option logic and response parsing fully shared.** Full
detail: `.agents/research/v2-permission-requests-and-approvals.md`.

- **Request-building (`src/permissions/presentation.ts`, `plan-review.ts`, `mcp.ts`):** each function that currently
  returns a bare `acp.ToolCallUpdate` for the `toolCall` field (`commandToolCall`, `fileChangeToolCall`,
  `additionalPermissionsToolCall`,
  `planImplementationPermissionRequest`, `buildMcpPermissionRequest`) grows a v2-shaped sibling (or internal branch)
  returning `{title, description?, subject}` instead: the same `ToolCallUpdate`
  object minus its `title` field, wrapped as `subject: {type: "tool_call", toolCall: {...}}`, with the prompt-copy
  string that used to live at `toolCall.title` relocated to the new top-level, required `title` field. Command-execution
  approval may optionally use the purpose-built
  `subject: {type: "command", command, cwd, toolCallId?, terminalId?}` instead of `tool_call` — a design choice, not a
  requirement.
- **Plan review has no dedicated v2 subject** (schema only defines `tool_call`/`command`
  `$defs`). Design: keep `planImplementationPermissionRequest` producing `subject: {type:
  "tool_call", toolCall: {kind: "switch_mode", ...}}` (spec-legal — `switch_mode` is a valid
  `ToolKind` in both versions), just moving `"Implement this plan?"` out of the nested toolCall into the new top-level
  `title`. Treat a formal `_codex/plan_review` custom subject extension (formalizing the existing write-only
  `_meta: {codex: {kind: "plan_review", ...}}` marker in
  `plan-review.ts:28`) as a later enhancement, not part of this migration's initial scope.
- **Decision/option logic and response parsing are unchanged, shared as-is between v1 and v2**:
  `commandDecisionOptions`/`fileChangeDecisionOptions`/`permissionProfileOptions` (`options.ts`),
  `parseAvailableCommandDecisions`/`defaultCommandDecisions`/`parseCommandDecision`
  (`command-decision-contract.ts`), `ApprovalOptionId`/`McpApprovalOptionId` (`option-ids.ts`), and
  `CodexApprovalHandler`'s `selectedDecision`/`permissionsResponse`/`grantedPermissionsResponse`
  plus `plan-review.ts`'s `planImplementationApproved` and `mcp.ts`'s
  `convertMcpPermissionResponse` all operate on `PermissionOption[]`/the response `outcome` union, neither of which
  changes shape between v1 and v2 — no fork needed here at all.
- **Harden outcome parsing for the open union (`ACP-ENUM-203`):** every response-parsing site above branches on
  `outcome.outcome === "cancelled"` else assumes `"selected"`/reads `.optionId`
  directly. v2's `RequestPermissionOutcome` is an open union (custom `_`-prefixed outcomes are legal and MUST NOT be
  treated as approval), so this must become an explicit `outcome.outcome ===
  "selected"` check with a safe non-approval fallback otherwise — apply to both v1 and v2 code paths, since it's a
  genuine pre-existing type-safety gap, not v2-specific.
- **`requires_action` bracketing:** wrap `CodexApprovalHandler.ts`'s shared private
  `requestPermission` helper (`:105-111`, already the single call funnel for the 3 sites at
  `:51,70,87`) with a `state_update: requires_action` notify immediately before
  `this.connection.request(...)` and a `state_update: running` notify immediately after it settles (covering the
  grant/deny/cancel/error branches uniformly — all count as "resumed"). This requires giving `CodexApprovalHandler`
  access to emit `session/update` notifications via its existing
  `connection: AcpClientConnection` field (currently request-only, no `notify` calls). For the 4th site,
  `CodexAcpServer.ts:3306-3310` (`requestPlanImplementationPermission`), add the
  `requires_action` notify immediately before the request and fold the `running` notify in alongside the existing
  post-response `tool_call_update` "completed" notify at `:3312-3322`. No new state-tracking data structure needed —
  confirmed no existing "blocked" flag exists in
  `PermissionLifecycleContext`/`PermissionPromptContext` (`src/permissions/lifecycle.ts`), and none is required since
  today's call graph never produces two concurrent permission requests for one session (revisit only if the
  prompt-lifecycle topic's milestone (c) steering/queueing convergence changes that later — the fix then would be a
  per-session in-flight counter, not a redesign).
- **v2-only method registration is otherwise unaffected:** `session/request_permission` keeps its method name and
  response shape (`{outcome}`) unchanged between versions — this topic is a request-payload-shape fork plus new
  notification sends, not a new method or a control-flow/ lifetime restructuring like the prompt-lifecycle topic's
  `session/prompt` redesign.
- **No SDK dependency bump needed for this topic's types** — installed
  `@agentclientprotocol/sdk@1.4.0`'s `RequestPermissionRequest`/`RequestPermissionSubject`/
  `ToolCallPermissionSubject`/`CommandPermissionSubject`/`RequestPermissionResponse`/
  `RequestPermissionOutcome` already match the current spec and `origin/main`, unlike the prompt-lifecycle topic's
  `PromptResponse.messageId` staleness finding.

## 5. Session lifecycle: new/resume/list/close/delete (`v2-session-lifecycle-new-resume-list-close-delete`)

**v1's two reattach methods collapse into v2's one method + a branch; no history-replay logic is rebuilt.** Full detail:
`.agents/research/v2-session-lifecycle-new-resume-list-close-delete.md`.

- **`session/close`, `session/delete` (v2 handler chain):** register thin v2 wrappers that call
  `CodexAcpServer.closeSession(params)` / `deleteSession(params)` directly — the v1 and v2 wire shapes are identical
  (`{sessionId}` in, `{}` out), so there is nothing to translate.
- **`session/new` (v2 handler chain):** call the existing `getOrCreateSession`/
  `tryCreateSession(..., "new")` path unchanged, but (a) fix `CodexAcpClient.newSession()`
  (`CodexAcpClient.ts:672`) to apply `request.mcpServers ?? []` before calling
  `createSessionConfig` — today it's the one call site missing that fallback, safe under v1's required-even-if-empty
  `mcpServers` but not under v2's optional field (`ACP-SESSION-203`) — and (b) build the v2 `NewSessionResponse` as
  `{sessionId, configOptions}` only, sourcing
  `configOptions` from whatever topic 9 (`v2-config-options-modes-and-plans`) produces for
  `models`/`modes`, rather than returning the v1 `LegacySessionModelState`/`SessionModeState`
  fields.
- **`session/resume` (v2 handler chain) — the one real dispatch point in this topic:** register a *single* v2
  `session/resume` handler that inspects `params.replayFrom` and calls one of the two code paths v1 already exposes as
  separate methods:
    - `replayFrom` absent/`null` → same as v1 `resumeSession` today: `getOrCreateSession` /
      `tryCreateSession(..., "resume")` (`CodexAcpServer.ts:543-757,841-858`). No replay traffic is emitted.
    - `replayFrom: {"type": "start"}` → same as v1 `loadSession` today:
      `getOrCreateSessionWithHistory` + `streamThreadHistory` (`CodexAcpServer.ts:807-839,1910-2057`).
      `streamThreadHistory` already emits ordinary `session/update` notifications through
      `ACPSessionConnection`, which writes over whichever connection the `agentProtocolRouter` handed the client — no
      new plumbing needed to get replay traffic onto the v2 wire once the v2
      `session/update` notification builder exists (owned by the tool-calls/messages topic). Both the native
      `Thread.turns[].items[]` path (`createHistoryUpdates`) and the file-based fallback
      (`ResponseItemHistoryFallback.ts`, for rollouts/clients where native subagent-aware history is unavailable)
      already produce the same `UpdateSessionEvent[]` shape this needs — do not restructure either.
    - Any other `replayFrom.type` (custom/future cursor): no existing precedent to reuse; decide at implementation time
      whether to reject with an error or no-op-with-warning — the spec deliberately leaves the cursor union open for
      future variants and imposes no requirement here.
    - Build the v2 `ResumeSessionResponse` as `{configOptions}` only (same models/modes-to-config- options dependency on
      topic 9 as `session/new` above).
    - Before wiring this up, add an explicit check that every replayed `user_message`/
      `agent_message`/`agent_thought` carries a `messageId` — v1's schema made it optional, v2 makes it required, and
      `ACP-RESUME-204` ties replayed user-message ids back to the `session/prompt`
      response id. Expected to already hold given current item-id assignment, but not previously schema-enforced.
- **`session/list` (v2 handler chain):** call `CodexAcpServer.listSessions(params)` unchanged and pass the result
  straight through — v2's `SessionInfo` is a superset of v1's, and the one new field (`additionalDirectories`) is
  already patched in from live `SessionState`
  (`CodexAcpServer.ts:886-894`) in a version-agnostic way.
- **No new session-lifecycle state, storage, or persistence model is needed.** Every method above reuses the same
  `SessionState`/`SessionMetadata` construction (`tryCreateSession`,
  `getOrCreateSessionWithHistory`) that v1 already has; the v2 handler chain differs from v1's only at the top-level
  method-registration/dispatch layer and at the final response-shape assembly, per the shared-application-logic pattern
  from topic 1.

## 6. Tool calls, messages & terminal streaming (`v2-tool-calls-messages-and-terminal-streaming`)

**All 3 milestones designed.** Full detail:
`.agents/research/v2-tool-calls-messages-and-terminal-streaming.md`.

- **Milestone (a) design — fork only at the wire-serialization boundary, no internal state change.** v1's `tool_call`
  (create) and `tool_call_update` (patch) collapse into v2's single
  `tool_call_update` upsert (first update for an unseen `toolCallId` is the create; TCK
  `ACP-PATCH-204` confirms no create-before-update ordering needs preserving). Every paired create/update function in
  `src/CodexToolCallMapper.ts` (~10 tool-call categories: file changes, command execution, MCP/dynamic tool calls, image
  view/generation, context compaction, guardian approval review, fuzzy file search, web search, collab-agent calls,
  subagent activity) already decides "first emission or not" from the shape of the incoming Codex app-server event, not
  from codex-acp-owned bookkeeping — so **no restructuring of that decision logic is needed**. Design:
  keep every existing v1-shaped internal object exactly as constructed, and add one small rewrite step at
  `ACPSessionConnection.update()` (`src/ACPSessionConnection.ts:18-23`, the near-universal
  `session/update` send point): on a v2-negotiated connection, re-tag any `sessionUpdate:
  "tool_call"` event to `"tool_call_update"` before calling the v2-typed
  `acp.methods.client.session.update` binding — no field remapping needed, since every field the v1 create-shape carries
  (including `title`, whose v1-required-ness merely relaxes to SHOULD-but-optional in v2) is already a valid v2
  `ToolCallUpdate` field. **Prerequisite cleanup**:
  route 5 call sites that currently bypass `ACPSessionConnection` with inline v1-typed
  `connection.notify(...)` calls (`CodexElicitationHandler.ts:221,228,556`,
  `CodexAcpServer.ts:2538,3312` — all already `tool_call_update`-shaped, so no rename needed there, just re-routing)
  through `ACPSessionConnection` so the v2 fork stays centralized in one place instead of needing 5 individual
  duplicates.
- **`messageId` requirement design:** v2 requires a non-empty `messageId` on every message chunk/upsert
  (`ACP-PATCH-201`), but `src/ContentChunks.ts:13-59`'s three chunk-builder functions treat it as an optional parameter
  and omit the field entirely when absent — ~12 call sites across
  `CodexEventHandler.ts`, `CodexCommands.ts`, and `ResponseItemHistoryFallback.ts` (ad-hoc system notices with no
  natural upstream item id: config warnings, model-reroute notices, slash-command responses, context-compaction notices)
  never pass one today. Design: generate a fresh id (e.g.
  `crypto.randomUUID()`) inside `ContentChunks.ts` itself whenever the caller omits `messageId`, but only on the v2 send
  path — keeps v1 behavior (omit the field) untouched and avoids editing ~12 call sites individually. One exception:
  `ResponseItemHistoryFallback.ts:242` replays history, so a random id minted per-replay would not be stable across
  replays of the same item — that path needs a *deterministic* id derived from the underlying Codex item instead,
  coordinated with topic 5's `ACP-RESUME-204`/`ACP-RESUME-205` replay-consistency requirements.
- **`tool_call_content_chunk` (new streaming variant):** purely additive — nothing in codex-acp streams incremental
  tool-call content today (`content` is always sent as a whole array via
  `tool_call_update`), so adopting it is optional net-new capability, not a migration of existing logic; not required
  for v2 conformance and out of this milestone's required scope.
- **No SDK type gap for this milestone**, unlike the sibling prompt-lifecycle topic's
  `PromptResponse.messageId` bug: the installed `1.4.0`'s `ToolCallUpdate`/`ToolCallContentChunk`/
  `UserMessage`/`AgentMessage`/`AgentThought`/`ContentChunk` types were diffed against
  `acp-typescript-sdk` origin/main and differ only cosmetically. This also holds for milestones (b)/ (c):
  `TerminalUpdate`/`TerminalOutputChunk`/`Terminal`/`Diff`/`DiffChange`/`DiffPatch` are byte-identical between the
  installed `1.4.0` and `origin/main`.

- **Milestone (b) design — agent-owned terminal streaming.** First, a correction to where the design applies:
  `src/async-tasks/CodexBackgroundTerminalTasks.ts`/`BackgroundTerminalApi.ts`
  (flagged by milestone (a)'s handoff as "the architecture question") turned out to be an unrelated proprietary AIR
  "background task" bookkeeping extension (`async_task_spawned`/
  `async_task_state_update`, ACP-schema-external in both versions) that never streams terminal output at all — it needs
  only milestone (a)'s generic tool-call fork (it already emits
  `tool_call_update`-shaped events, `:283-295`) and nothing terminal-specific. The actual surface is
  `src/TerminalOutputMode.ts` + `src/CodexToolCallMapper.ts`'s `createTerminalCommandEvent`/
  `createCommandExecutionCompleteUpdate` + `src/CodexEventHandler.ts`'s
  `createCommandOutputDeltaEvent`/`createTerminalInteractionEvent`/`completeCommandExecutionEvent`.

  Today these smuggle live command output through **private, non-standard `_meta` keys**
  (`terminal_output`/`terminal_output_delta`/`terminal_exit`/`terminal_info`) riding on ordinary
  `tool_call_update` notifications, mode-selected via a custom `clientCapabilities._meta` boolean
  (`resolveTerminalOutputMode`) — invented because v1 core ACP gives codex-acp no standardized replace-vs-append
  contract for agent-streamed output (it never uses the real client-executed
  `terminal/create`, confirmed by the sibling MCP/client-execution-surface topic). The genuine v1
  `ToolCallContent` `{type: "terminal", terminalId}` reference is used today only as a display anchor
  (`createTerminalCommandEvent`), with `terminalId := item.id` and `cwd` smuggled into
  `_meta.terminal_info` rather than any standard field.

  **Design for v2**: keep every v1 code path unchanged (the private `_meta` hack remains load-prevalent for v1
  connections), and add a parallel v2-only emission at the same points:
    - Command start: alongside the unchanged `{type:"terminal", terminalId: item.id}` content-block reference
      (byte-identical shape in v1 and v2, no change needed there — spec confirms the reference and the terminal's own
      updates may arrive in either order), send
      `terminal_update{terminalId: item.id, command: item.command, cwd: item.cwd}` as its own top-level
      `session/update`.
    - Each output delta (`item/commandExecution/outputDelta`, and the
      `item/commandExecution/terminalInteraction` stdin-echo path): send
      `terminal_output_chunk{terminalId, data: base64(delta)}` instead of patching `_meta`.
    - Completion: send `terminal_update{terminalId, output: {data: base64(aggregatedOutput)},
    exitStatus: {exitCode: item.exitCode, signal: null}}`.
    - `TerminalOutputMode.ts`'s negotiation (`resolveTerminalOutputMode`,
      `clientSupportsTerminalOutputDelta`) becomes **v1-only** — v2 needs no mode selection at all, because
      `terminal_output_chunk` (always-append) and `terminal_update.output` (always-replace snapshot) are two
      independently-valid channels an agent can always send both of, unlike v1's hack which needed an out-of-band
      negotiated choice between the two semantics. This is a net simplification opportunity for the v2 path, not just a
      port.
    - Implementation placement: prefer routing the version fork through a small version-agnostic internal descriptor (`{terminalId, phase: "start"|"delta"|"complete", command?, cwd?, data?,
    exitCode?, signal?}`) rendered to the right wire shape by a helper alongside
      `ACPSessionConnection.update()`, rather than duplicating the "what to emit when" decision inside both
      `CodexToolCallMapper.ts` and `CodexEventHandler.ts` for two wire formats.
    - The one concrete mechanical requirement: v1's hack carries raw UTF-8 text (`item.aggregatedOutput`/`event.delta`
      are plain strings); v2 requires base64 (`ACP-PATCH-207`) for `terminal_output_chunk.data`/
      `terminal_update.output.data` — a
      `Buffer.from(text,"utf8").toString("base64")` step at each emission point, no new state.
      `cwd` set-once-per-`terminalId` (`ACP-PATCH-206`, `cwd` MUST be absolute when present) is naturally satisfied
      since `item.cwd` is already fixed per command execution.
    - **No new internal state needs to be invented** — codex-acp already tracks everything (
      `terminalId`, `command`, `cwd`, each delta, final output+exit code) to build its v1 hack today; this is a
      wire-shape addition over already-available data.

- **Milestone (c) design — diff content restructuring.** v2's `Diff` drops `oldText`/`newText`
  entirely: `changes[]` carries only structural metadata (`operation:
  add|delete|modify|move|copy`, `path`, optional `oldPath`/`fileType`/`mimeType` — no content field at all), and content
  travels only via the optional sibling `patch: {format: "git_patch",
  text}` (a renderable, whole git-style patch; agents SHOULD provide it, clients MUST handle its absence).

  Fork lives at the same three functions in `CodexToolCallMapper.ts`
  (`createAddFileContent`/`createUpdateFileContent`/`createDeleteFileContent`, `:848-911`), adding v2-shaped siblings
  that reuse the same already-available inputs (`change.path`, `change.kind`,
  `change.diff`, and for `update` the already-parsed structured `patch`) rather than requiring new upstream data:
    - **`update`** (the easy case, and *less* work than v1): codex-acp already has real unified-diff text and a parsed
      patch. Emit `changes: [{operation: move_path ? "move" : "modify", ...(move_path
    ? {oldPath: change.path, path: move_path} : {path: change.path})}]` + `patch: {format:
    "git_patch", text: <the diff text>}` directly — **skip** the disk-read + apply/reverse-patch full-content
      reconstruction v1 needs (that logic must stay for v1's
      `oldText`/`newText` but is unused for v2's output). One implementation-time question to confirm (not a design
      blocker): whether `change.diff` already carries a `diff --git` header with absolute paths as `git_patch`
      requires — not directly confirmed in research (no fixture captures the raw pre-mapping string); if not, a bounded
      header rewrite is needed before use as
      `patch.text`.
    - **`add`/`delete`**: `change.diff` today is raw file content, not a diff (existing code comment confirms this) —
      the `changes[]` entry is trivial (`{operation: "add"|"delete", path:
    change.path, fileType: "text"}`), but `patch` requires either synthesizing a git-style add/delete patch from the raw
      content (new but simple, deterministic code — likely via the
      `diff` package's own patch-formatting helper) or invoking the spec's explicit
      "omit `patch` when there is no useful text patch" fallback, trading off a renderable diff view for new/deleted
      files vs. v1 (a product decision, not a research-resolvable one).
    - **Rename+edit conflation**: Codex's `PatchChangeKind` reports a rename with content changes as a single `update`
      -with-`move_path`; v2's `move`/`modify` are separate operations with no content-change flag on `move`. Recommended
      resolution: emit a single `{operation: "move",
    oldPath, path}` entry and carry the actual content diff in `patch.text` (git's own rename-with-changes convention
      already supports this in one `diff --git` section) — confirm against real client rendering during implementation.
    - `DiffStats.ts` (the `_meta.jetbrains.air.diffStats` annotation) and `AgentFileChangeReport.ts`
      (an unrelated, separate turn-level audit feature) need **no changes** — neither is part of the
      `changes[]`/`patch` restructuring.

- **Topic-wide verdict:** the same `ACPSessionConnection.update()` choke point serves all 3 milestones; no
  internal-state or architectural divergence between v1 and v2 exists anywhere in this topic — every change is a
  serialization-layer fork over data codex-acp already computes today. Overall risk: low-to-moderate, closer to the
  `initialize` topic's cost profile than to the prompt-lifecycle topic's structural-redesign profile.

## 7. MCP config & client execution surface removal (`v2-mcp-config-and-client-execution-surface-removal`)

Full detail: `.agents/research/v2-mcp-config-and-client-execution-surface-removal.md`.

- **Client fs/terminal (`clientCapabilities.fs`/`.terminal`, `fs/*`/`terminal/*` methods): no design needed.** Confirmed
  zero code paths in codex-acp read either capability marker or call any of the six removed client methods — Codex's
  app-server owns all sandboxed file/exec work, so codex-acp never depended on ACP's client-execution surface. This
  section of v2's removal requires no architectural change, no MCP-server replacement, and no new capability-gating
  logic.
- **MCP server config conversion (`src/CodexAcpClient.ts:createMcpSeverConfig`, `:903-922`):**
  replace the current `"type" in mcpServer"`-sniffing implementation (correct only for v1's untagged stdio shape) with
  one that explicitly branches on `mcpServer.type` including a
  `"stdio"` case (v2 always tags stdio), defaults `args`/`env`/`headers` to `[]` when absent (v2 makes them optional; v1
  required call sites can keep passing the required arrays unchanged), and treats `"type": "sse"` and any
  unrecognized/open-extension `type` string as an explicit rejection rather than falling through. Recommended shape:
  normalize both v1 and v2
  `McpServer` inputs into one small internal record (`{name, command?, args, env, url?, headers}`)
  at the call boundary, then keep a single Codex-app-server-config builder downstream — this keeps
  `createSessionConfig`/session-state/MCP-auth-recovery code (which only ever touches `.name` or the already-built
  config) completely unaware of which ACP version originated the request, so no forked state or divergent machinery is
  needed below the converter.
- **`initializeV2` (topic 1's handler)** should advertise `capabilities.session.mcp: {stdio: {},
  http: {}}` (v1's `mcpCapabilities` has no `stdio` marker since v1 treats stdio as implicit baseline; v2 requires it to
  be explicit) and drop or `_meta`-relocate the non-standard `acp:
  false` marker codex-acp currently emits in v1's `mcpCapabilities` (not part of either version's real transport set for
  codex-acp, which already rejects `"type": "acp"` at the converter).

## 8. Auth flow rename (`v2-auth-flow-rename`)

Full findings: `.agents/research/v2-auth-flow-rename.md`.

**Design: shared business logic, two thin method registrations — no adapter layer needed for the request/response
bodies.**

- On the `v2Agent` chain (built with `acpV2.agent(...)`, per the capability-negotiation topic), register
  `acpV2.methods.agent.auth.login` → `(ctx) => getAgent().authenticate(ctx.params,
  ctx.requestId)` and `acpV2.methods.agent.auth.logout` → `(ctx) => getAgent().logout(ctx.params)`. These call the
  **exact same** `CodexAcpServer.authenticate`/`.logout()` methods the v1 chain already uses — v1's
  `AuthenticateRequest`/`LogoutRequest` and v2's `LoginAuthRequest`/
  `LogoutAuthRequest` are structurally identical (`methodId` + optional `_meta`), so no per-version branch or
  field-mapping is needed inside `CodexAcpServer` at all. `ctx.requestId` is available identically in both SDK
  namespaces' handler contexts, so the existing
  `createUrlElicitationRequester(requestId)` path (used for `chat-gpt-device-code`) is reused unchanged.
- `src/CodexAuthMethod.ts` grows a v2-shaped sibling to `getCodexAuthMethods()` (or the existing function is refactored
  into a shared "which methods apply" decision plus two thin emitters) that produces
  `{methodId, type: "agent", name, description, _meta}` instead of `{id, name,
  description, _meta}`. This is the only place a genuine shape adapter is needed, and it is a pure
  field-rename-plus-one-literal, not new logic. The new `initializeV2` handler (capability- negotiation topic) calls
  this v2 emitter for its `authMethods` field.
- The two custom extension methods `authentication/status` / `authentication/logout` are registered identically on both
  `v1Agent` and `v2Agent` chains (same Zod parser, same
  `getAgent().extMethod(...)` dispatch) — they are raw custom method names, not part of the version-gated standard
  surface, so there is nothing to adapt.
- No change to `AuthStatusMeta.ts`'s `_auth/status_update` push extension, `src/login.ts` (CLI login, talks to the
  app-server directly, bypasses ACP entirely), or the internal
  `codexAcpClient.authenticate`/`.logout()`/`refreshAuthState(...)` machinery.
- Residual test-infra note: a future v2-native e2e harness will need `method.methodId` instead of today's v1-only
  `method.id` lookups in `src/__tests__/CodexACPAgent/e2e/acp-e2e-test-utils.ts`.

## 9. Config options, modes & plans (`v2-config-options-modes-and-plans`)

**Design: v1's mode/config state was already config-option-shaped — v2 needs a thin wire wrapper, not new internal
state.** Full detail:
`.agents/research/v2-config-options-modes-and-plans.md`.

- **Modes → config options (no restructuring):** `sessionState.agentMode`/`.collaborationMode`/
  `.fastModeEnabled` and the single dispatcher `applySessionConfigOption`/`applyModeChange`
  (`src/CodexAcpServer.ts:1374-1421`) are reused completely unchanged by v2. Add a thin
  `setSessionConfigOptionV2`-style registration on the `v2Agent` chain that calls the same
  `applySessionConfigOption`/`createSessionConfigOptions` v1 already uses (mirrors the auth-rename topic's "two thin
  registrations, one shared body" pattern). `AgentMode`/`CollaborationModeConfig`/
  `FastModeConfig`/`ModelConfigOption`'s builder functions need v2-typed sibling output (or a mapping shim) purely to
  rename the wire field `id`→`configId`; the values themselves are identical. `session/set_mode` and the `modes`
  response field are **not ported** to the v2 chain at all — v2 has no equivalent (confirmed: zero `SessionMode*` types
  in the v2 SDK) — while the v1 chain keeps both exactly as-is (`:1345-1357`, `:754`, `:834-838`, `:853-857`, `:2014`).
- **One deliberate v1/v2 behavioral fork (subtractive, not additive):** `FastModeConfig`'s
  `clientSupportsBooleanConfigOptions` probe/select-fallback (`src/FastModeConfig.ts:21-23`) exists only for legacy v1
  clients that predate boolean-typed config options. The v2 handler should call
  `createFastModeConfigOption(fastModeEnabled, /* useBooleanConfigOption */ true)`
  unconditionally — v2 clients always support `type: "boolean"` per baseline schema, so the probe and its select-based
  fallback are v1-only logic that the v2 path simply skips.
- **Plans — split by sub-feature, one already done:** the narrative "plan" thread-item path
  (`CodexAcpServer.createPlanHistoryUpdate`, `CodexEventHandler.createPlanUpdateEvent`) already emits
  `{sessionUpdate:"plan_update", plan:{type:"markdown", planId, content}}` today, gated on an existing extension
  capability probe (`PlanCapabilities.clientSupportsPlanUpdates`) — no change needed for v2 beyond eventually moving off
  the unstable `markdown` content type if/when the Plan Operations RFD supersedes it. The structured tool-driven plan
  path (`CodexEventHandler.updatePlan()`, `:1169-1179`) is the one real gap: it unconditionally emits the flat v1
  `{sessionUpdate:"plan", entries}` shape with no `planId` concept at all. Add a v2-chain variant that mints a stable
  `planId` (a per-session constant is sufficient today, since only one structured plan exists per turn) and wraps the
  same entry-mapping logic as
  `{sessionUpdate:"plan_update", plan:{type:"items", planId, entries}}`. The v1 chain keeps emitting the flat shape
  unchanged — same "shared inner logic, two thin envelope constructors" pattern used throughout this migration.
- **No transport/session-state changes needed:** `PlanCapabilities.ts` and `CodexCommands.ts`'s
  `setConfigOption` callback plumbing are already version-agnostic and require no edits.

## Cross-cutting concerns

### The pattern every topic converged on independently

Every one of the 9 topics, researched independently, arrived at the same shape: **one shared internal representation /
business-logic method, two thin per-version registrations or envelope constructors at the boundary.** Nowhere in this
migration does v1 vs. v2 support require actually divergent internal state or decision logic — not for capabilities, not
for sessions, not for tool calls, not even for auth or config. The dispatch mechanism that makes this possible is the
SDK's
`agentProtocolRouter().withV1(v1Agent).withV2(v2Agent).connect(stream)` (topic 1): it reads only the first wire
message's `protocolVersion` and hands the whole connection, untouched, to one version-native handler chain for its
lifetime — codex-acp never has to hand-write version sniffing, and a connection is never mid-flight ambiguous about
which version it's speaking. This is also the spec's own explicitly recommended approach for exactly codex-acp's
situation (`migration.mdx:770-772`, "Supporting v1 and v2 side by side").

The one deliberate exception to "share everything": capability *objects themselves* (`initialize`
response shapes) are NOT built from one shared function — v1's booleans and v2's nested objects are different enough by
design that forcing a shared builder would obscure more than it saves. Expect reviewable, intentional duplication there;
everywhere else, prefer sharing.

### The `ACPSessionConnection.update()` choke point

Topic 6 identified `src/ACPSessionConnection.ts:18-23` (`ACPSessionConnection.update()`) as the near-universal outbound
`session/update` send point, and designed its v1→v2 tool-call-upsert rename fork to live there rather than in
`CodexToolCallMapper.ts`/`CodexEventHandler.ts`
themselves. **This choke point should be the single place version-dependent notification shape decisions are made for
the whole migration, not just topic 6's slice of it:**

- Topic 2's `state_update` (`running`/`idle`/`requires_action`) notifications and topic 9's
  `plan_update` v2 envelope (`{type:"items", planId, entries}` vs. v1's flat `{sessionUpdate:
  "plan", entries}`) are both, structurally, the same kind of "same underlying event, different wire envelope per
  version" fork topic 6 already solved for tool calls. Route them through the same mechanism (or the same small
  version-aware rendering helper topic 6 recommended for terminal streaming: a version-agnostic internal descriptor
  rendered to the right wire shape)
  rather than re-deriving a parallel fork point in `CodexAcpServer.ts` for each.
- **Known gap to close before/during implementation, not after:** topic 6 found 5 call sites that currently bypass this
  choke point with inline v1-typed `connection.notify(...)` calls (`CodexElicitationHandler.ts:221,228,556`,
  `CodexAcpServer.ts:2538,3312`). These should be re-routed through `ACPSessionConnection` first — otherwise every
  future version-fork (not just topic 6's) needs 5 extra duplicate call sites instead of one.
- Practically, this means `ACPSessionConnection` needs to know (or be told) which protocol version its underlying
  connection was routed to by `agentProtocolRouter` — a small piece of plumbing not owned by any single topic above;
  treat it as a shared prerequisite of topic 1's dispatch-layer work, done once, rather than re-solved per topic.

### SDK dependency prerequisite

The installed `@agentclientprotocol/sdk@1.4.0`'s v2 `PromptResponse` generated type is missing
`messageId` entirely (topic 2's finding) — stale relative to both the current spec and the SDK's own `origin/main`. The
published `1.5.0` has this fixed. **Bump the dependency before starting implementation**, and re-run the type-diff
spot-checks each topic did against `origin/main` at the new pinned version as a sanity pass (every other topic found its
relevant v2 types byte-identical at `1.4.0`, so `messageId` looks like an isolated omission, not a sign of broader
staleness — but this should be confirmed once, not assumed twice).

### Bugs/gaps discovered along the way (independent of the v2 migration itself)

Several topics turned up pre-existing defects or gaps while reading the current v1 implementation for comparison. These
are worth fixing as their own small cleanup, whether or not the v2 work proceeds on any particular timeline — several
are load-bearing for v2 correctness, and one (`ACP-ENUM-203`) is a real v1 type-safety gap with no v2 dependency at all:

- **`CodexAcpClient.newSession()` (`CodexAcpClient.ts:672`)** passes `request.mcpServers` to
  `createSessionConfig` with no `?? []` fallback — the only one of the three session-creation call sites missing it.
  Harmless under v1 (where `mcpServers` is required-even-if-empty) but would throw/misbehave under v2
  (`ACP-SESSION-203`, where it's optional) if reused unchanged. (Topic 5.)
- **`createMcpSeverConfig` (`CodexAcpClient.ts:903-922`)** detects stdio via `"type" in mcpServer`
  (correct only for v1's untagged shape) and assumes `args`/`env`/`headers` are always-present arrays — both break on
  well-formed v2 input. Same file/area as the previous item; fix together. (Topic 7.)
- **`CodexEventHandler.updatePlan()`** unconditionally emits the flat v1 `{sessionUpdate: "plan",
  entries}` shape with no `planId` — needed as a v2-chain variant regardless (topic 9), but also worth noting the
  structured-plan and narrative-plan paths have drifted to different shapes (narrative plan already emits `plan_update`/
  `planId`; structured plan doesn't) independent of v2.
- **`ACP-ENUM-203` permission-outcome parsing** (`CodexApprovalHandler.ts` and friends) assumes
  `outcome.outcome !== "cancelled"` implies `.optionId` exists. v2's `RequestPermissionOutcome` is an open union, so
  this needs to become an explicit `outcome.outcome === "selected"` check — this is a genuine pre-existing type-safety
  gap worth hardening in the v1 code path too, not just v2's incoming requirement. (Topic 4.)
- **5 call sites bypassing `ACPSessionConnection.update()`** (listed above) — worth centralizing as its own small
  cleanup independent of any specific version-fork need, since every future notification-shape change (v1, v2, or a
  hypothetical v3) currently has to remember to touch all 6 places instead of 1. (Topic 6.)
- **`ContentChunks.ts`'s optional `messageId`** — ~12 call sites never pass one today. Minting one server-side (topic
  6's recommendation) is needed for v2 conformance, but also incidentally improves debuggability of today's v1 ad-hoc
  system notices, which currently have no stable identity at all.
- **Pre-existing `stopReason` fidelity gap** (topic 2): codex-acp's turn-completion mapping only ever produces
  `"end_turn"`/`"cancelled"`, never `"refusal"`/`"max_tokens"`/
  `"max_turn_requests"`. Not a blocker for v2 (v2 migration only needs to relocate this mapping from a response field to
  a `state_update` notification field, not fix its granularity), but worth tracking as a known limitation that carries
  forward unchanged.

### The one real net-new control-flow risk

Everything above nets out to "wire-shape forks over already-shared logic" — except topic 2's
`activePrompts`/`pendingTurnStarts`/`currentTurnId` bookkeeping, which genuinely needs new concurrency handling to
safely support v2's "queued work while running" case (today's code is single-flight-per-session, protected only by v1
clients blocking on the RPC response and steering's own deliberate serialization). This is the one place in the whole
migration where the recommended design — converging plain v2 `session/prompt` onto the same `SteeringQueue` primitive
`_session/steering` already uses — is a genuine piece of new engineering, not a port. Topics 3 (cancellation-signal
threading) and 4 (`requires_action` revisit if concurrent permission requests become possible) both have a noted
dependency on however this gets resolved.

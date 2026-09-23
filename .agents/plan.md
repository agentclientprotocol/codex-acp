# ACP v2 Migration — Effort Plan

> Research-only. Each section below is owned by one research subagent (see matching topic in
> `.agents/research/<topic-slug>.md` and `.agents/prompt.md`). Do not edit another section.

## 1. Capability negotiation & initialize (`v2-capability-negotiation-and-initialize`)

**Effort: small.** The SDK already supplies the hard part (version detection/dispatch via
`agentProtocolRouter().withV1(...).withV2(...)`, transparent JSON-RPC batching, and `_meta`
passthrough), so this topic is scoped to writing one new handler plus wiring, not a protocol implementation from
scratch.

- Add a v2-native `initializeV2` handler (parallel to, not replacing, the existing v1 `initialize`
  in `src/CodexAcpServer.ts:359-433`) that returns `protocolVersion`/`info`/`capabilities`
  (`session`, `auth`) per the v2 shape instead of v1's `agentInfo`/`agentCapabilities` with boolean markers — deliberate
  duplication with v1 expected here, not a shared builder, since the shapes are incompatible by design.
- Convert every boolean/legacy marker to the new object shape and reorg: drop `loadSession`, fold `promptCapabilities`/
  `mcpCapabilities`/`sessionCapabilities` under `capabilities.session`, drop the `list`/`resume`/`close` markers
  (advertising `capabilities.session` at all now implies the full 7-method baseline), and remove the `auth.logout`
  marker (logout availability is now implied purely by non-empty `authMethods`).
- Wire `src/index.ts`'s `startAcpServer()` to build two independent registration chains (existing v1 chain unchanged;
  new v2 chain via `@agentclientprotocol/sdk/experimental/v2`) sharing the same underlying `CodexAcpServer`/
  `CodexAcpClient` business logic, and connect both through
  `agentProtocolRouter()` instead of a single `.connect()` call — this is a thin dispatch-layer change, not a divergent
  handshake code path, since the SDK does the version sniffing.
- Update small helper signatures/types that read v1 `ClientCapabilities` today (`src/ElicitationCapabilities.ts`,
  `src/CodexAuthMethod.ts`'s `getCodexAuthMethods`,
  `src/subagents/AcpSubagents.ts`'s `SubagentAwareSessionCapabilities`) to get v2-typed counterparts for use from the
  new v2 handler path.
- No transport-layer work required for JSON-RPC batching or `_meta` extensibility — confirmed already handled
  transparently by the installed SDK for the stdio transport codex-acp uses; not a separate topic.

## 2. Prompt lifecycle & turn state machine (`v2-prompt-lifecycle-and-turn-state-machine`)

**Effort: medium-high — the single most structurally invasive topic in this migration, but less risky than initially
feared once a working precedent was found. All 3 milestones researched.**
Full detail: `.agents/research/v2-prompt-lifecycle-and-turn-state-machine.md`.

- **Milestone (a) — `session/prompt` response redesign.** Request shape is unchanged (`sessionId`,
  `prompt: ContentBlock[]`); the response drops `stopReason`/`usage` entirely and becomes a bare acceptance receipt:
  `{ messageId }`, sent as soon as the Agent has inserted the user message, without waiting for foreground work. Unlike
  the `initialize` topic, this is not a cheap parallel-construction/thin-serialization-layer change: codex-acp's v1
  `prompt()`
  (`src/CodexAcpServer.ts:2801`) currently `await`s the entire turn (sometimes two turns, via its plan-approval
  sub-flow) before returning, so the RPC's own promise lifetime IS today's turn-completion signal. Supporting v2
  requires decoupling "resolve the RPC" from "the turn is done." **Crucially, this decoupling is not unproven**:
  `startNewTurnFromExternalPrompt`
  (`CodexAcpServer.ts:1666-1721`, used by the steering extension, see milestone (c)) already calls
  `prompt()` and resolves its own early answer off an `onTurnStarted`-style callback while letting
  `prompt()`'s own promise settle in the background — the exact shape milestone (a) needs, already shipping. One
  concrete low-effort prerequisite: the installed `@agentclientprotocol/sdk@1.4.0`'s v2 `PromptResponse` type is stale
  (missing `messageId` entirely) — bump to the already-published
  `1.5.0`, which has it fixed.
- **Milestone (b) — `state_update` (`running`/`idle`/`requires_action`) mapping.** No new decision logic is needed
  anywhere: `running` fires from the same `onTurnStarted` hook milestone (a) uses;
  `idle`'s `stopReason` reuses the exact same two-value (`end_turn`/`cancelled`) mapping
  `CodexAcpServer.ts:3330-3356` already computes today (a **pre-existing** fidelity gap, not a v2 side effect: codex-acp
  never distinguishes `refusal`/`max_tokens`/`max_turn_requests` today either); `requires_action` needs two notification
  sends (before/after) bracketing four existing
  `session/request_permission` call sites (`CodexApprovalHandler.ts:51,70,87`,
  `CodexAcpServer.ts:3306`) — no new state-tracking data structure. Cancellation confirmation is simply the idle
  `state_update` carrying `stopReason: "cancelled"`; there is no separate ack (this is what the
  `v2-cancellation-semantics` topic needs from here — don't re-derive it there). SDK check: the installed `1.4.0`'s
  `state_update`/`StateUpdate`/`Idle`/`Running`/`RequiresAction`
  types are byte-identical to `origin/main` — **no SDK gap here**, unlike milestone (a)'s
  `messageId` bug.
- **Milestone (c) — interaction with codex-acp's existing steering/queued-prompt logic.** Located:
  `src/AcpExtensions.ts:43` (`SESSION_STEERING_METHOD = "_session/steering"`),
  `src/SteeringQueue.ts` (per-session single-consumer serializing queue), and
  `CodexAcpServer.ts:1523-1721` (`executeOrQueueSteeringRequest` → `performSteeringRequest` →
  inject-into-live-turn-or-start-new-turn). The spec explicitly permits clients to send a new
  `session/prompt` while `running`, without waiting for `idle` (`migration.mdx:321` names "queued work" as a first-class
  case v2 is designed for) — but `trackActivePrompt`
  (`CodexAcpServer.ts:2574-2626`) unconditionally overwrites per-session `activePrompts` state with **no protection
  against two concurrent `prompt()` calls for one session**; today this race is never exercised because v1 clients wait
  for the blocking response and codex-acp's own steering code deliberately `await`s the previous prompt's completion
  before starting another (`:1674-1675`). v2 is the first case inviting exactly this unguarded scenario through the
  *standard* verb. **Recommended design:** don't give v2 `session/prompt` a naive standalone
  "always start a new turn" path — route it through the same turn-liveness check (`getSteerableTurnId`) and queueing
  primitive (`SteeringQueue`) the steering extension already uses, converging plain v2 `session/prompt` and
  `_session/steering` onto one shared "insert new foreground work, running-or-not" primitive. `_session/steering` itself
  stays registered unchanged on both v1 and v2 chains (its richer `injected`/`startedNewTurn`/`failed` outcome enum
  remains useful). A lower-effort fallback exists (reject overlapping v2 prompts outright) but undercuts the spec's
  stated motivation for the redesign.
- **Overall risk verdict:** the wire-shape changes and `state_update` mapping are cheap (no new decision logic, no SDK
  gaps beyond the already-flagged `messageId` bump). The RPC-resolution/turn-lifetime decoupling milestone (a) needs has
  a working precedent already in the codebase, lowering it from "unproven redesign" to "generalize an existing pattern
  to a second call site." The one real remaining structural risk is generalizing the single-flight
  `activePrompts`/`pendingTurnStarts`/`currentTurnId` bookkeeping to safely support concurrent prompt-shaped operations
  per session (needed for milestone (c)'s recommended design) — this, not the response/notification shapes, is where the
  effort and risk actually concentrate.

## 3. Cancellation semantics (`v2-cancellation-semantics`)

**Effort: tiny — this topic is a strict subset of the prompt-lifecycle topic's own risk, not an independent one.** Full
detail: `.agents/research/v2-cancellation-semantics.md`.

- `session/cancel` itself is unchanged v1→v2 in every observable way: same method name, same notification-not-request
  nature (no response ever sent, confirmed by `ACP-CANCEL-205`), and byte-identical `{sessionId, _meta?}` params
  (`schema/v1/schema.json:5808-5828` vs.
  `schema/v2/schema.json:9841-9861` — the schema-codegen type name changes from
  `CancelNotification` to `CancelSessionNotification`, the wire format does not,
  `migration.mdx:710`). codex-acp's existing handler (`CodexAcpServer.ts:3413-3422`, registered as
  `.onNotification` at `src/index.ts:165`) needs **zero change**; only a second registration on the v2 chain delegating
  to the same method.
- Only the confirmation mechanism moved: v1 answers the still-pending `session/prompt` with
  `{stopReason: "cancelled"}`; v2 sends an idle `state_update{stopReason:"cancelled"}` notification instead — and this
  exact fork point (where `end_turn`/`cancelled` gets attached to a
  `session/update` instead of a response) was **already fully designed by the prompt-lifecycle topic's milestone (b)**;
  this topic doesn't need to invent a new mechanism, just route the
  `cancelled` branch of that same already-shared two-value decision through it.
- All the actual abort machinery (`interruptSessionTurn`, `requestTurnInterrupt`,
  `observePromptRequestCancellation`, the retry-on-race loop for a cancel arriving before the turn is registered
  app-server-side) is 100% version-agnostic internal bookkeeping — no forking needed.
- **Pending-permission-request cancellation is already implemented today, as a side effect of generic SDK wiring, not
  bespoke code**: `CodexApprovalHandler`/`CodexElicitationHandler` are constructed with `activePrompt.signal` as a
  `cancellationSignal`
  (`CodexAcpServer.ts:2870-2880`), and the SDK's `connection.request(..., {cancellationSignal})`
  (`acp-typescript-sdk/src/jsonrpc.ts:1120-1136`) automatically sends `$/cancel_request` for that pending outbound
  request when the signal aborts — exactly the cascade
  `docs/protocol/v2/cancellation.mdx`'s (non-normative, `ACP-INFO-CANCEL-202`) diagram illustrates. This mechanism is
  identical in v1 and v2 (the general `$/cancel_request` notification is unchanged between the two `cancellation.mdx`
  docs, diffed word-for-word) and needs no new code — only the same abort signal must be threaded from whichever object
  the v2 turn-execution path uses.
- `session/close`'s existing blocking-await-then-respond shape (`CodexAcpServer.ts:899-919`, already `await`s
  `interruptSessionTurn` before returning `{}`) already satisfies
  `ACP-CANCEL-208`/`ACP-CLOSE-202`'s "close cancels in-flight work the same way `session/cancel`
  does" requirement structurally — no restructuring needed, since the `{}` response and the idle
  `state_update` are independent channels.
- **No blockers, no SDK type-generation gap** (unlike `PromptResponse.messageId`,
  `CancelSessionNotification` is byte-identical across the installed `1.4.0`, local checkout, and
  `origin/main`). Residual implementation work is registration + wiring the v2 abort signal into already-existing
  constructors — not new decision logic.

## 4. Permission requests & approvals (`v2-permission-requests-and-approvals`)

**Effort: small — one of the migration's cheaper topics, comparable to `initialize`'s thin-parallel-construction cost,
not `prompt()`'s turn-lifetime-decoupling cost.** Full detail:
`.agents/research/v2-permission-requests-and-approvals.md`.

- `session/request_permission`'s bare v1 `toolCall` becomes v2's `{title (required),
  description?, subject?, options}`, where `subject` is `{type: "tool_call", toolCall:
  ToolCallUpdate}` or `{type: "command", command, cwd, toolCallId?, terminalId?}` or custom/omitted — **no `plan_review`
  subject exists in stable v2** (schema only defines
  `tool_call`/`command`).
- All 4 named call sites (`CodexApprovalHandler.ts:51,70,87`'s shared `requestPermission` helper;
  `CodexAcpServer.ts:3306` `requestPlanImplementationPermission`) currently stuff prompt copy into
  `toolCall.title` — exactly the anti-pattern `migration.mdx:512` calls out fixing in v2 (`title`
  moves to a new top-level, required field; `subject.toolCall.title` should carry only genuine tool-call state). A 5th,
  not-formally-scoped MCP-elicitation call site (`src/permissions/mcp.ts`, called from an unlocated dispatcher) has the
  same issue and should get matching treatment as a follow-up.
- The actual decision-making/option logic (`options.ts`, `option-ids.ts`,
  `command-decision-contract.ts`) and response parsing (`selectedDecision`, `permissionsResponse`,
  `planImplementationApproved`, `convertMcpPermissionResponse`) is **fully version-agnostic** — zero changes needed;
  only the request- *construction* functions in `presentation.ts`/
  `plan-review.ts`/`mcp.ts` need a v2-shaped sibling/branch that emits `title`/`subject` instead of a bare `toolCall`.
  Plan-review's missing subject type is the one real judgment call — recommend keeping the existing
  `subject.tool_call` + `kind: "switch_mode"` misuse pattern (spec-legal), just relocating `title` out of the nested
  toolCall, rather than inventing a custom
  `_`-prefixed subject extension.
- `requires_action` bracketing (shared finding with the prompt-lifecycle topic's milestone (b)):
  wrap `CodexApprovalHandler.ts`'s shared `requestPermission` helper (covers 3 of 4 sites) plus
  `CodexAcpServer.ts:3306` individually with `state_update: requires_action` immediately before /
  `state_update: running` immediately after the request settles (grant, deny, cancel, or error all count as "resumed").
  No in-flight counter needed against today's call graph — the current architecture never has two concurrent
  `session/request_permission` calls for one session; revisit only if milestone (c)'s steering/queueing convergence
  changes that later.
- A real, pre-existing type-safety issue surfaced independent of v2 (`ACP-ENUM-203`): permission response parsing today
  assumes `outcome.outcome !== "cancelled"` implies `.optionId` exists, but v2's `RequestPermissionOutcome` is an open
  union — harden to an explicit `outcome === "selected"`
  check; worth fixing for both versions, not just v2.
- No SDK version bump needed for this topic's types specifically — installed
  `@agentclientprotocol/sdk@1.4.0`'s `RequestPermissionRequest`/`Subject`/`Response` types already match current spec
  (confirmed against `origin/main`).

## 5. Session lifecycle: new/resume/list/close/delete (`v2-session-lifecycle-new-resume-list-close-delete`)

**Effort: small-to-medium.** v1's `session/load` and v1's `session/resume` already call the exact same underlying
app-server RPC (`resumeThread({excludeTurns: true, ...})`); `loadSession` is purely additive (fetch turns, stream
history) on top of what `resumeSession` already does. v2 collapsing both into one `session/resume` + `replayFrom` is a
dispatch decision, not new replay logic to build — full detail in
`.agents/research/v2-session-lifecycle-new-resume-list-close-delete.md`.

- Register one v2 `session/resume` handler that branches on `replayFrom`: absent/`null` calls the same code v1's
  `resumeSession` calls (`getOrCreateSession`/`tryCreateSession(..., "resume")`);
  `{"type":"start"}` calls the same code v1's `loadSession` calls (`getOrCreateSessionWithHistory` +
  `streamThreadHistory`, `CodexAcpServer.ts:807-839,1910-2057`). No history-storage restructuring needed —
  `ResponseItemHistoryFallback.ts`'s file-based reconstruction and the native `Thread.turns[].items[]` path already
  produce the same
  `UpdateSessionEvent[]` shape `session/update` notifications need; only the wire serialization differs (that's the
  tool-calls/messages topic's concern).
- `session/close` and `session/delete` need no logic change at all — identical v1/v2 shapes; the v2 handlers can call
  `CodexAcpServer.closeSession`/`deleteSession` unchanged.
- `session/list` needs no logic change — v1's `SessionInfo` shape is already a subset of v2's (`additionalDirectories`
  is the only addition, and it's already patched in from live
  `SessionState` at `CodexAcpServer.ts:886-894`).
- `session/new` needs one concrete small fix plus a response-shape reduction: apply an `?? []`
  fallback to `mcpServers` in `CodexAcpClient.newSession()` (`CodexAcpClient.ts:672`, the one call site that lacks it,
  unlike `resumeSession`/`loadSession`) so v2's now-optional `mcpServers` field doesn't reach `createSessionConfig` as
  `undefined` (`ACP-SESSION-203`); and build
  `NewSessionResponse`/`ResumeSessionResponse` with only `{sessionId?, configOptions}`, dropping
  `models`/`modes`.
- **Cross-topic dependency, not extra work here:** the `models`/`modes` → `configOptions` mapping needed for that last
  point is topic 9's (`v2-config-options-modes-and-plans`) deliverable — this topic's v2 response builders need it to
  exist, but don't implement it.
- Verify messageId is always present on replayed `user_message`/`agent_message`/`agent_thought`
  updates (v1 schema made it optional; v2 requires it) — expected to already hold in practice since
  `createHistoryUpdates`/history-fallback already assign one from Codex's item ids, but worth an explicit
  check/assertion at the v2 boundary for `ACP-RESUME-204` compliance.

## 6. Tool calls, messages & terminal streaming (`v2-tool-calls-messages-and-terminal-streaming`)

**All 3 milestones researched.** Full detail:
`.agents/research/v2-tool-calls-messages-and-terminal-streaming.md`.

- **Milestone (a) — message/tool-call upsert semantics: low-to-moderate effort, low risk.** v1's separate `tool_call`
  (create) + `tool_call_update` (patch) collapse into one v2
  `tool_call_update` upsert (first update for an unseen `toolCallId` is itself the create; the TCK (`ACP-PATCH-204`)
  explicitly asserts no create-before-update ordering exists to preserve). This is a clean serialization-layer-only
  change, not a restructuring: every "create vs. update"
  decision in `src/CodexToolCallMapper.ts`'s ~10 paired create/update function sets is already driven by the shape of
  the upstream Codex app-server event, not by codex-acp-maintained bookkeeping (one narrow exception, a pre-existing
  `activeGuardianApprovalReviews` Set, needs no change). The fork can live entirely at the single (-ish)
  `ACPSessionConnection.update()` choke point (`src/ACPSessionConnection.ts:18-23`): re-tag `tool_call`→
  `tool_call_update` before sending on a v2 connection, no field remapping needed (the one required-ness change, v1's
  mandatory
  `title` on create becoming optional-but-SHOULD in v2, is a pure relaxation — codex-acp already always sets `title` on
  first emission). **Bounded gap found, not free**: that choke point isn't fully exhaustive — 5 call sites
  (`CodexElicitationHandler.ts:221,228,556`,
  `CodexAcpServer.ts:2538,3312`) bypass it with inline v1-typed `connection.notify(...)` calls and should be routed
  through it for the fork to stay centralized. **Second bounded gap**: `messageId`
  is required on every v2 message chunk/update (`ACP-PATCH-201`), but
  `src/ContentChunks.ts:13-59`'s three chunk-builder functions treat it as optional and ~12 call sites across
  `CodexEventHandler.ts`/`CodexCommands.ts`/`ResponseItemHistoryFallback.ts` pass none today (ad-hoc system notices with
  no natural item id) — cheapest fix is minting a fresh id inside
  `ContentChunks.ts` itself for the v2 path rather than touching every call site, except
  `ResponseItemHistoryFallback.ts:242` needs a *deterministic* id for replay-consistency (coordinate with topic 5's
  `ACP-RESUME-204/205`). No SDK type gap found (diffed installed
  `1.4.0`'s tool-call/message types against `acp-typescript-sdk` origin/main — only cosmetic differences).
- **Milestone (b) — agent-owned terminal streaming (`terminal_update`/`terminal_output_chunk`):
  low-to-moderate effort, low risk.** Correcting the milestone- (a) handoff's assumption:
  `src/async-tasks/CodexBackgroundTerminalTasks.ts` is a **false lead** — it's a proprietary, ACP-schema-external "AIR
  background task" bookkeeping extension (`async_task_spawned`/
  `async_task_state_update`) that never streams terminal output at all; it needs no terminal-streaming-specific work
  beyond milestone (a)'s generic tool-call fork. The real surface is spread across `src/TerminalOutputMode.ts`,
  `src/CodexToolCallMapper.ts`
  (`createTerminalCommandEvent`, `createCommandExecutionCompleteUpdate`), and
  `src/CodexEventHandler.ts` (`createCommandOutputDeltaEvent`, `completeCommandExecutionEvent`), which today smuggle
  live command output through **private, non-standard `_meta` keys**
  (`terminal_output`/`terminal_output_delta`/`terminal_exit`/`terminal_info`) on ordinary
  `tool_call_update`s, negotiated via a custom `clientCapabilities._meta` boolean — because v1 core ACP gave codex-acp
  no standardized replace-vs-append contract for agent-streamed output (it never calls the real client-executed
  `terminal/create`, confirmed by the sibling MCP/client-execution topic). v2's `terminal_update` (upsert: `command`,
  `cwd` MUST be absolute, `output` as an authoritative replacement snapshot, `exitStatus`) and `terminal_output_chunk`
  (always-append live bytes) are two independently-always-valid channels that formalize exactly what the v1 hack was
  already informally doing — **v2 is simpler than the current v1 code, not harder**: the client-capability-negotiated
  mode-selection logic in `TerminalOutputMode.ts` becomes unnecessary for the v2 path entirely (always send both
  channels; no mode to pick). codex-acp already tracks every input v2 needs (`terminalId`=`item.id`, `command`, `cwd`,
  each output delta, final aggregated output + exit code) since it already computes all of this for the v1 hack. The one
  concrete new mechanical step: v1's hack carries raw UTF-8 text, v2 **requires** base64 (`ACP-PATCH-207`) for
  `terminal_output_chunk.data`/`terminal_update.output.data` — a
  `Buffer.from(text,"utf8").toString("base64")` conversion at each emission point, no new state.
  `cwd` set-once-per-`terminalId` (`ACP-PATCH-206`) is naturally satisfied (`item.cwd` is already fixed per command
  execution). The `{type:"terminal", terminalId}` tool-call content-block reference itself is byte-identical in shape
  between v1 and v2 — no change needed there.
- **Milestone (c) — diff content restructuring (`oldText`/`newText` → `changes[]`+`patch`): low risk for the `update`
  case, low-to-moderate for `add`/`delete`.** v2's `Diff` type (`docs/protocol/v2/tool-calls.mdx:478-560`) drops
  `oldText`/`newText` entirely — `changes[]`
  carries only structural metadata (`operation: add|delete|modify|move|copy`, `path`, optional
  `oldPath`/`fileType`/`mimeType`, **no content field at all**), and content only ever travels via the sibling optional
  `patch: {format: "git_patch", text}` (a whole renderable git-style patch, which agents SHOULD but need not provide —
  clients MUST handle its absence). For
  `createUpdateFileContent`/`createUpdateDiffContent` (`CodexToolCallMapper.ts:858-901`), this is **less work than v1's
  current path**: codex-acp already has real unified-diff text and an already-parsed structured patch for this case, so
  v2's output needs no reconstruction of full file content at all (unlike v1, which reads the file from disk and
  applies/reverses the patch just to build `oldText`/`newText` — that reconstruction logic must stay for v1 but is
  unused by v2). One open question flagged for implementation (not blocking): whether `change.diff`'s text already
  carries a `diff --git` header with absolute paths (spec-required for `git_patch`) — not confirmed directly in this
  research pass, though a sibling Codex diff-rendering path (`AgentFileChangeReport.ts`, a different, turn-level
  feature) does use that convention, which is suggestive but not proof for this per-file API. For
  `createAddFileContent`/`createDeleteFileContent`
  (`:848-856`,`:903-911`), `change.diff` today is actually **raw file content, not a diff at all**
  (per the existing code comment) — the `changes[]` entry is trivial, but producing a `patch` means either synthesizing
  a git-style add/delete patch from scratch (new, simple, deterministic code)
  or invoking the spec's explicit "omit `patch` when there is no useful text patch" fallback (a real UX trade-off vs.
  v1, not resolvable by research alone). A narrow, non-blocking design question remains for Codex's "rename + edit" case
  (`update` with `move_path`, which conflates what v2 models as two logically separate concepts, `move` vs. `modify`) —
  recommended resolution:
  one `move` entry carrying the real content diff in `patch.text` (git's own convention already supports this), to
  confirm during implementation. No dedicated `ACP-DIFF-*` TCK rows exist;
  `DiffStats.ts`/`AgentFileChangeReport.ts` need no changes at all (unrelated to this restructuring).
- **Topic-wide verdict: the same `ACPSessionConnection.update()` choke point serves all 3 milestones; no internal-state
  or architectural divergence between v1 and v2 was found anywhere in this topic — every change across (a)/ (b)/ (c) is
  a serialization-layer fork over data codex-acp already computes today for its v1 wire path.** Overall topic risk:
  low-to-moderate, closer to the `initialize`/capability-negotiation topic's cost profile than to the prompt-lifecycle
  topic's structural-redesign profile.

## 7. MCP config & client execution surface removal (`v2-mcp-config-and-client-execution-surface-removal`)

**Effort: small.** Two independent sub-findings, both cheap:

- **Client fs/terminal removal is a non-event.** Exhaustive grep confirms codex-acp never reads
  `clientCapabilities.fs`/`.terminal` and never calls any `fs/*`/`terminal/*` client method — Codex's app-server already
  does its own sandboxed file/exec work. Nothing to migrate, no MCP-based replacement to build, `ACP-CLIENTCAP-202`
  satisfied by omission. Zero effort.
- **MCP config shape converter needs a small, mechanical fix**, not a redesign. The single conversion point,
  `createMcpSeverConfig` (`src/CodexAcpClient.ts:903-922`), hardcodes two v1-only assumptions that break at runtime (not
  just typecheck) against well-formed v2 input: (1) it detects stdio via `"type" in mcpServer` (v1 stdio is untagged; v2
  stdio carries `"type":
  "stdio"` explicitly, so this needs an explicit case rather than accidental switch-fallthrough), and (2) it assumes
  `args`/`env`/`headers` are always-present arrays (v2 makes them optional per
  `migration.mdx:646`, so `mcpServer.env.map(...)` etc. will throw on a spec-legal v2 request that omits them). Fix is
  local to that one function/converter — add explicit `"stdio"` handling and
  `?? []` defaulting, or normalize both shapes into one internal representation before a shared builder. Everything
  downstream (`getRequestedMcpServerNames`, `resolveSessionMcpServers`, session state, MCP auth recovery) already
  operates on `.name` or the already-built Codex config, never on the raw union shape, so no state divergence or forked
  machinery is needed beyond this converter.
- Also drop `"type": "sse"` support expectation on the v2 path (removed from the v2 schema entirely) and add `stdio: {}`
  to `capabilities.session.mcp` in the new `initializeV2` handler (topic 1's scope — v1's `mcpCapabilities` has no
  `stdio` marker since it was implicit baseline there; v2 makes it explicit/opt-out-able).

## 8. Auth flow rename (`v2-auth-flow-rename`)

**Effort: tiny — a couple of hours, no design risk.** Full findings:
`.agents/research/v2-auth-flow-rename.md`.

Confirmed mechanical, not divergent: v1's `AuthenticateRequest`/`LogoutRequest` params are already
`methodId`-keyed and structurally identical to v2's `LoginAuthRequest`/`LogoutAuthRequest` — the spec states the params
are unchanged, and codex-acp's own `CodexAuthRequest` types already use
`methodId`. `CodexAcpServer.authenticate`/`.logout()` need **zero** signature/body changes; `ctx.requestId`
(needed for the `chat-gpt-device-code` URL-elicitation flow) is exposed identically on the v2
`AgentContext`.

Work items:

1. Register `acpV2.methods.agent.auth.login` / `.logout` on the new `v2Agent` chain (`src/index.ts`), delegating to the
   same `authenticate`/`logout` methods on `CodexAcpServer`.
2. Add a `methodId`/`type: "agent"`-shaped variant of the four `AuthMethod` literals in
   `src/CodexAuthMethod.ts` (today keyed by `id:`, no `type:`) — reuse the same selection logic (`getCodexAuthMethods`),
   just emit the v2 descriptor shape. Required to satisfy
   `ACP-AUTH-206` (type must be `"agent"`/`"terminal"`/`_`-prefixed, never absent).
3. Duplicate the two custom `authentication/status` / `authentication/logout` extension-method registrations onto the v2
   chain (unrelated to the standard rename, same handler/parser).
4. No terminal auth method exists today, so `ACP-AUTH-202`/`ACP-AUTH-207` (terminal gating,
   `args`/`env` validation) are vacuously satisfied — no action needed unless terminal auth is added later.
5. `AuthStatusMeta.ts`'s `_auth/status_update` push extension needs no change — orthogonal to the method rename.

No hidden complication from codex-acp's custom auth extensions; they dispatch on raw method strings, unaffected by
version routing.

## 9. Config options, modes & plans (`v2-config-options-modes-and-plans`)

**Effort: small.** codex-acp's internal state was already config-option-shaped before v2 existed —
`AgentMode`/`CollaborationModeConfig`/`FastModeConfig` all already build `SessionConfigOption`
objects, and two of the three (`CollaborationModeConfig`, `FastModeConfig`) have no v1
`SessionMode` representation at all. The single `applySessionConfigOption`/`applyModeChange`
dispatcher (`src/CodexAcpServer.ts:1374-1421`) is already shared between the v1 `session/set_mode`
handler and `session/set_config_option`, and agent-initiated changes already go out exclusively as
`config_option_update` (the v2 notification shape) — `current_mode_update` is never emitted today.

- Add a thin v2-typed `session/set_config_option` wrapper reusing `applySessionConfigOption`/
  `createSessionConfigOptions` unchanged; add small v2-typed builder variants (or a mapping shim)
  for `AgentMode`/`CollaborationModeConfig`/`FastModeConfig`/`ModelConfigOption` to rename the wire field `id`→
  `configId` (values unchanged).
- Drop `session/set_mode` and the `modes` response field from the v2 registration chain only — v2 has no equivalent at
  all (confirmed 0 hits for `SessionMode` in the v2 SDK types); the v1 chain keeps both unchanged.
- One small subtractive fork: `FastModeConfig`'s boolean-support capability probe/select-fallback (needed only for
  legacy v1 clients predating boolean config options) can be skipped on the v2 path, since v2 clients always support
  `type: "boolean"` by baseline schema.
- Plans: the narrative "plan" thread-item path is **already** v2-shaped (`plan_update`/`planId`, gated on an existing
  extension capability probe) and needs no new work. The structured tool-driven plan path
  (`CodexEventHandler.updatePlan()`) is the one real gap — it unconditionally emits the flat v1
  `{sessionUpdate:"plan", entries}` shape today and needs a new v2-chain variant that mints a stable `planId` (none
  exists yet for this feature) and wraps entries as
  `{sessionUpdate:"plan_update", plan:{type:"items", planId, entries}}`. Entry-mapping logic is reused verbatim; only
  the outer envelope differs.
- No blockers. Full detail: `.agents/research/v2-config-options-modes-and-plans.md`.

## Overall effort roll-up

| # | Topic                                            | Size                                                  | Depends on | Why                                                                                                                                                                                                                                                                                                       |
|---|--------------------------------------------------|-------------------------------------------------------|------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 1 | Capability negotiation & `initialize`            | **Small**                                             | —          | Foundational: `agentProtocolRouter` wiring + one new `initializeV2` handler. Everything else builds on this.                                                                                                                                                                                              |
| 2 | Prompt lifecycle & turn state machine            | **Medium-High**                                       | 1          | The one genuine control-flow redesign (decouple RPC resolution from turn completion). Has a working precedent (`startNewTurnFromExternalPrompt`), which downgrades it from "unproven" to "generalize an existing pattern" — but the `activePrompts` concurrency generalization is real, non-trivial work. |
| 3 | Cancellation semantics                           | **Tiny**                                              | 2          | Strict subset of #2's risk — reuses its idle/`state_update` fork point; zero new decision logic.                                                                                                                                                                                                          |
| 4 | Permission requests & approvals                  | **Small**                                             | 2          | Request-construction fork (bare `toolCall` → `title`/`subject`) + `requires_action` bracketing around 4 call sites, both using #2's mechanism. Decision/response-parsing logic is fully shared, unchanged.                                                                                                |
| 5 | Session lifecycle (new/resume/list/close/delete) | **Small-Medium**                                      | 1, 9       | `session/resume`+`replayFrom` collapses onto v1's existing `resumeSession`/`loadSession` split — no new replay logic. Needs #9's `configOptions` mapping for response bodies.                                                                                                                             |
| 6 | Tool calls, messages & terminal streaming        | **Small-Medium** (3 milestones, each low-to-moderate) | 1          | Every milestone is a serialization-layer fork over data codex-acp already computes; centralizes at one choke point (`ACPSessionConnection.update()`). Closer to topic 1's cost profile than topic 2's.                                                                                                    |
| 7 | MCP config & client execution removal            | **Small**                                             | 1          | Client fs/terminal removal is a non-event (never used). One converter function needs a mechanical fix.                                                                                                                                                                                                    |
| 8 | Auth flow rename                                 | **Tiny**                                              | 1          | Purely mechanical — v1 and v2 param shapes are already structurally identical; only the `AuthMethod` descriptor needs a field rename.                                                                                                                                                                     |
| 9 | Config options, modes & plans                    | **Small**                                             | 1          | codex-acp's internal state was already config-option-shaped pre-v2. One real gap: `planId` missing from the structured tool-driven plan path.                                                                                                                                                             |

**Total shape:** one medium-high-effort core (#2) surrounded by seven small-to-tiny topics that are all thin wrappers
over already-shared business logic, plus one small-medium topic (#6) that's mostly mechanical breadth (many call sites)
rather than depth. There is no topic anywhere in this migration that requires diverging v1's and v2's *internal* state
or business logic — every topic independently converged on "fork only at the wire-serialization/registration boundary."
This is the direct payoff of preserving v1 via the SDK's router rather than attempting a cutover.

**Highest-risk area:** topic 2's `activePrompts`/`pendingTurnStarts`/`currentTurnId` bookkeeping needing to safely
support concurrent prompt-shaped operations per session (today's code assumes single-flight, protected only by v1
clients' blocking behavior and steering's own explicit serialization). This is the one piece of net-new control-flow
logic in the whole migration, and topics 3 and 4 both build directly on its output.

**Sequencing recommendation:**

1. **Prerequisite:** bump `@agentclientprotocol/sdk` from the installed `1.4.0` to `1.5.0`+ (fixes the
   `PromptResponse.messageId` gap topic 2 found; re-diff other v2 types against `origin/main` at that version as a
   sanity check before starting).
2. **Phase 1 (foundational):** topic 1 — `agentProtocolRouter`, `initializeV2`, the dual-chain skeleton in
   `src/index.ts`. Nothing else can be wired end-to-end without this.
3. **Phase 2 (parallelizable once phase 1 lands):** topics 5, 7, 8, 9 (all small/tiny, low mutual coupling) alongside
   starting topic 2 (the long pole — start it early since its concurrency work will take the longest and everything in
   phase 3 depends on its `state_update` mechanism). Sequence 9 before finishing 5's response-shape work (5 needs 9's
   `configOptions` mapping).
4. **Phase 3 (depends on topic 2's `state_update` fork existing):** topics 3, 4 (cheap once the fork point exists), and
   topic 6 (depends mainly on topic 1's choke point, only loosely on 2 — could move to phase 2 if resourcing allows).
5. **Phase 4:** integration/regression testing — run the ACP TCK against both v1 and v2 connections from the same
   running process (not just each version in isolation) to catch any state bleed between concurrently-open v1 and v2
   sessions, and confirm the "shared business logic" assumption holds under real dual-version load.

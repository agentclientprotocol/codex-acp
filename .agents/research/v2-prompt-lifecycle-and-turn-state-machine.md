# v2 topic: Prompt lifecycle & turn state machine

**STATUS: all 3 milestones complete.** (a) `session/prompt` response redesign, (b) `state_update`
(`running`/`idle`/`requires_action`) mapping, and (c) steering/queued-prompt interaction are all
researched. See §6 (milestone b), §7 (milestone c), and §8 (final dual-version verdict for the
whole topic) below, appended by the follow-up subagent. §§1-5 and the original "Handoff" section
are preserved unchanged from the milestone-(a) run as historical record; §6/§7/§8 supersede the
handoff section's open questions.

Spec checked at `agent-client-protocol` local checkout, commit `8c90bb7` ("docs: update registry
agents (#2217)"), working tree clean — same commit the capability-negotiation topic checked.
TCK checked at `/Users/eugene/Documents/JetBrains/projects/acp-tck/src/tck/v2/requirements.py`.
SDK checked both as installed (`node_modules/@agentclientprotocol/sdk@1.4.0`) and against
`acp-typescript-sdk` `origin/main`, plus a fresh `npm pack` of the currently-published
`@agentclientprotocol/sdk@1.5.0` (see §3 — this matters, there's a real version gap).

## 1. The shape change: exact old vs new

### Request — **unchanged**

`docs/protocol/v2/migration.mdx:47`: "`session/prompt` | Unchanged shape. **Response semantics
redesigned**". Confirmed at the schema level (`docs/protocol/v2/schema.mdx:509-547`,
`PromptRequest`): `{ sessionId: SessionId (required), prompt: ContentBlock[] (required), _meta?:
object|null }` — identical field set/names to v1's `PromptRequest`. codex-acp's inbound handler
does not need to change its request-parsing surface between v1 and v2.

### Response — **redesigned**

v1 (`node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts:2970-2974`):
```ts
export type PromptResponse = {
  stopReason: StopReason;   // required — the response IS turn completion
  usage?: ...;              // UNSTABLE, codex-acp populates this today
  _meta?: {...} | null;
};
```
```json
{ "jsonrpc": "2.0", "id": 2, "result": { "stopReason": "end_turn" } }
```

v2 (`docs/protocol/v2/schema.mdx:549-580`, `docs/protocol/v2/migration.mdx:254`,
`docs/protocol/v2/prompt-lifecycle.mdx:141-156`):
```json
{ "jsonrpc": "2.0", "id": 2, "result": { "messageId": "msg_user_8f7a1" } }
```
`PromptResponse` becomes `{ messageId: MessageId (required, non-null string), _meta?: object|null
}` — **no `stopReason`, no `usage` field at all.** `messageId` identifies the *inserted user
message*, not the turn. "Acceptance means insertion, not receipt, queueing, or processing
completion" (`prompt-lifecycle.mdx:139`). The Agent **MUST** respond once the message is inserted
into the ACP conversation, **without waiting for foreground work to finish**, and **MUST NOT**
respond successfully merely because it received the input or assigned it an ID
(`prompt-lifecycle.mdx:139`). Everything else — running/idle/requires_action, stop reason, tool
calls, messages — moves to `session/update` notifications (out of scope for this milestone; see
handoff below).

Token-usage corollary (not asked for, but a real gap worth flagging): codex-acp's v1 response
already populates an UNSTABLE `usage` field (`CodexAcpServer.ts:2987`,
`this.buildPromptUsage(sessionState.lastTokenUsage)`). v2's `PromptResponse` has no such field;
the spec's replacement is the `usage_update` session/update variant
(`prompt-lifecycle.mdx:350-373`, `used`/`size`/optional `cost`). This is a milestone-(b)-adjacent
follow-up (it's a `session/update` variant, not a response-shape concern), flagged here since it's
directly visible from diffing the two response shapes.

### Comparison table (from `migration.mdx:230-237`)

| Foreground signal | v1 | v2 |
| --- | --- | --- |
| Prompt inserted | Implicit | `session/prompt` response with `messageId` |
| User message in history | Implicit (the request itself) | `user_message` update, agent-owned `messageId` |
| Foreground work running | `session/prompt` still pending | `state_update` `state: "running"` |
| Foreground work ended | `session/prompt` response with `stopReason` | `state_update` `state: "idle"` + `stopReason` |
| Cancellation confirmed | Prompt response `stopReason: "cancelled"` | Idle `state_update` `stopReason: "cancelled"` |

## 2. TCK requirement texts (`acp-tck` `src/tck/v2/requirements.py`)

- **`ACP-PROMPT-201`** (`Tier.CAPABILITY`, `capability="capabilities.session"`, lines 182-194):
  "The `session/prompt` result is a non-error object carrying a non-empty string `messageId` --
  the acceptance receipt sent at insertion time, not a turn result (there is no `stopReason` here
  at all in v2)." Cites `prompt-lifecycle.mdx:124-127`; `schema/v2/schema.json:4097`
  (`PromptResponse`, required `["messageId"]`), `:4120` (`MessageId = string`).
- **`ACP-PROMPT-203`** (`Tier.CAPABILITY`, lines 195-209): "The agent reports the inserted user
  message via a `user_message` update or at least one `user_message_chunk` update, carrying the
  same `messageId` as the `session/prompt` response, for the prompted session -- before or after
  the response, no later than the turn-ending idle." Cites `prompt-lifecycle.mdx:129`,
  `migration.mdx:261`, `schema/v2/schema.json:4767` (`UserMessage`), `:4738` (`ContentChunk`).
  (This one straddles milestones (a)/(b): the response half is (a)'s concern — matching
  `messageId` — the `user_message` update half is milestone (b)'s.)
- **`ACP-PROMPT-205`** (`Tier.CAPABILITY`, lines 161-180): "Every `session/update` notification the
  agent emits during a `session/prompt` turn validates against the v2 schema and carries the
  prompted `sessionId`. Vacuous pass if the agent emits no updates during the turn." Explicitly
  **not** a reuse of v1's `ACP-PROMPT-002` despite identical text — the *tier* differs because in
  v2 the whole `session/prompt` surface is gated behind the optional `capabilities.session`
  marker (unlike v1 where the session surface is unconditional `Tier.MANDATORY`). This row is
  primarily milestone (b)'s concern (state_update content) but the id-reuse note is relevant
  context for how CAPABILITY-tiering interacts with this topic generally.
- **`ACP-PROMPT-003`** (`Tier.ADVISORY`, `capability=None`, lines 303-317): "A prompt of `text` +
  `resource_link` content blocks is accepted, and the turn reaches idle -- ADVISORY, since
  `initialization.mdx:203` ('agents advertising `session` MUST support `text` and `resource_link`')
  conflicts with `content.mdx:33` ('all agents MUST support text content blocks', silent on
  `resource_link`); the conflict survives verbatim from v1 into v2." This is a request-content
  concern (unaffected by the response-shape change) and an end-to-end "did it reach idle" check
  that spans all three milestones — noted for completeness, not actionable within (a) alone.

## 3. SDK type-generation gap — actionable finding

The **installed** `@agentclientprotocol/sdk@1.4.0` package
(`node_modules/@agentclientprotocol/sdk/dist/v2/schema/types.gen.d.ts:3008-3019`) has a
**stale/incorrect** v2 `PromptResponse` type — it has **only** `_meta`, missing `messageId`
entirely:
```ts
export type PromptResponse = {
    _meta?: { [key: string]: unknown; } | null;
};
```
This contradicts the current spec (checked above) and also contradicts the SDK's own upstream
`origin/main` (`acp-typescript-sdk` repo, `src/v2/schema/types.gen.ts:3234-3244`), which already
has `messageId: MessageId` as a required field, matching the spec exactly. I additionally
`npm pack`ed the currently-published `@agentclientprotocol/sdk@1.5.0` (newer than the `1.4.0`
codex-acp has installed) and confirmed **`1.5.0` already has the fix** — `messageId` present and
required in `PromptResponse`. **Action item for implementation (not done here, since this is
research-only): bump the `@agentclientprotocol/sdk` dependency from `1.4.0` to at least `1.5.0`
before building the v2 `session/prompt` handler**, or the SDK's own generated response type won't
even allow returning `messageId` in a type-checked way. This is a real, low-effort, but easy-to-miss
prerequisite for this specific topic — flag it prominently to whoever implements milestone (a).

`PromptRequest` in the installed SDK (both `1.4.0` and `1.5.0`) already matches the spec (`sessionId`,
`prompt: ContentBlock[]`, `_meta`) — no request-side SDK gap.

## 4. Current codex-acp v1 implementation — where `stopReason` is produced today

**`src/CodexAcpServer.ts:2801` — `async prompt(params, signal?, onTurnStarted?):
Promise<acp.PromptResponse>`.** This single async method's lifetime IS the v1 turn. Concretely:

- It runs the command-handling path (`tryHandleCommand`, `:2912-2990`) or the normal model path
  (`:2992` onward), and in **both** branches it `await`s all the way to turn completion before
  constructing and `return`ing the `PromptResponse` literal containing `stopReason` (three
  call sites: `:2986` `stopReason: "end_turn"` after a locally-handled command,
  `:3220` `stopReason: "end_turn"` after the model turn, `:3332`/`:3349` for cancellation/other
  paths — plus a shared `cancelledPromptResponse()` helper at `:2847-2852` that also returns
  `stopReason: "cancelled"`).
- The actual turn execution is `this.codexAcpClient.sendPrompt(...)` (`:3022-3043`), which
  delegates to **`src/CodexAcpClient.ts:1011` `sendPrompt(...)`**, which calls
  **`src/CodexAppServerClient.ts:295` `runTurn(params, onTurnStarted)`**. `runTurn` issues the
  app-server RPC `turn/start` (`:302`, `this.turnStart(params)`), and *as soon as that RPC
  resolves* (app-server has accepted the input and assigned a `turn.id`) it invokes
  `onTurnStarted?.(turnStarted.turn.id)` (`:303`) — **then it keeps waiting**
  (`this.awaitTurnCompleted(...)`, `:311`) for the app-server's own `turn/completed` notification
  before `runTurn`'s promise resolves. So `runTurn`'s promise, not `turnStart`'s response, is what
  `prompt()` awaits for its own return value today.
- **This `onTurnStarted` callback is the closest existing analogue to v2's "insertion" moment** —
  it fires once app-server has durably accepted the input and given it an identity (a turn id),
  which is structurally where a `messageId`-bearing early response would need to be sent from. It
  is not a perfect match (it signals *turn* acceptance, not literally "user message inserted into
  conversation" as a separate concept — Codex app-server has no separate "message inserted" event
  independent of turn start), but it's the best available hook, and codex-acp already threads it
  through three call sites (`:2917`, `:3031`, `:3131` — the last one for the internal
  plan-approval "Implement the approved plan." follow-up turn, see below).
- Notably, **`prompt()` sometimes runs *two* turns within one RPC call**: after the first
  `sendPrompt` resolves, if the completed turn produced a plan and the session is in
  `PLAN_COLLABORATION_MODE`, `prompt()` requests permission (`:3100`,
  `requestPlanImplementationPermission`) and then — still inside the same `prompt()` invocation —
  sends a **second** internal `sendPrompt` (`:3116-3179`, the synthetic "Implement the approved
  plan." prompt) and awaits *that* turn's completion too before finally returning. The v1 response
  the client eventually receives describes whichever turn ended last.

Turn-completion detection itself lives in **`src/CodexEventHandler.ts`**: `completeSuccessfulTurn`
(`:357`), `handleFailedTurn` (`:366`), and the `notification.method === "turn/completed"` branch
inside `handleNotification` (`:458`) and a second switch case at `:561`. `prompt()` reads
`turnCompleted.turn.status` (`"completed"` / `"interrupted"` / failure) off the
`TurnCompletedNotification` that `runTurn` resolves with, not from `CodexEventHandler` directly —
`CodexEventHandler` is fed the same stream of `ServerNotification`s (via
`codexAcpClient.subscribeToSessionEvents`, `:2885-2906`) purely to drive `session/update` emission
(plan updates, message chunks, tool calls, subagents, error buffering), in parallel with
`prompt()`'s own `turnCompleted` await. This dual consumption (one path for the RPC's own
`await`, one path for streaming notifications) is exactly what milestone (b) will need to
reconcile with `state_update` mapping — noted here only because it's directly visible from reading
this method, not investigated further per the (a)-only scope.

## 5. Dual-version cost/risk assessment for milestone (a)

**This is NOT a cheap thin-serialization-layer branch, unlike the `initialize` topic.** Applying
the dual-version lens from the shared capability-negotiation findings: `initializeV2` was cheap
because the v1 `initialize` handler is a short, self-contained function that builds a response
object and returns — adding a parallel `initializeV2` sibling that builds a *different* response
object from the same input state costs nothing structurally. `prompt()` is fundamentally
different: **its function boundary (the async method call/return) currently *is* the turn
lifecycle marker.** The v1 RPC response, the cancellation `AbortSignal` scope
(`activePrompt.signal`, `:2834`, `:2873`, `:2879`), the permission/elicitation handler lifetimes
(`permissionLifecycle.beginPrompt()`/`approvalHandler`/`elicitationHandler`, `:2868-2880`), the
plan-approval sub-loop, and the subagent-wait logic (`eventHandler.waitForNativeSubagents`,
`:3061`) are all scoped to "lives exactly as long as the pending RPC does." Converting to v2
semantics means:

1. The v2 handler must return as soon as the equivalent of `onTurnStarted` fires (or an
   analogous "message accepted" point) — **not** wait for `runTurn`'s full promise.
2. Everything downstream of that point in today's `prompt()` — waiting for `turnCompleted`,
   running `CodexEventHandler`'s turn-completion/failure handling, the entire plan-approval
   second-turn sub-flow, subagent waiting, session-failure recovery
   (`clearRecoveredSessionFailure`) — must continue running **after** the RPC has already
   returned, as a detached/background task, and must still correctly emit `state_update`
   (milestone (b)) when it eventually finishes.
3. Cancellation (`session/cancel`) must still be able to reach and abort that now-detached
   background task; today cancellation and the pending RPC's `AbortSignal`
   (`observePromptRequestCancellation`, `:2834`) are implicitly coupled to the RPC still being
   in flight. This is a genuine control-flow/lifetime restructuring, not a value-shape swap.
4. `codexAcpClient` per-session per-prompt state (`activePrompt`, `pendingTurnStarts`,
   `sessionState.currentTurnId`) is currently mutated with the assumption that at most one
   `prompt()` call's lifetime governs a session's active turn at a time; a background-continuing
   v2 flow needs the same session-scoped bookkeeping to remain correct once the "owning" RPC call
   has already returned to the caller.

**Concretely for the response shape itself (this milestone's narrow deliverable):** producing a
`{ messageId }` value at the moment of "acceptance" is cheap — codex-acp can mint an opaque id
(a UUID, or reuse the turn id, or a newly-generated message id) as soon as the equivalent of
`onTurnStarted` fires, with no new information needed from Codex app-server. **The expensive,
risky part is that resolving the RPC promise at that point, while the rest of `prompt()`'s body
keeps running, requires decoupling roughly the bottom 80% of the current `prompt()` method (`:2992`
through its end, several hundred lines) from the RPC's own promise chain** — turning a single
linear `async function` into "do some work, resolve the caller's promise, keep doing more work."
That refactor risks v1 regressions if the shared internals (`CodexEventHandler`, cancellation,
plan-approval, subagent waiting) are touched carelessly, **even though v1's own `prompt()` method
itself does not need to change at all** (v1 keeps blocking for the full turn, unchanged). The risk
is entirely in extracting a background-continuable execution path for v2 without disturbing the
existing linear one used by v1 — i.e., the two handlers can start from a shared inner "run the
turn and stream events" helper, but v1 calls it and awaits to completion synchronously while v2
calls it, captures the early "accepted" signal, returns immediately, and lets the rest continue
unawaited. **Whether that extraction is safe to do without behavior-changing v1 is itself
nontrivial** and should be treated as real design/implementation work, not a wiring exercise.

**Bottom line:** milestone (a) in isolation (the wire shape: request unchanged, response becomes
`{messageId}`) is simple to *describe*, but implementing it for real requires the same underlying
turn-execution refactor that milestones (b) and (c) also depend on — so, unlike `initialize`,
this topic cannot be fully "small-cost, additive-only." Flag this explicitly to the orchestrator:
this is the correctly-identified "most structurally invasive" topic, and milestone (a) alone
already surfaces the core risk (decoupling RPC-response-lifetime from turn-lifetime), even before
milestones (b)/(c) add state_update mapping and steering/queue interaction on top.

## Handoff to the follow-up subagent (milestones (b) and (c))

What's already established (build on this, don't re-derive it):

- Request shape is unchanged; only the response shape changes (`{stopReason}` → `{messageId}`).
  No `usage` field survives into v2's `PromptResponse` — usage moves to the `usage_update`
  `session/update` variant (`prompt-lifecycle.mdx:350-373`), which is a milestone-(b)-shaped
  concern (it's a `session/update` variant) even though it was noticed while diffing (a)'s shapes.
- The `onTurnStarted` callback (`CodexAppServerClient.ts:295-315`, fired at `:303` right after the
  `turn/start` RPC resolves) is the best existing hook for "when to resolve the v2 response /
  start reporting `running`" — it already threads through `CodexAcpClient.sendPrompt` →
  `CodexAcpServer.prompt`'s inner closures at three call sites (`:2917`, `:3031`, `:3131`).
- **Milestone (b) needs to design:** how `state_update` (`running`/`idle`/`requires_action`) gets
  emitted from the (now-detached-from-the-RPC) turn-execution path, and where `stopReason`
  physically gets attached to the idle `state_update` — likely sourced from the same
  `TurnCompletedNotification`/`turn.status` data `runTurn` already resolves with
  (`CodexAppServerClient.ts:311`, `awaitTurnCompleted`), just re-plumbed to a notification instead
  of a return value. `requires_action` should likely map to codex-acp's existing permission-request
  flow (`permissionLifecycle`/`approvalHandler`, `CodexAcpServer.ts:2868-2880`) — worth checking
  whether that flow already has a natural "blocked on user action" signal to hang `requires_action`
  off of.
- **Milestone (c) needs to design:** how this interacts with codex-acp's existing
  steering/queued-prompt logic. This run did **not** locate or read a `SteeringQueue.ts` file or
  equivalent — a grep for `SESSION_STEERING_METHOD`/steering appears in `src/AcpExtensions.ts`
  (referenced in the sibling `initialize` topic's findings, `.agents/research/
  v2-capability-negotiation-and-initialize.md:384`) but this run did not open that file or search
  further for where prompt queuing actually lives. **Start milestone (c) by locating the steering
  implementation from scratch** (likely `src/AcpExtensions.ts` plus wherever `activePrompts`/
  `pendingTurnStarts` queuing is implemented in `CodexAcpServer.ts`, which this run touched only
  incidentally via the plan-approval second-turn flow at `:3116-3179`).
- The core structural risk flagged in §5 above (decoupling RPC-response-lifetime from
  turn-lifetime) is **the shared prerequisite for both (b) and (c)** — neither can be designed in
  a vacuum from (a)'s refactor, since both depend on turn execution continuing past the point
  where the v2 RPC has already returned.
- **SDK dependency bump needed:** `@agentclientprotocol/sdk` must move from the installed `1.4.0`
  to at least the published `1.5.0` before `messageId` can be returned in a type-checked
  `PromptResponse` (see §3). This is a one-line `package.json`/lockfile change but is easy to miss
  since `1.4.0` otherwise looks complete for other v2 surfaces (per the sibling `initialize`
  topic's research, which used the same `1.4.0` install without hitting this gap — `initialize`
  wasn't affected because `InitializeResponse` was already correct in `1.4.0`).

---

## 6. Milestone (b): `state_update` mapping and where `stopReason` lives now

### 6.1 Spec: exact lifecycle and triggers (`docs/protocol/v2/prompt-lifecycle.mdx`, full re-read)

Confirmed against the same `agent-client-protocol` checkout, commit `8c90bb7` (attempted
`git pull --ff-only` this run; it reported "Already up to date" — checkout is current, same commit
as milestone (a)).

- **`running`** (`prompt-lifecycle.mdx:188`, `migration.mdx:278`): "When foreground work starts or
  resumes, the Agent **MUST** send a `state_update` notification with `state: "running"`." This
  fires (i) right after prompt acceptance/insertion (mermaid diagram, `prompt-lifecycle.mdx:57-59`:
  response → `user_message` update → `state_update: running`, in that order) and (ii) again after
  any `requires_action` period ends (`:73`, `:400`: "When work resumes, the Agent **SHOULD** report
  `running`").
  `RunningStateUpdate` carries **no fields at all** beyond `_meta`
  (`acp-typescript-sdk src/v2/schema/types.gen.ts:3920-3930`) — it is a pure state-transition
  marker, no payload.
- **`idle`** (`prompt-lifecycle.mdx:377`, `:518-520`): "When the Agent is ready to process a new
  prompt, it **MUST** report `idle`... When the transition ends foreground work, the Agent **MUST**
  include the corresponding `StopReason`." `IdleStateUpdate` carries `stopReason?: StopReason |
  null` and the UNSTABLE `usage?: Usage | null` (`types.gen.ts:3995-4030`) — this is exactly where
  the milestone-(a) finding about the vanished `usage` field lands: it doesn't disappear, it moves
  from the old `PromptResponse.usage` onto the idle `state_update`.
  `prompt-lifecycle.mdx:526` and `migration.mdx:311` both stress: **`idle` is not a terminal state
  for the session** — "Background activity **MAY** continue and emit other `session/update`
  notifications while the Agent reports `idle`. These notifications do not change the state." — so
  `idle` means "no foreground work," not "session is dormant."
- **`requires_action`** (`prompt-lifecycle.mdx:398-400`, `:522-524`, mermaid `:66-74`): "Before
  proceeding with execution, the Agent **MAY** request permission from the Client via
  `session/request_permission`. While foreground work is blocked on a permission response **or
  other user action**, the Agent **SHOULD** report `requires_action`." The mermaid diagram pins the
  exact ordering: `tool_call_update` → `session/request_permission` (request) → `state_update:
  requires_action` → *(user grants/denies)* → permission response → `state_update: running`. Note
  the phrase "or other user action" — the spec does not scope `requires_action` to permission
  requests alone, it's the general "blocked on the human" state; permission requests are the only
  *concrete* trigger codex-acp has today (see §6.3). `RequiresActionStateUpdate` also carries no
  fields beyond `_meta` (`types.gen.ts:4031-4049`) — same bare-marker shape as `running`. This means
  the *content* of what's blocking (which permission, which tool call) is carried entirely by the
  separate `session/request_permission` request/response pair, not by the state_update itself; the
  state_update is purely "the traffic light changed," and the client is expected to already have the
  permission-request payload in hand from the parallel RPC.
- **Cancellation ack** (`prompt-lifecycle.mdx:548`, `migration.mdx:317`, Warning block
  `:550-557`): "After all ongoing operations have been successfully aborted and pending updates
  have been sent, the Agent **MUST** send an idle `state_update` session update with the
  `cancelled` stop reason." The spec explicitly frames this as the mechanism for the client to
  reliably confirm cancellation happened (as opposed to a thrown/swallowed abort exception being
  misread as a generic failure) — i.e. **yes, going idle with `stopReason: "cancelled"` IS the
  cancellation ack**, there is no separate ack notification. This directly answers the prompt's
  question and is exactly what the sibling `v2-cancellation-semantics` topic needs from this
  milestone: don't re-derive it, the ack *is* the idle transition.
- `docs/protocol/v2/session-setup.mdx` was checked for `state_update` coverage per the task
  instructions: it has **none** — grep for `state_update`/`StateUpdate` in that file returns zero
  hits. `state_update` is entirely a `prompt-lifecycle.mdx` concept; session-setup only covers
  session creation/resume/config, not foreground-work state. Nothing to reconcile between the two
  docs.

### 6.2 TCK requirement texts (`ACP-STATE-201/202/203`, `acp-tck/src/tck/v2/requirements.py:211-259`)

- **`ACP-STATE-201`**: a turn-ending idle `state_update` (one carrying a `stopReason`) implies an
  earlier `running` `state_update` was observed in the same turn — i.e. you cannot jump straight to
  a stop-reason-bearing idle without having reported `running` first. Unlike 202/203, this row's
  SKIP condition is keyed off the *idle* event (skipped only if no stop-reason-bearing idle is ever
  observed), so an idle-with-stopReason-but-no-preceding-running is a hard **FAIL**, not a skip.
- **`ACP-STATE-202`**: after an accepted prompt shows `running`, an idle `state_update` must arrive
  within the turn's timeout budget — i.e. `running` cannot hang forever without a terminating idle.
  SKIPPED if `running` was never observed (e.g. a command-only turn that never reports running at
  all).
- **`ACP-STATE-203`**: the idle that terminates an observed `running` turn must carry a `stopReason`
  whose value is one of the five defined constants or begins with `_` — scoped specifically to the
  idle that *terminates* a `running` turn (an unscoped "every idle needs a stopReason" check is
  explicitly forbidden by the TCK's own comment, since idle can also be reported without ending
  foreground work in edge cases). Same SKIP gate as 202.

All three are `Tier.CAPABILITY` gated on `capabilities.session` (v2's session surface is optional,
unlike v1's mandatory session methods) — consistent with the milestone-(a) finding about
`ACP-PROMPT-205`'s CAPABILITY tiering.

### 6.3 SDK type-generation check: no gap here (unlike milestone (a)'s `messageId` bug)

Checked the installed `@agentclientprotocol/sdk@1.4.0`
(`node_modules/@agentclientprotocol/sdk/dist/v2/schema/types.gen.d.ts:3580-3720`, codex-acp repo)
against the upstream `acp-typescript-sdk` checkout. **Note:** `git pull --ff-only` on that checkout
failed this run ("local changes to package-lock.json would be overwritten") and stashing/repairing
it was outside this run's authorization, so the local checkout stayed at `f1c0141` rather than
`origin/main`'s tip (`69fda37`). To compensate, `git fetch origin main` was run (read-only, doesn't
touch the working tree) and `git diff f1c0141 origin/main -- src/v2/schema/types.gen.ts` was
checked specifically for the `StateUpdate` region — **zero diff lines**, confirming `f1c0141`'s
`StateUpdate`/`RunningStateUpdate`/`IdleStateUpdate`/`RequiresActionStateUpdate`/`Usage`/`StopReason`
types are byte-identical to `origin/main`'s tip, even though six commits landed on `src/v2` between
those two points (`f7941e7` "update schemas to v1.23.0/v2.0.0-alpha.5" among them — that commit
evidently touched other v2 surfaces, not this one).

Result: **the installed `1.4.0`'s `state_update`-related types are complete and correct** — full
byte-for-byte match between `node_modules/@agentclientprotocol/sdk/dist/v2/schema/types.gen.d.ts`
(codex-acp's install) and both the local `f1c0141` checkout and `origin/main`. `IdleStateUpdate`
has `stopReason?: StopReason | null` and `usage?: Usage | null`; `RequiresActionStateUpdate` and
`RunningStateUpdate` have only `_meta`. **This is unlike milestone (a)'s finding** (installed
`1.4.0`'s `PromptResponse` was missing `messageId` entirely) — there is no SDK-bump prerequisite
specific to milestone (b)'s types. The `1.4.0`→`1.5.0` bump flagged in §3 is still needed overall
for this topic (because of the `PromptResponse.messageId` gap), but nothing *additional* is needed
for `state_update` typing.

### 6.4 Where `stopReason` is computed today, and what would drive the idle `state_update` instead

Confirms and extends the milestone-(a) handoff note. `stopReason` is produced at exactly four
literal sites in `src/CodexAcpServer.ts`, all inside or downstream of `prompt()`:

- `:3330-3336` — `cancelledPromptResponse(sessionState)`: always `stopReason: "cancelled"`, built
  from `turnCompleted.turn.status === "interrupted"` (`:3074`, `:3055`/`:3056` for the
  race-before-turn-started case) or an explicit cancellation signal. This is the exact same data
  the cancellation-ack idle `state_update` needs per §6.1.
- `:3338-3356` — `terminalFailurePromptResponse(...)`: **always** `stopReason: "end_turn"`, even for
  terminal *failures* — the actual failure detail rides in `_meta` (`eventHandler.
  getTerminalSessionFailureMeta(...)`), not in a distinct `StopReason` value. **Concrete existing
  gap, not new for v2**: codex-acp today never produces `stopReason: "refusal"`, `"max_tokens"`, or
  `"max_turn_requests"` — only `"end_turn"` and `"cancelled"` are ever emitted, confirmed by
  grepping all `stopReason:` literals in the file (`:2986`, `:3220`, `:3332`, `:3349` — only these
  two string values appear). This coarse mapping carries over unchanged into the v2 idle
  `state_update.stopReason` field with **no new decision logic required** for milestone (b) — v2
  doesn't force codex-acp to start distinguishing `refusal`/`max_tokens`/`max_turn_requests`, it
  just needs to move the same two-value logic from a response field to a notification field. (Worth
  flagging to the orchestrator as a *pre-existing* fidelity gap, not a v2-migration side effect, in
  case another topic wants to improve it independently.)
- `:2986` — the locally-handled-command path's own `stopReason: "end_turn"` literal (not via the
  helper, but same value).

**The event source feeding all of the above is unchanged from milestone (a)'s finding**:
`turnCompleted.turn.status` off the `TurnCompletedNotification` that `CodexAppServerClient.
runTurn()`'s `awaitTurnCompleted(...)` (`:768`) resolves with, itself fed by the app-server's own
`turn/completed` notification (`CodexAppServerClient.ts:1179-1183`,
`isTurnCompletedNotification`). **Confirmed via re-reading `CodexEventHandler.ts:357-379`
(`completeSuccessfulTurn`, `handleFailedTurn`) and its `turn/completed` branches
(`CodexEventHandler.ts:458-465`, second switch case `:561`)**: `CodexEventHandler` is *not* the
place the idle `stopReason` value is decided today — it only reacts to `turn/completed` for
session-failure bookkeeping (clearing/raising `sessionState.sessionFailure`) and native-subagent
finalization; the actual `stopReason` string is decided in `CodexAcpServer.prompt()`'s own body
(the three helpers above), reading `turnCompleted.turn.status` directly. **For v2, the natural
design is: keep that same decision logic (the two-value `end_turn`/`cancelled` mapping) exactly
where it is, but instead of returning it inside a `PromptResponse` literal, wrap it in a
`session/update` notification with `sessionUpdate: "state_update", state: "idle", stopReason:
...}` and send it via the connection, at the same point `prompt()` currently constructs and returns
the v1 response.** This is a genuine "fork at the notification/response layer over the same
decision" — not a new decision-making problem.

For `running`: the natural emission point is the same `onTurnStarted` hook already identified in
milestone (a) (`CodexAppServerClient.ts:303`, threaded through `CodexAcpServer.ts:2917/:3031/:3131`)
— fire the `state_update: running` notification from the same callback that would resolve a v2
`session/prompt` response with `{messageId}`. Both events happen at the same moment structurally
(app-server has accepted the turn), so no new hook is needed, just two outputs from one callback
instead of one.

### 6.5 Where `requires_action` should hook in — confirmed, four call sites

The milestone-(a) handoff guessed this needed investigation; confirmed by reading
`src/permissions/CodexApprovalHandler.ts` in full and grepping `CodexAcpServer.ts` for
`session/request_permission` call sites. There are exactly **four** places codex-acp calls
`acp.methods.client.session.requestPermission` today, all structurally identical — a blocking
`this.connection.request(...)` call with nothing wrapped around it to signal "blocked":

1. `CodexApprovalHandler.ts:51` (inside `handleCommandExecution`, via the private `requestPermission`
   helper at `:105-111`)
2. `CodexApprovalHandler.ts:70` (inside `handleFileChange`)
3. `CodexApprovalHandler.ts:87` (inside `handlePermissionsRequest`)
4. `CodexAcpServer.ts:3306-3310` (`requestPlanImplementationPermission`, the plan-approval sub-flow
   milestone (a) already flagged as running a *second* internal turn)

`PermissionLifecycleContext`/`PermissionPromptContext` (`src/permissions/lifecycle.ts:1-70`, which
this run read in full) do **not** track a "currently blocked" boolean or any request-in-flight
state — they exist purely for MCP tool-call-id correlation and file-change/command-name lookup
scoped to a prompt generation. **There is no existing "blocked on user action" signal to hang
`requires_action` off of** (contrary to the milestone-(a) handoff's hope) — the *only* signal today
is the bare fact that one of the four `connection.request(...)` calls above has an in-flight,
unresolved promise. Concretely, the design is: wrap each of the four call sites (or, better, just
the shared `requestPermission` helper in `CodexApprovalHandler.ts:105-111` plus the one bespoke call
in `requestPlanImplementationPermission`) to emit `state_update: requires_action` immediately before
issuing the request and `state_update: running` immediately after it resolves (success, rejection,
or cancellation all count as "resumed" — the mermaid diagram doesn't distinguish granted vs. denied
for the state transition, only for what happens next). This exactly matches
`prompt-lifecycle.mdx:66-74`'s ordering and requires no new state-tracking data structure, just two
notification sends bracketing four existing call sites.

---

## 7. Milestone (c): steering/queued-prompt interaction

### 7.1 Confirmed location (the milestone-(a) handoff's "start from scratch" was necessary — found it)

- **`src/AcpExtensions.ts:43`**: `export const SESSION_STEERING_METHOD = "_session/steering";` — a
  custom, non-standard extension method, unrelated to the standard `session/prompt` verb.
  `:122-134` define `SessionSteerRequest {sessionId, prompt: ContentBlock[]}` and
  `SessionSteeringResponse {outcome: "injected" | "startedNewTurn" | "failed"}`; `:136-141`
  `steerSessionWithFallback(...)` is the *client-side* helper that calls this method (used by
  codex-acp's own IDE-side integration, not by the ACP server logic itself).
- **`src/SteeringQueue.ts`** (read in full, 56 lines): a small per-session single-consumer queue.
  `enqueue()` pushes `{params, resolve, reject}` and kicks a `consume()` loop if not already
  running; the loop drains one entry at a time via `await this.handle(next.params)`, so "two
  concurrent steers can never race to start rival turns" (its own doc comment, `:10-12`). `isIdle`
  (`:30-32`) reports `!processing && pending.length === 0`.
- **`src/CodexAcpServer.ts:1523-1721`** — the actual dispatch, in order:
  - `executeOrQueueSteeringRequest` (`:1523-1538`, the `SESSION_STEERING_METHOD` handler registered
    at `:449-450`): gets-or-creates a per-session `SteeringQueue` (`getSteeringQueue`,
    `:1547-1554`, stored in `this.steeringQueues: Map<string, SteeringQueue>` at `:303`) and
    `enqueue`s the request, deleting the queue entry once idle (guarded by an identity check against
    a later request having already replaced it).
  - `performSteeringRequest` (`:1564-1581`): the actual "one steer at a time" body the queue calls.
    Calls `getSteerableTurnId(sessionState)` (`:1739-1752`): **returns
    `sessionState.currentTurnId` if set, else awaits `this.pendingTurnStarts.get(sessionId)` if a
    turn-start is in flight, else `null`.** This is codex-acp's existing, if informal, "is this
    session currently running-or-about-to-run" check — exactly the concept milestone (b)'s
    `running`/`idle` state maps onto.
  - If a turn id is found, `injectSteerIntoActiveTurn` (`:1605-1625`) calls
    `this.codexAcpClient.steerTurn({threadId, turnId, prompt})` — a Codex-app-server-level RPC that
    injects additional input into an **already-running** Codex turn (this is a Codex-native
    capability, not something ACP itself defines) — and treats a `"no active turn to steer"` error
    (`isNoActiveTurnToSteerError`, `:1723-1737`) as "the turn ended underneath us, fall back," not a
    hard failure.
  - If injection isn't applicable (no turn, or it just ended), `startNewTurnFromSteering`
    (`:1639-1642`) → `startNewTurnFromExternalPrompt` (`:1666-1721`) starts a **new** turn.

### 7.2 Key finding: `startNewTurnFromExternalPrompt` already implements milestone (a)'s decoupling pattern, in production, today

This is the single most important finding of this run. `startNewTurnFromExternalPrompt`
(`CodexAcpServer.ts:1666-1721`) already does exactly the "resolve early, let the turn keep running
in the background" restructuring that the milestone-(a) subagent flagged as the topic's core,
unproven risk:

```
const promptDone = this.prompt(params, undefined, () => {
    turnStarted = true;
    resolve(true);              // <-- resolves the OUTER promise as soon as the turn starts
});
promptDone.then(
    (response) => { /* only matters if the turn never started at all */ },
    (error) => { if (turnStarted) { logger.error(...); /* nothing to return, turn already "answered" */ } },
);
```

`this.prompt(...)` is called and its returned promise is **not awaited** by the function that needs
an early answer — the early answer comes from the `onTurnStarted`-style callback passed as
`prompt()`'s third argument, and `prompt()`'s own eventual settlement (success or failure) is
handled asynchronously afterward, purely for logging/steer-outcome purposes, decoupled from the
caller having already returned. **This is a working, already-shipped precedent for the exact
control-flow shape milestone (a) needs for the v2 `session/prompt` handler** — it proves the
"extract a background-continuable path without disturbing v1's own linear `await`" restructuring is
not hypothetical or unproven; codex-acp already does it, just for the steering extension's internal
plumbing rather than for the primary `session/prompt` RPC surface. This substantially **de-risks**
the milestone-(a) concern (§5 above): the risky-sounding "decouple RPC resolution from turn
completion" isn't new engineering, it's applying an existing, working pattern to a second call site.

It does **not** fully retire the risk, though — see §7.3 and §8.

### 7.3 The un-covered risk this precedent exposes: single-flight `activePrompts` bookkeeping

`trackActivePrompt` (`CodexAcpServer.ts:2574-2626`, read in full) is called once per `prompt()`
invocation and **unconditionally overwrites** `this.activePrompts.set(sessionId, activePrompt)`
(`:2624`) — there is no check for an already-in-flight prompt for that session, and no rejection
path. A superseded `activePrompt`'s own `.complete()` callback (`:2612-2621`) is guarded only by an
identity check (`this.activePrompts.get(sessionId) === activePrompt`) that makes it a silent no-op
if a newer prompt has since replaced the map entry — i.e. **two concurrent `prompt()` calls for the
same session today just silently race on shared per-session state** (`activePrompts`,
`pendingTurnStarts`, `sessionState.currentTurnId`) rather than one being rejected outright.

In practice this never bites today because: (a) v1 clients structurally cannot send a second
`session/prompt` before the first's blocking response arrives (nothing stops the JSON-RPC layer
from allowing it, but no spec-compliant v1 client does), and (b) codex-acp's own steering code
**deliberately avoids** calling `prompt()` a second time concurrently — `startNewTurnFromExternalPrompt`
explicitly `await previousPrompt?.completion` (`:1674-1675`) **before** starting a new one, precisely
to avoid "running two prompts on the same session" (its own comment, `:1671-1673`). So the existing
codebase already treats "two overlapping prompt-shaped operations on one session" as unsafe and
serializes around it via `SteeringQueue` + the `completion` await — it just does this *outside*
`prompt()` itself, not inside it.

**This is exactly the gap v2 opens up.** The spec explicitly permits a client to send a new
`session/prompt` while the session is `running`, without waiting for `idle`
(`prompt-lifecycle.mdx:139`: "without waiting for foreground work to finish"; `migration.mdx:321`:
"the same message flow works for... future agent-initiated or **queued work**" — queued work is
named as a first-class case the new design is *for*). If codex-acp's future v2 `session/prompt`
handler naively called the same `prompt()`-derived turn-starting routine a second time while an
earlier v2-originated prompt for that session is still mid-flight, it would hit precisely the
unguarded race `trackActivePrompt` allows today — a race that has simply never been exercised in
practice because every existing caller (v1 clients, and codex-acp's own steering code) avoids it by
construction, not because the underlying map is safe for it.

### 7.4 Design recommendation for milestone (c)

**Do not give v2's `session/prompt` its own naive "always start a new turn" path.** Instead, route
every v2 `session/prompt` call through the same decision codex-acp's steering extension already
makes: "is there a live-or-starting turn for this session (`getSteerableTurnId`)? If so, treat this
submission the way a steer would (inject via `codexAcpClient.steerTurn`, or queue behind the current
turn via the session's `SteeringQueue`/an equivalent primitive); if not, start a new turn the normal
way (mirroring `startNewTurnFromExternalPrompt`'s `await previousPrompt?.completion` guard)." This
converges plain v2 `session/prompt` and the custom `_session/steering` extension onto one shared
"insert new foreground work into this session, whether or not something is already running"
primitive, closing the `activePrompts` single-flight gap identified in §7.3 instead of merely
avoiding it by accident.

Two concrete implementation options, in decreasing order of ambition/payoff:

1. **Shared dispatch (recommended target design):** the v2 `session/prompt` handler calls
   `getSteerableTurnId` (or a renamed/generalized sibling of it) first; if a turn is live, it goes
   through the same `SteeringQueue`-serialized path `_session/steering` uses today (minting a
   `messageId` and resolving the v2 RPC as soon as the queue accepts/injects the submission, per
   milestone (a)/(b)'s hooks); if idle, it starts a new turn via the same
   `startNewTurnFromExternalPrompt`-shaped early-resolving wrapper. The existing
   `_session/steering` extension method stays registered unchanged on **both** the v1 and v2 chains
   (it's a custom method name, version-routing-agnostic, and its richer
   `injected`/`startedNewTurn`/`failed` outcome enum is still useful for clients that want to
   distinguish those cases explicitly — something the plain `{messageId}` response can't convey).
2. **Conservative fallback (lower effort, weaker spec utilization):** keep v2 `session/prompt`
   naive — it only ever starts a new turn, and errors (JSON-RPC error response, rejecting before
   insertion) if a turn is already live for that session. This is spec-legal (the spec never
   *requires* agents to accept overlapping prompts, only describes what must happen if the Agent
   does), and completely avoids the `activePrompts` race, but means v2 clients get no benefit over
   `_session/steering` for mid-turn input — they'd still have to know about and call the custom
   extension for that case, undercutting the spec's stated motivation ("future agent-initiated or
   queued work" should now be nameable through the standard verb). Flag as the fallback if option 1
   proves too invasive to land safely without v1 regressions.

**Answering the milestone's literal question** ("can a new prompt be sent while state is `running`,
or must it wait for `idle`?"): per spec, a client is **not required** to wait for `idle` — the
protocol is explicitly designed to support this (`migration.mdx:321`). Whether codex-acp's v2
*implementation* accepts such an early prompt (and if so, whether it injects or queues it) is an
implementation choice, not a protocol obligation — and codex-acp already has both behaviors
(`injected` vs. `startedNewTurn`) built and shipping for the custom steering path today; the
milestone-(c) work is making that same choice reachable from the standard `session/prompt` verb for
v2 clients, not inventing new semantics from nothing.

---

## 8. Final dual-version risk verdict for the whole prompt-lifecycle topic

Revisiting milestone (a)'s §5 risk assessment with (b) and (c)'s findings in hand:

- **The core question** — "can v1's blocking response and v2's non-blocking `{messageId}` +
  notifications be driven off one shared inner turn-execution helper, forked only at the
  response/notification layer, or does v1's blocking nature fundamentally conflict with that?" —
  now has an evidence-based answer instead of a speculative one: **yes, a shared inner helper is
  achievable, and codex-acp already has a working example of the exact shape needed** (§7.2,
  `startNewTurnFromExternalPrompt`). v1's `prompt()` keeps its fully-synchronous `await`-to-completion
  body untouched; a v2-facing wrapper can call the same turn-starting/turn-tracking machinery and
  resolve early off the same `onTurnStarted`-style hook, exactly as `startNewTurnFromExternalPrompt`
  already does for steering. **This lowers milestone (a)'s risk from "unproven control-flow
  redesign" to "generalizing an existing, working pattern to a second (primary) call site" — real
  work, but not a leap into the unknown.**
- **The residual, now precisely-located risk** is not the response/notification fork itself, nor the
  `state_update` mapping (§6 found no new decision logic anywhere — `running`/`idle`/`stopReason`
  all reuse existing signals and hooks, `requires_action` needs only two notification sends
  bracketing four already-identified call sites) — it is specifically the **single-flight
  assumption baked into `activePrompts`/`pendingTurnStarts`/`sessionState.currentTurnId`** (§7.3).
  Every existing caller of `prompt()` — v1 clients and codex-acp's own steering code alike —
  currently avoids ever calling it twice concurrently for one session, whether by protocol
  convention (v1) or by an explicit `await previousPrompt?.completion` guard (steering). v2 is the
  first case where a *spec-compliant, unmodified client* is explicitly invited to do the thing this
  bookkeeping has never had to survive: submit new foreground work while a turn is already running,
  through the *standard* verb, not through the one custom extension that was carefully built to
  handle it.
- **Recommendation:** treat milestone (c)'s §7.4 option 1 (shared dispatch through the same
  turn-liveness check and queueing primitive steering already uses) as the actual scope of "finish
  the prompt-lifecycle topic," not an optional enhancement — it's what closes the one real
  structural gap this research found. Implementation should generalize `getSteerableTurnId` /
  `SteeringQueue` / `startNewTurnFromExternalPrompt` into the shared helper both `_session/steering`
  and v2 `session/prompt` call, rather than building two independent decoupled-resolution paths
  that separately race against `activePrompts`. **Overall verdict: medium-high effort, medium risk**
  (revised down from an implicit "unknown/high" framing at the end of milestone (a) alone) —
  concentrated entirely in that one generalization, not in the wire-shape changes (which are cheap
  in both directions, confirmed by §6's SDK/spec check finding zero new decision logic needed) and
  not in unproven control-flow surgery (§7.2 shows the pattern already exists and works).

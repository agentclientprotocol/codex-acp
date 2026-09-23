# v2 topic: Cancellation semantics

Builds directly on `.agents/research/v2-prompt-lifecycle-and-turn-state-machine.md` §6.1/§6.4
(idle `state_update{stopReason:"cancelled"}` IS the cancellation ack, no separate ack exists) —
not re-derived here, only extended with the `session/cancel` wire contract itself and the
permission-request cascade.

Spec checked at `agent-client-protocol` local checkout, commit `8c90bb7` ("docs: update registry
agents (#2217)"), `git pull --ff-only` reported "Already up to date" this run. SDK checked at
`acp-typescript-sdk` local checkout at `f1c0141` (working tree has the same pre-existing
uncommitted `package-lock.json` diff and untracked files noted by prior topics; `git fetch origin
main` confirmed `origin/main` is `69fda37`; all reads below of files that differ between the two
were done via a direct diff, not by touching the dirty working tree) plus the installed
`node_modules/@agentclientprotocol/sdk@1.4.0` in codex-acp.

## 1. `session/cancel` — request/response shape: **unchanged wire contract, v1 → v2**

### v1 (`docs/protocol/v1/prompt-turn.mdx:334-367`)

```json
{ "jsonrpc": "2.0", "method": "session/cancel", "params": { "sessionId": "sess_abc123def456" } }
```

- It is a **notification** (no `id`, no response ever sent) in v1 too — this is not a v2 change.
- Confirmation today = the still-pending `session/prompt` **response** resolves with
  `{"stopReason": "cancelled"}` (`prompt-turn.mdx:354`: "the Agent **MUST** respond to the
  original `session/prompt` request with the `cancelled` stop reason").

### v2 (`docs/protocol/v2/prompt-lifecycle.mdx:530-561`, `docs/protocol/v2/cancellation.mdx`)

```json
{ "jsonrpc": "2.0", "method": "session/cancel", "params": { "sessionId": "sess_abc123def456" } }
```

Byte-identical params shape. Confirmed at the JSON-schema level:

- v1 `#/$defs/CancelNotification` (`schema/v1/schema.json:5808-5828`): `{sessionId: SessionId
  (required), _meta?: object|null}`.
- v2 `#/$defs/CancelSessionNotification` (`schema/v2/schema.json:9841-9861`): `{sessionId:
  SessionId (required), _meta?: object|null}`.

The **only** difference between the two schema entries is the `$defs` name itself
(`CancelNotification` → `CancelSessionNotification`) and a docs-link update in the description —
`migration.mdx:710` confirms this is a pure "schema definition name changed, wire format did not"
rename, listed in the same breath as `UpdateSessionNotification`. `migration.mdx:48` states it
plainly in the compatibility table: "`session/cancel` | Unchanged name. Completion now reported
via `state_update` instead of the prompt response." `migration.mdx:317` gives the full sentence:
"`session/cancel` is unchanged as a notification, but confirmation moved with the rest of the
lifecycle: instead of responding to `session/prompt` with `"stopReason": "cancelled"`, the Agent
**MUST** finish sending any pending updates and then send an idle `state_update` with the
`cancelled` stop reason."

**Answer to the topic's headline question: `session/cancel` itself is unchanged in every
observable way (method name, notification-not-request nature, params shape, `_meta` passthrough).
Only the confirmation mechanism moved — from a `session/prompt` response field to a
`session/update` notification field.** This mirrors, almost exactly, the `session/prompt`
request-shape finding from the prompt-lifecycle topic (request unchanged, response semantics
redesigned) — cancellation is the same story one level down: trigger unchanged, acknowledgment
redesigned.

### SDK TypeScript types: no staleness gap here (unlike `PromptResponse.messageId`)

`acp-typescript-sdk/src/v2/schema/types.gen.ts:6331-6345` (local `f1c0141`) and
`origin/main:src/v2/schema/types.gen.ts:6400` are **byte-identical** for `CancelSessionNotification`
(diffed directly). The installed `node_modules/@agentclientprotocol/sdk@1.4.0/dist/v2/schema/types.gen.d.ts:5876-5887`
also matches exactly:

```ts
export type CancelSessionNotification = {
  sessionId: SessionId;
  _meta?: { [key: string]: unknown } | null;
};
```

No SDK version bump is needed specifically for this topic's types (the `1.4.0`→`1.5.0` bump
already flagged by the prompt-lifecycle topic for `PromptResponse.messageId` still applies overall
to the migration, just not as a prerequisite for cancellation itself).

## 2. The general JSON-RPC-level cancellation mechanism (`$/cancel_request`) — unchanged v1 → v2, and it is the mechanism for cascading cancellation to pending permission requests

`docs/protocol/v2/cancellation.mdx` (read in full) is near byte-identical to
`docs/protocol/v1/cancellation.mdx` (diffed the two; only the mermaid example differs cosmetically
— v1's example additionally shows a `terminal/create` request being cancelled, v2's drops that
example since `terminal/create` isn't a standalone v2 concept in the same way, but the *rule text*
is unchanged word-for-word):

- `$/cancel_request` is a **separate, general JSON-RPC-level** notification (not `session/cancel`)
  that either party can send to cancel any *specific pending request by id*: `{"jsonrpc":"2.0",
  "method":"$/cancel_request","params":{"requestId":...}}`.
- On receipt, the implementation **MUST** send exactly one final response for the original request:
  either a normal result, or an error with code `-32800` ("Request Cancelled").
- `cancellation.mdx:26` (v2) / `:26` (v1) explicitly cross-references `session/cancel` as the
  "per-feature" cancellation this general mechanism composes with: "Cancellation **MAY** also be
  done explicitly on a per-feature basis... such as cancellation of active session work."
- The mermaid "Cascading Cancellation Flow" example (`cancellation.mdx:40-69`, v2 version) shows
  the exact interaction this topic's task description flagged as needing investigation — a pending
  permission request during cancel:
  1. Client sends `session/cancel`.
  2. **Agent cascades internally**: for each of its own still-pending `session/request_permission`
     requests, the Agent sends `$/cancel_request(id=N)` **to the Client**.
  3. Client responds to each with `error -32800 "Cancelled"`.
  4. Only then does the Agent report `session/update(state_update: idle, stopReason: "cancelled")`.
- `prompt-lifecycle.mdx:544` (v2, also present in v1 `prompt-turn.mdx:350`) separately states the
  **Client**'s obligation: "The Client **MUST** respond to all pending `session/request_permission`
  requests with the `cancelled` outcome" — i.e. even without the Agent cascading a
  `$/cancel_request`, the client is independently obligated to unblock any permission
  request it has outstanding once it has sent `session/cancel`. The `$/cancel_request` cascade and
  the client's own `cancelled`-outcome duty are two independent, both-sides-covered paths to the
  same resolution.

## 3. TCK requirement texts (`acp-tck/src/tck/v2/requirements.py`)

All of the following are `Tier.CAPABILITY`, `capability="capabilities.session"`, unless noted:

- **`ACP-CANCEL-201`** (lines 392-405): "After `session/cancel` for a session with foreground work
  in flight, the agent sends a `session/update` whose `update` is `{"sessionUpdate": "state_update",
  "state": "idle", "stopReason": "cancelled"}`." Cites `prompt-lifecycle.mdx:519,526`,
  `migration.mdx:317`, `schema.mdx:234-240`. This is the core ack-mechanism requirement.
- **`ACP-CANCEL-202`** (406-418): "Every `session/update` the agent sends for the cancelled
  foreground work precedes the terminating idle `state_update`." Tested client-side only as "no
  further `state_update` for this session arrives within `quiet_period(...)` after the idle
  `cancelled` update, unless a new prompt was sent" — i.e. the idle-cancelled update must be
  genuinely terminal for that turn.
- **`ACP-CANCEL-203`** (419-432): "Cancellation is never surfaced as a generic failure: after
  `session/cancel`, the turn does not end with a JSON-RPC error on the `session/prompt` request,
  nor with an idle `state_update` whose `stopReason` is a non-`cancelled` known value." Directly
  codifies the spec's `<Warning>` block about API client libraries throwing on abort and Agents
  needing to catch that and report `cancelled` instead of a generic error.
- **`ACP-CANCEL-204`** (433-449, `Tier.INFORMATIONAL`, `capability=None`): records (never asserts)
  whether the agent stopped LM requests/tool calls "as soon as possible" — explicitly
  unobservable/unjudgeable from the wire, hence informational only, always SKIPs.
- **`ACP-CANCEL-205`** (450-463): "`session/cancel` is a notification: the agent MUST NOT send any
  JSON-RPC response (result or error) for it." Cites the schema placement of
  `CancelSessionNotification` under `AgentNotification` (not `AgentRequest`).
- **`ACP-CANCEL-206`** (464-476): "`session/cancel` params are exactly `{sessionId}` (required)
  plus optional `_meta`; the agent MUST accept a cancel that carries only `sessionId`, and MUST
  accept one that additionally carries `_meta`." Directly matches the schema diff in §1 above.
- **`ACP-CANCEL-207`** (477-490): "A custom stop reason MUST begin with `_`... Applied to the
  cancellation assertion itself: the agent may not substitute e.g. `aborted` for `cancelled`" —
  i.e. the idle `state_update`'s `stopReason` after a cancel must be the literal string
  `"cancelled"`, not a custom/nonstandard value.
- **`ACP-CANCEL-208`** (491-504): "`session/close` on a session with foreground work in flight MUST
  cancel that work as if `session/cancel` had been sent (same idle `cancelled` state_update), then
  free resources." Explicitly shares its test/citation with `ACP-CLOSE-202` (same wire evidence,
  double-registered under two ids purely for report legibility per two different requirement
  areas).
- **`ACP-INFO-CANCEL-201`** (505-514, `Tier.INFORMATIONAL`, `capability=None`): records (never
  asserts) agent behavior on `session/cancel` for an unknown `sessionId` or a session with no
  foreground work — "not specified" in the spec.
- **`ACP-INFO-CANCEL-202`** (515-527, `Tier.INFORMATIONAL`, `capability=None`): records (never
  asserts) "whether the agent sends `$/cancel_request` for its own pending
  `session/request_permission`/`elicitation/create` requests when active work is cancelled — not
  required, only illustrated (MAY at best)". Cites `cancellation.mdx:14,18,60-61` — i.e. the
  mermaid cascade diagram in §2 above is non-normative illustration, not a MUST.
- **`ACP-CLOSE-202`** (879-895): "`session/close` on a session with foreground work in flight
  cancels that work as if `session/cancel` had been sent — the same idle `state_update` with
  `stopReason: "cancelled"` evidence `ACP-CANCEL-208` already checks... registered separately... for
  this area's own report legibility." Backed by `docs/protocol/v2/session-setup.mdx:258`: "The
  Agent **MUST** cancel any ongoing work for that session as if `session/cancel` had been called,
  then free the resources associated with the session," followed by an empty-object `{}` success
  response.

**Net effect for codex-acp**: `ACP-CANCEL-204`/`ACP-INFO-CANCEL-201`/`ACP-INFO-CANCEL-202` are
informational/unobservable and impose no implementation obligation. The mandatory-for-capability
surface is: (a) the idle `state_update{state:"idle", stopReason:"cancelled"}` after `session/cancel`
on in-flight work (`201`/`203`/`207`), (b) never a JSON-RPC error on the pending
`session/prompt`/never a non-`cancelled` idle after a cancel (`203`), (c) no response at all to
`session/cancel` itself (`205`/`206`, already true today), and (d) the same behavior triggered by
`session/close` (`208`/`CLOSE-202`).

## 4. Current codex-acp v1 implementation

### `session/cancel` handler — `src/CodexAcpServer.ts:3413-3422`

```ts
async cancel(params: acp.CancelNotification): Promise<void> {
    const sessionState = this.sessions.get(params.sessionId);
    if (!sessionState) {
        logger.log("Cancel request rejected: session not found", {sessionId: params.sessionId});
        return;
    }
    // After turnInterrupt(), Codex will send turn/completed, which naturally completes awaitTurnCompleted().
    await this.interruptSessionTurn(sessionState, "Cancel", false);
}
```

Registered as a **notification** handler (not request) at `src/index.ts:165`:
`.onNotification(acp.methods.agent.session.cancel, (ctx) => getAgent().cancel(ctx.params))` — i.e.
codex-acp already treats `session/cancel` exactly as both v1 and v2 require: fire-and-forget, no
response ever sent. **This registration/handler needs zero shape change for v2** — the params type
(`{sessionId, _meta?}`) and notification semantics are identical; only the *v2 method registration*
(on the new `v2Agent` chain, using `acpV2.methods.agent.session.cancel`) needs to be added,
delegating to the same `cancel()` method.

### Where the actual abort machinery lives (shared, version-agnostic)

- **`interruptSessionTurn`** (`CodexAcpServer.ts:2743` onward) → `getInterruptibleTurnId` →, if a
  turn is live or about to start, `requestTurnInterrupt` (`:2694-2733`) issues
  `codexAcpClient.turnInterrupt({threadId, turnId})` (an app-server RPC), with a small
  retry-on-"no active turn yet" loop (`NO_ACTIVE_TURN_RETRY_DELAYS_MS`) to close the race where
  `session/cancel` arrives before the turn is registered app-server-side (comment at `:2720-2724`:
  "Dropping the cancel here would let the turn run to completion and answer `end_turn`, which ACP
  forbids after a `session/cancel`" — this comment is v1-worded but the underlying *rule* —
  `ACP-CANCEL-203`'s "never a non-cancelled stopReason after cancel" — is identical in v2).
- **`observePromptRequestCancellation`** (`:2637-2666`) wires an externally-provided `AbortSignal`
  (from the still-pending `session/prompt` RPC call's cancellation, v1's own JSON-RPC-level
  cancellation path — not `session/cancel`) to the same `requestTurnInterrupt` logic. This is a
  *different* trigger than `session/cancel()` (it's `$/cancel_request` on the `session/prompt`
  request itself, a client-initiated JSON-RPC-level cancel of the RPC call, separate from the
  ACP-level `session/cancel` notification) but converges on the same abort path — worth noting as
  an existing, second cancellation entry point that already exists independent of this topic's
  primary `session/cancel` handler, and is unaffected by v1/v2 (JSON-RPC-level `$/cancel_request` is
  identical in both, per §2).
- **`activePrompt.signal`** (an `AbortController`-backed signal created per `prompt()` invocation,
  `:2587`) is the actual runtime signal threaded through the whole turn body
  (`CodexAcpServer.ts:2873,2879,2908,2952,...,3227`) to short-circuit every `await` point and route
  to `cancelledPromptResponse()` (v1's `{stopReason:"cancelled"}` literal, `:3330-3336`).
- **Turn-completion detection**: `turn.status === "interrupted"` off the app-server's own
  `turn/completed` notification (surfaced via `CodexAppServerClient.runTurn`'s
  `awaitTurnCompleted`, and independently read for compaction bookkeeping in
  `CodexEventHandler.ts:464`: `turn.status === "interrupted" ? "cancelled" : "failed"`). There is no
  separate "turn_aborted" event from Codex's app-server — interruption is signaled purely via
  `turn/completed` carrying `status: "interrupted"`, confirmed by grepping `CodexEventHandler.ts`
  for abort/interrupt/cancel handling (only compaction/subagent cleanup branches exist; no dedicated
  cancellation-event branch beyond reading this one status value, matching the prompt-lifecycle
  topic's milestone-(b) finding that `stopReason` decision logic lives entirely in
  `CodexAcpServer.prompt()`, not in the event handler).

### Pending-permission-request cancellation — already implemented, via the SDK's generic `cancellationSignal`, unrelated to `session/cancel` itself

This is the key finding for the "permission-request cancellation interaction" part of this topic's
scope. `src/permissions/lifecycle.ts` (`PermissionLifecycleContext`/`PermissionPromptContext`) —
read in full — contains **no** cancellation logic at all; it exists purely for MCP tool-call-id /
file-change / command-name correlation, confirming the prompt-lifecycle topic's milestone-(b)
finding that there is no "blocked" flag to reuse here.

The actual cascade happens one layer up, in `CodexApprovalHandler`:

```ts
// CodexAcpServer.ts:2870-2874
const approvalHandler = new CodexApprovalHandler(
    this.connection,
    permissionContext,
    activePrompt.signal,   // <-- the same AbortSignal session/cancel triggers
);
```

```ts
// permissions/CodexApprovalHandler.ts:105-111
private requestPermission(request: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    return this.connection.request(
        acp.methods.client.session.requestPermission,
        request,
        undefined,
        this.cancellationSignal ? {cancellationSignal: this.cancellationSignal} : undefined,
    );
}
```

`connection.request(..., {cancellationSignal})` is generic SDK machinery
(`acp-typescript-sdk/src/jsonrpc.ts:1120-1136`, `prepareRequest`): when `cancellationSignal` aborts,
the SDK automatically calls `sendCancelRequest(id)` — i.e. **it sends `$/cancel_request` for that
specific pending outbound request** exactly as `cancellation.mdx`'s cascade diagram describes. Since
`activePrompt.signal` is the same signal `observePromptRequestCancellation`/`interruptSessionTurn`
abort on `session/cancel`, **codex-acp already implements the cascading `$/cancel_request` behavior
for pending `session/request_permission` calls today, as a side effect of generic SDK wiring, not
bespoke cancellation code.** `CodexElicitationHandler` is constructed identically
(`CodexAcpServer.ts:2875-2880`, same `activePrompt.signal`), so `elicitation/create` requests get
the same treatment.

Separately, `CodexApprovalHandler.ts:114,123` (`selectedDecision`/`rejectPermissionsResponse`)
already handles the case where the **Client** independently resolves a pending permission request
with `{outcome: "cancelled"}` per the Client's own MUST-obligation (`prompt-lifecycle.mdx:544`) —
this response-shape handling is unchanged v1→v2 since `RequestPermissionResponse`'s outcome shape
(`selected`/`cancelled`) is confirmed unchanged by the prompt-lifecycle topic's citation of
`migration.mdx:528`.

**Conclusion: the permission-request/cancel interaction requires no new code for v2.** Both the
SDK-level `$/cancel_request` cascade (via `connection.request`'s `cancellationSignal` option,
already wired to `activePrompt.signal`) and the client's own `cancelled`-outcome handling are
version-agnostic JSON-RPC/connection-layer mechanisms untouched by the v1/v2 split — they will work
identically for a v2 `session/prompt`'s permission requests once `activePrompt.signal` (or its v2
successor abort signal) is threaded through the same `CodexApprovalHandler`/`CodexElicitationHandler`
constructors from the v2 turn-execution path.

### `session/close` cancels in-flight work today — same pattern needed for v2's `ACP-CLOSE-202`

`closeSession` (`CodexAcpServer.ts:899-919`) already `await`s `interruptSessionTurn(sessionState,
"Close", true)` **before** responding `{}` — i.e. v1's close already blocks on cancellation
completing. This satisfies `ACP-CLOSE-202`/`ACP-CANCEL-208`'s requirement structurally; the only
v2-specific addition is that the interrupt path must also emit the idle `state_update` (once that
mechanism exists per the prompt-lifecycle topic), which `session/close`'s existing blocking-await
shape accommodates without restructuring — `session/close`'s own response (`{}`) and the idle
`state_update` are independent channels, so no new synchronization is needed beyond what
`interruptSessionTurn` already provides.

## 5. Dual-version lens: can one abort-triggering code path drive both a v1 ack and a v2 idle `state_update`?

**Yes — and unlike the `initialize` topic (cheap, parallel construction) or the prompt-lifecycle
topic (genuinely two turn-execution flavors), this topic sits at the cheap end once the
prompt-lifecycle topic's core decoupling work is done.** The abort *trigger* — `session/cancel` →
`interruptSessionTurn` → `codexAcpClient.turnInterrupt` → app-server `turn/completed` with
`status: "interrupted"` — is **100% shared and requires zero forking**: it's already
version-agnostic (nothing about it reads or depends on `clientCapabilities`/`protocolVersion`), and
the wire contract for the trigger itself (`session/cancel`'s shape) is identical in both versions
(§1). The `$/cancel_request` cascade for pending permission requests is likewise fully shared,
already implemented, and needs no version branch (§4).

**The one fork is exactly where the prompt-lifecycle topic already identified it must be: at the
"turn ended, now report the outcome" boundary**, not inside cancellation logic itself:

- **v1**: the `interruptSessionTurn` call inside `cancel()` already returns void; the *actual* v1
  ack is `cancelledPromptResponse()` (`:3330-3336`), constructed and returned from wherever
  `prompt()`'s own `await` chain observes `activePrompt.signal.aborted` or
  `turnCompleted.turn.status === "interrupted"`. This is v1's existing, unchanged code path — no
  new work in this topic for v1.
- **v2**: the same abort signal / same `turn.status === "interrupted"` observation needs to route to
  a `session/update` notification (`{sessionUpdate:"state_update", state:"idle",
  stopReason:"cancelled"}`) instead of a return value, from whatever background turn-execution task
  the prompt-lifecycle topic's milestone (a)/(c) decoupling produces. **This is not new design work
  for the cancellation topic** — it is the exact same "idle `state_update` with `stopReason`" fork
  point milestone (b) already designed (`v2-prompt-lifecycle-and-turn-state-machine.md` §6.4:
  "wrap it in a `session/update` notification... at the same point `prompt()` currently constructs
  and returns the v1 response"), just exercised via the cancellation branch (`stopReason:"cancelled"`)
  of that same two-value mapping instead of the normal-completion branch (`stopReason:"end_turn"`).
- **The SDK's own worked example confirms this exact shape is trivial to implement once the
  turn-execution split exists**: `acp-typescript-sdk/src/examples/dual-version-agent.ts:139-141,
  171-179,251-264` shows a v2 `session/cancel` notification handler that does nothing but
  `controller.abort()` and `await turn.done`, where the turn's own `catch` block (guarded by
  `signal.aborted`) sends the idle-cancelled `state_update` — i.e. the reference implementation
  treats "cancel" and "the thing that reports the outcome" as two different code locations
  connected only by an `AbortSignal`, exactly matching codex-acp's own existing v1 structure
  (`observePromptRequestCancellation` aborts a signal; a *different* piece of code —
  `cancelledPromptResponse()` — reports the outcome by reading that same signal/turn status).

**Cost/risk verdict: low, and it is a strict subset of the prompt-lifecycle topic's own risk, not
an independent risk.** Concretely for this topic's own deliverable:

1. `cancel()` itself (`CodexAcpServer.ts:3413-3422`): **zero change**. Register the same method on
   the v2 chain; the notification handler body is 100% shared.
2. `interruptSessionTurn`/`requestTurnInterrupt`/`getInterruptibleTurnId`: **zero change** — these
   operate purely on internal `SessionState`/turn-id bookkeeping, never on ACP-version-specific
   types.
3. `CodexApprovalHandler`/`CodexElicitationHandler`'s `cancellationSignal`-driven `$/cancel_request`
   cascade: **zero change** — already generic, needs only to be constructed from whatever abort
   signal the v2 turn-execution path uses (likely the same `AbortController`/`activePrompt.signal`
   equivalent milestone (a)/(c) already needs to build for other reasons).
4. The only genuinely new code this topic requires is the small "if v2, emit idle
   `state_update{stopReason:"cancelled"}` instead of/in addition to returning
   `cancelledPromptResponse()`" fork — and that fork's *location and shape* were already fully
   designed by the prompt-lifecycle topic's milestone (b); this topic does not need to invent a new
   mechanism, only apply the existing one to the cancellation branch of the existing two-value
   `end_turn`/`cancelled` decision.
5. `session/close`'s existing blocking-await-then-respond shape (`closeSession`,
   `CodexAcpServer.ts:899-919`) needs no restructuring for `ACP-CLOSE-202`/`ACP-CANCEL-208` — it
   already serializes on `interruptSessionTurn` completing before responding; the idle
   `state_update` fires from the same underlying turn-completion path independent of the `{}`
   response.

**Bottom line: no separate abort-logic fork is needed between v1 and v2 — only the
already-designed response/notification fork (owned by the prompt-lifecycle topic) needs to also
carry the `cancelled` stop reason, which it already does by construction (both branches of the
`end_turn`/`cancelled` decision route through the same fork point).** This topic's residual
implementation work is essentially: (a) register `session/cancel` on the v2 chain (trivial), (b)
make sure whatever abort/turn-tracking object milestone (a)/(c) introduces for v2's
background-continuing turn execution is the one `CodexApprovalHandler`/`CodexElicitationHandler`
and `interruptSessionTurn` get wired to (a wiring/threading detail, not new logic), and (c) verify
`session/close`'s existing cancel-then-respond behavior still emits the idle `state_update` once
that notification exists. No new decision logic, no new data structures, no protocol-shape
ambiguity, and no TCK requirement in this topic's list demands behavior codex-acp doesn't already
implement for the *trigger* half of cancellation — only the *acknowledgment* half needs the (already
designed elsewhere) notification fork.

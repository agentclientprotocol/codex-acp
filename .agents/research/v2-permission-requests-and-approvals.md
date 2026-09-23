# v2 topic: Permission requests & approvals

Spec checked at `agent-client-protocol` local checkout, commit `8c90bb7` ("docs: update registry
agents (#2217)"), `git pull --ff-only` reported "Already up to date" this run. SDK checked against
`acp-typescript-sdk`: local checkout stuck at `f1c0141` (same pre-existing dirty
`package-lock.json` blocker the sibling topics hit — `git pull --ff-only` fails, not repaired here
per this run's read-only authorization); compensated with `git fetch origin main` (read-only) and
read via `git show origin/main:<path>`, tip `69fda37`. Installed npm package in codex-acp:
`@agentclientprotocol/sdk@1.4.0`. TCK checked at
`/Users/eugene/Documents/JetBrains/projects/acp-tck/src/tck/v2/requirements.py`.

## 1. The shape change: v1 bare `toolCall` vs v2 `title`/`description`/`subject`

### v1 (installed `@agentclientprotocol/sdk` root export, `acp.RequestPermissionRequest`)

```ts
type RequestPermissionRequest = {
  sessionId: string;
  toolCall: ToolCallUpdate;   // bare — no title/description/subject fields exist at all
  options: PermissionOption[];
  _meta?: {...} | null;
};
```

There is no `title`/`description` field in v1 — codex-acp puts prompt copy either into
`toolCall.title` (commands, additional-permissions, plan-review) or drops a separate
`_meta.requestPermissionMeta(...)` blob (`src/permissions/metadata.ts`, read for context; carries
`CODEX_COMMAND_PERMISSION_TITLE`/`CODEX_FILE_CHANGE_PERMISSION_TITLE`/etc. plus `reason`) alongside
the bare toolCall. v1's `toolCall` is *always* present and is always a genuine
`acp.ToolCallUpdate` shape, even when the underlying operation isn't really a tool call (plan
review uses `kind: "switch_mode"`; MCP elicitation "question" prompts use `kind: "other"`/`kind:
"fetch"`).

### v2 (`docs/protocol/v2/tool-calls.mdx:196-256`, `migration.mdx:478-530`, schema
`$defs/RequestPermissionRequest`/`RequestPermissionSubject`/`ToolCallPermissionSubject`/
`CommandPermissionSubject`)

```json
{
  "method": "session/request_permission",
  "params": {
    "sessionId": "sess_abc123",
    "title": "Run this script?",
    "description": "The agent wants to execute scripts/setup.sh in your project.",
    "subject": {
      "type": "tool_call",
      "toolCall": { "toolCallId": "call_001", "title": "Execute setup script", "kind": "execute", "status": "pending" }
    },
    "options": [
      { "optionId": "allow", "name": "Allow once", "kind": "allow_once" },
      { "optionId": "deny", "name": "Deny", "kind": "reject_once" }
    ]
  }
}
```

```ts
type RequestPermissionRequest = {
  sessionId: SessionId;
  title: string;                              // REQUIRED — new field, prompt-prose only
  description?: string | null;                // optional prompt-prose only
  subject?: RequestPermissionSubject | null;   // optional structured context
  options: PermissionOption[];
  _meta?: {...} | null;
};

type RequestPermissionSubject =
  | (ToolCallPermissionSubject & {type: "tool_call"})   // {toolCall: ToolCallUpdate}
  | (CommandPermissionSubject & {type: "command"})      // {command, cwd, toolCallId?, terminalId?, _meta?}
  | {type: string; [key: string]: unknown};              // open/custom (`_`-prefixed reserved for extensions)
```

**Only two named subject variants exist in stable v2: `tool_call` and `command`.** Confirmed by
grepping `schema/v2/schema.json` `$defs` for every symbol containing `Subject`/`permission`: the
only concrete subject `$defs` are `RequestPermissionSubject`, `ToolCallPermissionSubject`,
`CommandPermissionSubject` — **there is no `plan_review` (or any other named) subject type**. A
plan-approval permission request in v2 has exactly three legal encodings: (a) omit `subject`
entirely and rely on `title`/`description` alone, (b) misuse `subject.tool_call` the same way v1
does today (a `ToolCallUpdate` with `kind: "switch_mode"`, which is a legitimate `ToolKind` value
in both v1 and v2 schemas — confirmed present in `$defs/ToolKind`'s `anyOf`), or (c) a custom
`_`-prefixed subject type (an ACP extension, not interoperable with generic clients). Key rule
differences from v1, each cited:

- **`title` moves out of `toolCall` into a dedicated, required, top-level field** —
  `migration.mdx:508,512`: "In v1, agents routinely stuffed permission prompt text into the tool
  call's `title`, mutating displayed tool state as a side effect. In v2, put prompt copy in
  `title`/`description` and let `subject.toolCall` carry only genuine tool-call state." This is a
  correctness fix codex-acp's v1 code violates today at every one of its 4 call sites (see §4):
  `commandToolCall`/`fileChangeToolCall`/`additionalPermissionsToolCall`/
  `planImplementationPermissionRequest` all set `toolCall.title` to prompt copy
  (`"Approve file edit?"`-style text), which v2 explicitly says must move to the new `title` field
  instead, leaving `subject.toolCall.title` (if set at all) as genuine tool-call display state.
- **`subject` is optional and open** — `tool-calls.mdx:244-251`: "Custom or future subject types
  may appear. Clients that do not understand a subject should preserve it when proxying and use
  the common prompt fields or decline according to policy." So an agent may always fall back to
  `title`/`description`-only with no `subject` at all — this is the safe minimal migration path
  for anything that doesn't cleanly fit `tool_call`/`command`.
- **`command` is a new, self-contained subject** — not a patch onto an existing tool call:
  `command`+`cwd` (absolute) required, `toolCallId`/`terminalId`/`_meta` optional/nullable.
  "Approval authorizes the Agent to execute the command; it never asks the Client to execute it"
  (`migration.mdx:526`). codex-acp's v1 command-approval flow already builds a `rawInput.command`
  field on the toolCall (`presentation.ts:24-31`) — v2's `command` subject is a cleaner, purpose-
  built home for exactly that data, without needing to fabricate a full `ToolCallUpdate`.
- **Options/response unchanged** — `migration.mdx:528`: same `optionId`/`name`/`kind` shape,
  same `{outcome: "selected", optionId}` / `{outcome: "cancelled"}` response union. Confirmed at
  schema level (`$defs/PermissionOption`, `$defs/RequestPermissionOutcome`,
  `$defs/SelectedPermissionOutcome` — byte-identical field sets to what codex-acp already produces
  and consumes in v1). **No change needed to `CodexApprovalHandler.selectedDecision`/
  `permissionsResponse`/`planImplementationApproved` response-parsing logic** — they already read
  `response.outcome.outcome`/`response.outcome.optionId` exactly as v2 requires.
- **`requires_action` linkage is explicit spec text, not inferred**: `migration.mdx:530`: "While a
  permission request is pending, the Agent **SHOULD** report `state_update` with
  `requires_action`, and `running` again once resolved." This is the same rule the sibling
  prompt-lifecycle topic already found in `prompt-lifecycle.mdx:398-400` — restated here directly
  in the permissions section of `migration.mdx`, confirming it's this topic's obligation too, not
  purely the prompt-lifecycle topic's.

### SDK type-generation check: no gap here

Installed `@agentclientprotocol/sdk@1.4.0`
(`node_modules/@agentclientprotocol/sdk/dist/v2/schema/types.gen.d.ts:30-105`) already has the
correct, current `RequestPermissionRequest`/`RequestPermissionSubject`/`ToolCallPermissionSubject`/
`CommandPermissionSubject`/`RequestPermissionResponse`/`RequestPermissionOutcome`/
`SelectedPermissionOutcome` types, verified identical in shape to `origin/main`
(`acp-typescript-sdk` `69fda37`, `src/v2/schema/types.gen.ts:53-99,827-855,6206-6260`). **Unlike
the sibling prompt-lifecycle topic's `PromptResponse.messageId` staleness finding, there is no SDK
bump prerequisite specific to this topic's types.** (The `1.4.0`→`1.5.0` bump is still needed
overall for the prompt-lifecycle topic's `messageId` fix; nothing extra needed here.)

## 2. TCK requirement texts (`acp-tck/src/tck/v2/requirements.py`)

- **`ACP-PERM-201`** (`Tier.CAPABILITY`, `capability="capabilities.session"`, lines 318-335): "Any
  `session/request_permission` request the agent sends during a turn validates: `sessionId`, a
  non-empty string `title`, and a non-empty `options` array, each option carrying
  `optionId`/`name`/`kind`. Once the client answers with a `selected` outcome, the turn still
  reaches an idle. Vacuous (SKIPPED) when no permission request was observed during the turn —
  sending one is only MAY." Cites `schema/v2/schema.json:545` (required `["sessionId","title",
  "options"]`, `options.minItems:1`), `:1999` (`PermissionOption` required fields),
  `tool-calls.mdx:194,233,253`. **Directly actionable**: codex-acp's v1 requests never set a
  top-level `title` today (v1 has no such field) — the v2 request-construction fork MUST add one
  at all 4 call sites, non-empty, or this row FAILs outright once a v2 client is exercised.
- **`ACP-CLIENTCAP-201`** (`Tier.CAPABILITY`, `capability="capabilities.session"`, lines 336-348):
  "With a mock client advertising no `capabilities.elicitation.*` mode, no `elicitation/create`
  request is observed during a prompt turn." Not directly about `request_permission`'s shape, but
  adjacent: codex-acp's MCP elicitation path (`src/permissions/mcp.ts`) currently maps *all* MCP
  server elicitation onto `session/request_permission` (not `elicitation/create`) regardless of
  client capability — this row is about the separate `elicitation/create` method, and confirms
  codex-acp's existing choice (routing MCP prompts through permission requests, not elicitation)
  remains conformant in v2 as long as it never emits `elicitation/create` unsolicited. No change
  needed to `mcp.ts`'s existing strategy on this account.
- **`ACP-CLIENTCAP-202`** (`Tier.CAPABILITY`, `capability="capabilities.session"`, lines 349-365):
  "Every agent->client request/notification method observed during a prompt turn is a member of
  `CLIENT_METHODS` or `PROTOCOL_METHODS`... `fs/*`/`terminal/*` do not exist as v2 methods at all."
  Relevant here only as a general-hygiene check: `session/request_permission` itself is a defined
  v2 `CLIENT_METHODS` entry, so codex-acp's 4 call sites (unchanged method name) stay conformant;
  nothing about permission requests specifically trips this row.
- **`ACP-PATCH-209`** (`Tier.ADVISORY`, `capability=None`, lines 1239-1251, cite
  `prompt-lifecycle.mdx:371`): "While blocked on a `session/request_permission` response, the
  agent reports `state_update.state == "requires_action"`, and reports `"running"` again once it
  resumes. Kept ADVISORY, not promoted to CAPABILITY under the session-baseline tiering rule — the
  corresponding test is still `@pytest.mark.capability("capabilities.session")`-gated for its own
  SKIP." **This is the direct TCK anchor for the requires_action-bracketing design in §5** — it is
  ADVISORY (a SHOULD in spec text, per `migration.mdx:530`'s own wording), not MANDATORY/CAPABILITY-
  strict, so a codex-acp v2 implementation that skipped it would not hard-FAIL the TCK, but would
  visibly under-conform relative to the spec's stated design intent and would leave clients unable
  to distinguish "agent thinking" from "agent waiting on you" — worth doing anyway.
- **`ACP-ENUM-203`** (`Tier.ADVISORY`, `capability=None`, lines 1286-1299, cite
  `extensibility.mdx:115,122`): "A `_`-prefixed value at an open-enum site the client sends (here:
  `session/request_permission`'s answered `outcome`) is tolerated by the agent — no crash, and the
  prompt itself is not answered with `-32602`. Untestable how the agent treats the value
  internally; only survival is checked." **Directly actionable for
  `CodexApprovalHandler.selectedDecision`/`permissionsResponse`/`planImplementationApproved`**: all
  three today pattern-match on `response.outcome.outcome === "cancelled"` else assume `"selected"`
  and read `.optionId` — if a v2 client answers with a custom `_foo`-prefixed outcome (or any
  outcome that is neither `"cancelled"` nor `"selected"`), today's code would read `.optionId` off
  an object shape that doesn't guarantee it exists, which is a **type-unsafe read, not just a
  spec-conformance gap** — v2's `RequestPermissionOutcome` open union means `optionId` is only
  present on the `"selected"` variant. This must be hardened (a defensive `outcome.outcome ===
  "selected"` check, not an `!== "cancelled"` inverse) as part of the v2 request/response handling,
  regardless of whether it's shared with v1's already-narrower type.

## 3. Current codex-acp v1 implementation — where and how `toolCall`-shaped requests are built today

All 4 call sites construct a bare `acp.RequestPermissionRequest = {sessionId, toolCall, options,
_meta?}` and send it via `this.connection.request(acp.methods.client.session.requestPermission,
request, ...)`. Read in full: `CodexApprovalHandler.ts`, `lifecycle.ts`, `presentation.ts`,
`options.ts`, `option-ids.ts`, `command-decision-contract.ts`, `plan-review.ts`, `mcp.ts`.

1. **`CodexApprovalHandler.ts:51`**, inside `handleCommandExecution` — calls the shared
   `requestPermission` helper (`:105-111`) with `toolCall: commandToolCall(authoritativeParams,
   this.permissionContext)` (`presentation.ts:18-54`). `commandToolCall` builds a genuine
   `acp.ToolCallUpdate` (`kind: "execute"`, `status: "pending"`, `rawInput: {command, cwd, url?,
   additionalPermissions?}`, `locations`, optional `content`) **and sets `title` to prompt copy**
   (`"${protocol} network access to ${host}"` or `commandTitle(...)` — e.g. `"Run command"`,
   `"Read file"`) — this is exactly the v1 anti-pattern `migration.mdx:512` calls out.
   `options: decisions.map(...)` from `commandDecisionOptions` (`options.ts:16-87`, itself sourced
   from `command-decision-contract.ts`'s `parseAvailableCommandDecisions`/
   `defaultCommandDecisions`/`parseCommandDecision`, which decide the *available decision set*
   from Codex app-server's own `availableDecisions`/network/execpolicy-amendment context — entirely
   decision/option *content* logic, independent of the wire request shape).
2. **`CodexApprovalHandler.ts:70`**, inside `handleFileChange` — same helper, `toolCall:
   fileChangeToolCall(params, this.permissionContext)` (`presentation.ts:56-68`, `kind: "edit"`,
   `title: "Edit files"` — same anti-pattern), `options: fileChangeDecisionOptions()`
   (`options.ts:95-111`, a static 3-option list).
3. **`CodexApprovalHandler.ts:87`**, inside `handlePermissionsRequest` — same helper, `toolCall:
   additionalPermissionsToolCall(itemId, cwd, environmentId, permissions)`
   (`presentation.ts:70-87`, `kind: "other"`, `title: "Additional sandbox permissions"`),
   `options: permissionProfileOptions()` (`options.ts:113-136`, static 4-option list).
4. **`CodexAcpServer.ts:3306-3310`** (`requestPlanImplementationPermission`, `:3299-3324`) — the
   one call site *not* routed through `CodexApprovalHandler`; calls `this.connection.request(...)`
   directly with `planImplementationPermissionRequest(sessionState.sessionId, plan)`
   (`plan-review.ts:7-30`): `toolCall: {toolCallId: planImplementationToolCallId(plan), title:
   "Implement this plan?", kind: "switch_mode", status: "pending", rawInput: {plan: plan.text}}`,
   `options: [implement_plan, revise_plan]` (static, defined inline in `plan-review.ts`), `_meta:
   {codex: {kind: "plan_review", planItemId: plan.itemId}}`. **This is codex-acp's own,
   already-existing `_meta`-tagged convention for marking a permission request as a plan review**
   — `{codex: {kind: "plan_review", ...}}` — distinct from and unrelated to any protocol-level
   `subject` union; it's purely an internal marker read nowhere else in the 4 call sites (grep
   confirms no other file reads `_meta.codex.kind`), i.e. currently write-only/informational.
   After the response, this call site also sends a `tool_call_update` `session/update`
   (`:3312-3322`) marking the same `toolCallId` `"completed"` with `rawOutput` text describing the
   decision — this pairs naturally with whichever `state_update` bracketing is added (§5), since
   both are side effects of the same `await this.connection.request(...)` resolving.

**A fifth, MCP-elicitation-routed family also produces `RequestPermissionRequest`s, but not
through `CodexApprovalHandler`** — `src/permissions/mcp.ts`'s `buildMcpPermissionRequest`
(`:87-149`) is called from elsewhere (not read in this run; out of the 4-call-site count per the
task's own framing, and not itself one of the four `session/request_permission` call sites the
milestone-(b) research enumerated — it is presumably invoked from a different top-level dispatcher
that itself performs the `connection.request(...)` call, structurally analogous to the 4 sites but
outside this run's read scope). It also builds a bare `toolCall` (`kind: "execute"`/`"other"`/
`"fetch"` depending on MCP elicitation mode) with prompt copy folded into `toolCall.title`/
`content`, and reads back via `convertMcpPermissionResponse` (`:151-182`) on
`response.outcome.optionId` after checking `outcome.outcome === "cancelled"` — same
type-unsafety-under-open-outcome-union issue as §2's `ACP-ENUM-203` finding, and same v1
anti-pattern (prompt copy folded into `toolCall.title`) as the 4 main call sites.

## 4. `PermissionLifecycleContext`/`PermissionPromptContext` — confirmed, no blocked-state signal

`src/permissions/lifecycle.ts` (56 lines, read in full) provides exactly two session/prompt-scoped
correlation stores — `PermissionLifecycleContext` (session-scoped, only tracks a
`permissionRequestSequence` counter for standalone MCP tool-call ids) and `PermissionPromptContext`
(prompt-scoped, tracks `commandNames`/`fileChanges`/`pendingMcpApprovals` maps keyed by
`threadId`/`itemId`, fed by `item/started`/`item/completed`/`turn/completed`/
`serverRequest/resolved` notifications). **Neither tracks "is a permission request currently
in-flight."** This confirms and does not change the sibling prompt-lifecycle topic's finding
(`v2-prompt-lifecycle-and-turn-state-machine.md` §6.5): the only signal available today that a
permission request is pending is the bare fact that one of the `connection.request(...)` calls
above has an unresolved promise — there's no boolean, counter, or event to hang `requires_action`
off of without adding one (or, more simply, just bracketing the call sites directly, per §5).

## 5. Concrete `requires_action` bracketing design

For each of the 4 call sites, wrap the `session/request_permission` RPC call with a
`state_update` `session/update` notification pair. Concretely:

- **Before** the request is sent: emit
  `{sessionId, update: {sessionUpdate: "state_update", state: "requires_action"}}`.
- **After** the request settles — success (`"selected"` or `"cancelled"` outcome), OR the
  `try`/`catch` error path each of the 4 sites already has (`CodexApprovalHandler.ts:61,77,99`
  catch blocks; `CodexAcpServer.ts:3324` catch, not shown above but present per milestone-(b)'s
  earlier read) — emit `{sessionId, update: {sessionUpdate: "state_update", state: "running"}}`.
  **All three outcomes (granted, denied, cancelled/errored) count as "resumed"** — the mermaid
  diagram in `prompt-lifecycle.mdx` does not distinguish granted vs. denied for the state
  transition, only for what happens next in the turn, and this run's read of all 4 catch blocks
  confirms none of them leave the turn permanently stuck (they all fall back to a safe default
  decision and continue), so `running` is always the correct next state regardless of branch.

**Where to put the bracketing, concretely, given what this run found:**

- **3 of the 4 sites (`CodexApprovalHandler.ts:51,70,87`) already funnel through one shared private
  method, `requestPermission` (`:105-111`).** Wrapping *that one method* brackets all 3 in one
  place — no per-call-site duplication needed for the `CodexApprovalHandler`-owned sites. This
  requires `CodexApprovalHandler` to be given a way to emit `session/update` notifications (it
  already holds `private readonly connection: AcpClientConnection` at `:35`, and `presentation.ts`/
  the class itself never currently calls `connection.notify(...)` — only `connection.request(...)`
  — so this is a new capability for the class, not a rewire of an existing one). It also needs the
  session's *own* `sessionId` for the notification's `sessionId` field — already available as
  `params.threadId`/`params.sessionId`, whichever the ACP-vs-Codex naming convention resolves to
  at that call site (confirmed as `params.threadId` is used as `sessionId` in the existing
  `requestPermission(...)` calls at `:52,71,88`, so the same field is available for the bracketing
  notification with no new plumbing).
- **The 4th site (`CodexAcpServer.ts:3306`, `requestPlanImplementationPermission`) is a private
  method on `CodexAcpServer` itself**, which already calls `this.connection.notify(...)` two lines
  after the request resolves (`:3312`, the `tool_call_update` "completed" notification) — bracketing
  here is trivial: add a `requires_action` notify immediately before `:3306`'s
  `this.connection.request(...)` call, and fold the `running` notify into (or send immediately
  alongside) the existing post-response `tool_call_update` notify at `:3312-3322`.
- **The MCP-elicitation path (`src/permissions/mcp.ts`, called from an unread dispatcher — see §3)**
  is a 5th, not-formally-in-scope site by the task's own 4-site framing, but is structurally
  identical (a `connection.request(session.requestPermission, ...)` call somewhere) and should get
  the same bracketing treatment for consistency once its call site is located — flagged as a
  residual follow-up, not designed in detail here since this run's scope was the 4 named sites.

**Does a second, concurrent permission request need special handling?** Per this run's reading of
`PermissionPromptContext`/`PermissionLifecycleContext` (§4) and the sibling prompt-lifecycle
topic's finding that `activePrompts`/turn-tracking is single-flight-assumed today: **within one
active turn, only one of the 4+1 call sites is realistically reachable at a time** in codex-acp's
current architecture (a command-execution approval, file-change approval, permissions-request
approval, and plan-review approval are all triggered from mutually exclusive points in one turn's
execution — a turn is either running a command, applying a file change, requesting sandbox
permissions, or presenting a completed plan, not several simultaneously), and MCP tool-call
approvals are serialized per-tool-call via `pendingMcpApprovals`'s single-pending-per-server
correlation (`lifecycle.ts:59-68`, `popPendingMcpApproval` only succeeds when exactly one is
pending). **A naive "requires_action on enter, running on exit" bracket per call site is therefore
safe without a reference-counter or stack**, because overlapping concurrent permission requests for
the *same session* are not a case the current architecture produces. The one scenario worth flagging
as a **residual risk, not solved here**: if the milestone (c) recommendation from the sibling
prompt-lifecycle topic (injecting/queueing a second `session/prompt` into an already-running turn
via `SteeringQueue`) is implemented, and a permission request happens to be pending at the moment a
second prompt is queued/injected, a naive per-call-site bracket could still emit `running` when the
*first* request resolves even though a hypothetical second request is now pending — but per this
run's read, nothing in `src/permissions/` or `SteeringQueue.ts` today creates two concurrent
`session/request_permission` calls for one session, so this is a forward-looking caveat to revisit
if/when milestone (c)'s convergence design lands, not a gap in the bracketing design as specified
against today's call graph. If it becomes a real risk, the fix is a per-session in-flight counter
(increment before request, decrement after; only emit `running` when the counter reaches zero) —
cheap to add later, not needed today.

## 6. Dual-version lens: can v1 and v2 share the permission-decision logic?

**Yes, with a request-construction fork — this is the *cheap* half of the topic, structurally like
the `initialize` topic, not like `prompt()`'s turn-lifetime coupling.** The actual decision-making
logic — `commandDecisionOptions`/`fileChangeDecisionOptions`/`permissionProfileOptions`
(`options.ts`), `parseAvailableCommandDecisions`/`defaultCommandDecisions`/`parseCommandDecision`
(`command-decision-contract.ts`), `ApprovalOptionId`/`McpApprovalOptionId` (`option-ids.ts`), and
the response-parsing (`selectedDecision`/`permissionsResponse`/`grantedPermissionsResponse`/
`planImplementationApproved`/`convertMcpPermissionResponse`) — is **entirely independent of the
request wire shape**. It operates on `acp.PermissionOption[]`/`acp.PermissionOptionKind` (unchanged
between v1 and v2) and on the response `outcome` union (unchanged fields, just an open union in v2
— see `ACP-ENUM-203` hardening note in §2). None of these functions read or construct `toolCall`,
`title`, `description`, or `subject` themselves — that's confined to
`presentation.ts`/`plan-review.ts`/`mcp.ts`'s request-*building* functions.

**The fork is exactly at the boundary these files already establish**: `presentation.ts`'s
`commandToolCall`/`fileChangeToolCall`/`additionalPermissionsToolCall` and `plan-review.ts`'s
`planImplementationPermissionRequest` currently do two things conflated into one v1-shaped return
value — (a) build a genuine tool-call-state `ToolCallUpdate`, and (b) decide prompt copy (titles).
For v2, split (b) out: each of these functions needs a v2-shaped sibling (or an internal branch)
that returns `{title, description?, subject}` instead of a bare `toolCall`, where:

- **Command/file-change/additional-permissions requests → `subject: {type: "tool_call", toolCall:
  {...}}`**, with the *same* `ToolCallUpdate` object these functions already build, minus the
  `title` field (which moves to the new top-level `title`) — e.g. `commandTitle(...)`'s return
  value becomes the v2 request's top-level `title`, not `toolCall.title`. This is close to a
  pure move, not a new decision. **Optionally**, command execution could instead use `subject:
  {type: "command", command, cwd, toolCallId, terminalId?}` for a cleaner fit (v2's purpose-built
  shape for exactly this case) — a design choice, not a requirement; either is spec-legal.
- **Plan-review requests → no clean v2 subject exists** (confirmed in §1: only `tool_call` and
  `command` are named variants; a plan approval is neither). Three legal options, in order of
  fidelity: (a) omit `subject` entirely and rely on `title: "Implement this plan?"` +
  `description` alone — simplest, loses the `rawInput.plan` display richness v1 provides via the
  toolCall; (b) keep misusing `subject.tool_call` with `kind: "switch_mode"` exactly as v1 does
  today, just relocating the prompt-copy `title` out of the nested toolCall into the new top-level
  field — preserves today's richer display, at the cost of continuing a slight semantic misfit
  (`migration.mdx`'s stated intent is that `subject.toolCall` should carry "genuine tool-call
  state," and a plan isn't really a tool call); (c) a custom `_codex/plan_review` subject type
  (an ACP extension) carrying `{planId, planText}` or similar, formalizing codex-acp's existing
  internal `_meta: {codex: {kind: "plan_review", ...}}` marker (§3) into an actual protocol-visible
  `subject.type` instead of a write-only internal note — the most correct long-term answer, but a
  new extension surface to design and document, not a free reuse of existing spec vocabulary.
  **Recommendation: start with (b)** (cheapest, preserves existing behavior/richness, spec-legal
  since `subject.tool_call` accepts any `ToolCallUpdate` including `kind: "switch_mode"`) and treat
  (c) as a later enhancement if a richer, protocol-native plan-review UI is wanted.
- **MCP elicitation-routed requests (`mcp.ts`)** — same fork shape as command/file-change: the
  `messageContent`/`rawInput` construction stays, `title` (currently `"MCP tool call approval"` /
  `"Question from MCP server"` / `"MCP server requests to open a URL"`) moves out of
  `toolCall.title` into the new top-level field, `subject.tool_call` keeps the rest.

**Cost/risk assessment:** **Low-to-moderate, cheap relative to the prompt-lifecycle topic's core
risk.** This is a value-construction fork (build a different request literal from the same
decision-option/context inputs), not a control-flow/lifetime restructuring — no async boundary,
promise-resolution-timing, or cancellation-scope change is needed anywhere in `src/permissions/`.
The `requires_action` bracketing (§5) is genuinely new code (two `connection.notify(...)` calls per
site, or one shared wrapper) but is additive and mechanical, not a redesign. The two real
judgment calls are (1) picking a plan-review subject strategy (§6, recommend option (b) above) and
(2) deciding whether to harden the outcome-union read (`ACP-ENUM-203`) as a v1+v2-shared fix or a
v2-only guard — recommend fixing it for both versions, since it's a real type-safety issue in v1's
handling too (v1's own `RequestPermissionOutcome`, per the installed SDK, is not actually a closed
union either — re-verify against v1's `acp.RequestPermissionOutcome` type if implementing, but
treat this as "fix once, benefits both" regardless). No SDK version bump is required specifically
for this topic (see §1's SDK check). **Overall: this topic is one of the migration's cheaper ones
— comparable to `initialize`'s "thin parallel-construction" cost, not `prompt()`'s "turn-lifetime
decoupling" cost** — the only moderate-complexity item is the missing plan-review subject, which
has a workable, low-risk answer (keep the existing `switch_mode` tool-call misuse pattern, just
move the title out).

## Summary for the orchestrator

- v1's bare `toolCall` request becomes v2's `{title (required), description?, subject?, options}`;
  `subject` is `{type: "tool_call", toolCall: ToolCallUpdate}` or `{type: "command", command, cwd,
  toolCallId?, terminalId?}` or a custom/omitted value — **no `plan_review` subject exists in
  stable v2**.
- All 4 named call sites (`CodexApprovalHandler.ts:51,70,87`, `CodexAcpServer.ts:3306`) currently
  violate v2's `title`-placement rule (prompt copy lives in `toolCall.title` today) — this must
  change regardless of dual-version support, since it's the exact anti-pattern `migration.mdx:512`
  calls out.
- `requires_action` bracketing: wrap `CodexApprovalHandler.ts`'s shared `requestPermission` helper
  (covers 3 of 4 sites) plus `CodexAcpServer.ts:3306` individually with `state_update:
  requires_action` before / `state_update: running` after; no in-flight counter needed against
  today's call graph (single-permission-request-at-a-time per session), revisit if milestone (c)'s
  steering/queueing convergence changes that.
- Dual-version verdict: **cheap.** Decision/option logic (`options.ts`, `option-ids.ts`,
  `command-decision-contract.ts`, response parsing) is fully version-agnostic and needs zero
  changes; only the request*-construction* functions in `presentation.ts`/`plan-review.ts`/`mcp.ts`
  need a v2-shaped sibling/branch. The only non-mechanical decision is plan-review's missing
  subject type (recommend: keep the `switch_mode` tool-call misuse, just relocate `title`). No SDK
  bump needed for this topic's types specifically.

# v2 topic: Tool calls, messages & terminal streaming

**STATUS: all 3 milestones complete.** (a) Message/tool-call upsert semantics, (b) agent-owned
`terminal_update`/`terminal_output_chunk` streaming, and (c) diff content restructuring
(`changes[]`+`patch` replacing `oldText`/`newText`) are all researched below. (b) and (c) were
completed in a follow-up run; see their sections and the final "Topic-wide verdict" at the end.

Spec checked at `agent-client-protocol` local checkout, `git pull --ff-only` → "Already up to
date" (same commit the sibling topics checked, `8c90bb7`). TCK checked at
`/Users/eugene/Documents/JetBrains/projects/acp-tck/src/tck/v2/requirements.py`. SDK checked as
installed (`@agentclientprotocol/sdk@1.4.0` in `node_modules/`) and diffed against
`acp-typescript-sdk` `origin/main` (`69fda37`; local checkout stayed at `f1c0141` — same
pre-existing `package-lock.json`-dirty-working-tree blocker the sibling topics hit, not repaired
here per the same non-destructive-git-ops constraint; `git fetch` + `git diff <local> origin/main`
used instead, read-only).

## 1. Spec: exact v1 → v2 shape change

### 1.1 The merge itself

`docs/protocol/v2/migration.mdx:66-68` (variant table):

| v1 `sessionUpdate` | v2 |
| --- | --- |
| `tool_call` | **Removed**. The first `tool_call_update` for a `toolCallId` creates the tool call |
| `tool_call_update` | Kept. Now an explicit upsert with omit/`null`/value patch semantics |
| — | **New:** `tool_call_content_chunk` for streaming individual content items |

`docs/protocol/v2/migration.mdx:345`: "v1 had `tool_call` (create) and `tool_call_update`
(modify). In practice the split bought nothing, so v2 keeps only `tool_call_update`. The first
update with an unseen `toolCallId` creates the tool call. Subsequent updates patch it. Only
`toolCallId` is required, but the Agent **SHOULD** include `title` on the first report."

`docs/protocol/v2/tool-calls.mdx:101-113` (the normative upsert-semantics paragraph, worth quoting
in full — this is the paragraph implementers actually need):
> "The `tool_call_update` notification is an upsert keyed by `toolCallId`. For existing tool
> calls, fields other than `_meta` leave the previous value unchanged when omitted, explicitly
> clear or unset the value when `null`, and replace the previous value when concrete values are
> sent. For a new `toolCallId`, omitted fields use Client defaults. `content` and `locations` are
> replaced as whole arrays; send `[]` or `null` to clear them. For `_meta`, omit the field to leave
> it unchanged or set it to `null` to clear it. Use `tool_call_content_chunk` when a tool produces
> content incrementally... For `name` specifically, omission leaves the existing name unchanged,
> `null` clears it, and a string sets or replaces it. On a new tool call, omission and `null` both
> result in no name."

`docs/protocol/v2/tool-calls.mdx:149`: "All fields except `toolCallId` are optional in updates.
Only the fields being changed need to be included." (this line is under the "Updating" heading but
applies uniformly — there is no longer a separate stricter "create" shape at all).

### 1.2 Exact field-by-field diff: v1 `ToolCall` (create) vs v1 `ToolCallUpdate` (patch) vs v2 `ToolCallUpdate` (merged)

Checked the installed v1 SDK types directly (not just docs), since this is the one place a
required-vs-optional mismatch could bite a naive merge:

- v1 `ToolCall` (create) — `node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts:3479-3537`:
  `title: string` is **required** (not optional!). `kind?: ToolKind`, `status?: ToolCallStatus`,
  `content?`, `locations?`, `rawInput?`, `rawOutput?`, `_meta?` all optional (non-nullable in the
  patch sense — v1 has no three-state omit/null/value patch model at all, these are just plain
  optional fields).
- v1 `ToolCallUpdate` (patch) — same file, `:140-196`: `toolCallId` required, every other field
  (`kind`, `status`, `title`, `name`, `content`, `locations`, `rawInput`, `rawOutput`, `_meta`)
  optional and nullable.
- v2 `ToolCallUpdate` (merged upsert) — `node_modules/@agentclientprotocol/sdk/dist/v2/schema/types.gen.d.ts:121-181`:
  only `toolCallId: ToolCallId` required. **`title` is now `title?: string | null` everywhere,
  including on the conceptual "first" emission** — the spec downgrades it from a hard MUST
  (v1's required field) to a SHOULD-include convention (`tool-calls.mdx:52`: "Agents **SHOULD**
  include the title the first time they report a `toolCallId`").

**This answers the task's item 4 directly: the one field whose required-ness changes between the
old "create" and "update" concepts is `title` — v1's create-shape required it, v2's merged upsert
makes it optional (SHOULD, not MUST) even for the first emission.** Since codex-acp's own
create-emission code (see §3 below) already always populates `title` on first emission today, this
is a pure relaxation from codex-acp's point of view — nothing it currently sends becomes invalid,
and there's no case where v2 requires something v1's create didn't already have. No other field
gains or loses required-ness between the two concepts; `kind`/`status`/`content`/`locations`/
`rawInput`/`rawOutput`/`name`/`_meta` were optional in both v1 shapes and stay optional in v2.

The one v2-only behavioral rule with no v1 analogue at all: **v2's three-state patch semantics**
(omit = unchanged, `null` = explicit clear, value = replace) apply uniformly to every field on
every emission, "create" or not — v1's `ToolCallUpdate` patch fields were nullable but the spec
never spelled out an omit/null/value three-state contract as explicitly as v2 does; v1 callers
mostly just omitted absent fields without a documented "does `null` clear or is it treated as
absent" rule. `docs/protocol/v2/migration.mdx:362-364` flags one genuine cross-version asymmetry:
"concrete names map directly between versions, but v2's `name: null` clear cannot be represented by
a v1 update because v1 treats `null` like omission. A strict adapter must reject that conversion" —
not relevant to codex-acp's own emission path (codex-acp is emitting, not adapting one wire format
into the other), but relevant if any translation layer is ever built.

### 1.3 `messageId` requirement (message-shaped `session/update` variants)

`docs/protocol/v2/migration.mdx:323-327` ("Messages and message IDs" → "Message IDs are
required"): "Every message chunk and message update in v2 **MUST** carry a `messageId`. In v1,
`messageId` was optional on chunks. Message IDs are opaque strings generated by the Agent... All
chunks of one message share one `messageId`. A changed `messageId` starts a new message."

`docs/protocol/v2/migration.mdx:329-339` ("Whole-message upserts"): v2 adds `user_message`,
`agent_message`, `agent_thought` — new upsert variants carrying a full `content` **array** (chunks
carry a single content block), keyed by `messageId`, with the identical three-state patch model
(omit/`null`-or-`[]`/concrete-array) as tool calls. "Chunks always **append** to whatever content
is current... Use chunks for streaming. Use whole-message updates for replay, correction, or
output that is already complete."

SDK confirms (`.../dist/v2/schema/types.gen.d.ts`): `ContentChunk` (the `*_chunk` payload,
`:3459-3481`) has `messageId: MessageId` **required** (no `?`), as do `UserMessage` (`:3497-3516`),
`AgentMessage` (`:3532-3551`), `AgentThought` (`:3567-3586`) — every one of them requires
`messageId`, only `content`/`_meta` are optional. `MessageId = string` (`:3455`).

### 1.4 `tool_call_content_chunk` — new streaming variant

`docs/protocol/v2/tool-calls.mdx:151-192` ("Streaming Content"): Agents **MAY** stream individual
content items with `tool_call_content_chunk` instead of resending the whole `content` array via
`tool_call_update`. Required fields: `toolCallId` (required) and `content: ToolCallContent`
(required, a single item, not an array). Composition rule (`tool-calls.mdx:185-192`, also
`migration.mdx:385`): "Clients apply `tool_call_update` and `tool_call_content_chunk` notifications
in the order they are received for each `toolCallId`. A `tool_call_content_chunk` appends its
`content` item to the current tool-call content. A later `tool_call_update` with `content` replaces
all content currently stored for that tool call, including content accumulated from earlier
chunks. Later chunks append to that replacement content. A `tool_call_update` with `content: []` or
`content: null` clears the tool-call content." — i.e. the exact same append/replace interplay as
message chunks vs. whole-message upserts (§1.3), just for tool-call content instead of message
content. `tool_call_content_chunk`'s own `_meta` is chunk-scoped, independent of the tool call's own
`_meta`.

SDK: `ToolCallContentChunk` type (`types.gen.d.ts:3734-3753`): `{ toolCallId: ToolCallId; content:
ToolCallContent; _meta?: {...} | null }` — both `toolCallId` and `content` required, matches spec
exactly.

**TCK-confirmed (`ACP-PATCH-204`, quoted in full in §2): "There is no separate tool-call 'create'
message in v2 — an update for a previously-unseen `toolCallId` is itself the create, so no
create-before-update ordering is asserted."** This is the TCK's own explicit confirmation that a
conformant client cannot rely on receiving a distinguishable "create" event first; codex-acp's v2
path does not need to guarantee create-then-update ordering because the concept of a separate
create message doesn't exist to order against.

## 2. TCK requirement texts (`acp-tck/src/tck/v2/requirements.py`)

- **`ACP-PATCH-201`** (`Tier.CAPABILITY`, `capability="capabilities.session"`, lines 1155-1164):
  "Every agent-emitted message update/chunk (`user_message_chunk`/`user_message`/
  `agent_message_chunk`/`agent_message`/`agent_thought_chunk`/`agent_thought`) carries a non-empty
  string `messageId`." Cites `prompt-lifecycle.mdx:246`, `schema/v2/schema.json:4738-4856`.
- **`ACP-PATCH-203`** (lines 1165-1175): "Two `session/prompt`s on the same session receive two
  distinct `messageId` values — the v2 analogue of v1's `duplicate_session_id.py` defect pattern,
  applied to message ids instead of session ids." Cites `prompt-lifecycle.mdx:151`. (Scoped to the
  *response* `messageId`, i.e. the prompt-lifecycle topic's milestone (a) deliverable — flagged
  here because it's adjacent, not owned by this topic.)
- **`ACP-PATCH-204`** (lines 1176-1189): "Every `tool_call_update` carries a non-empty
  `toolCallId`; every `tool_call_content_chunk` carries a non-empty `toolCallId` and `content`.
  There is no separate tool-call 'create' message in v2 -- an update for a previously-unseen
  `toolCallId` is itself the create, so no create-before-update ordering is asserted. Conditional on
  at least one such update being observed during the run, else SKIP." Cites
  `schema/v2/schema.json:674-758,5040-5110`.
- **`ACP-PATCH-206`** (lines 1201-1211, **owned by milestone (b), noted only for completeness**):
  terminal_update `cwd` absolute-path + set-once-per-`terminalId` check. Cites
  `tool-calls.mdx:405-411,439-440`. Not implemented/analyzed in this milestone — flagged in the
  handoff.
- **`ACP-PATCH-207`** (lines ~1213-1223, **owned by milestone (b)**): `terminal_output_chunk.data`
  / `terminal_update.output.data` each independently valid base64. Cites
  `tool-calls.mdx:441-446,466-474`. Not analyzed here — milestone (b)'s concern.
- **`ACP-PATCH-208`** (lines 1224-1237): "The first `tool_call_update` observed for a given
  `toolCallId` includes a non-empty `title`; `name`, if ever set, does not change across subsequent
  updates for the same id." `Tier.ADVISORY` (not promoted to CAPABILITY despite the session-baseline
  tiering convention — the test itself stays `capabilities.session`-gated for its own SKIP). Cites
  `tool-calls.mdx:44-52`. **Directly actionable for codex-acp**: every "create"-labeled emission
  function in `CodexToolCallMapper.ts` (see §3) already sets `title` unconditionally, so this is
  satisfied by the existing object-construction code without change — the only requirement is that
  the *first* wire emission for a given `toolCallId` is whichever internal "create" call already
  populates `title`, which is already true today (see §3.1). `name`-stability is likewise already
  true: no code path in `CodexToolCallMapper.ts` overwrites `name` on a later "update" emission for
  the same id (updates never set `name` at all except `createDynamicToolCallUpdate`, which sets it
  once at the point that itself functions as the create).
- **`ACP-PATCH-205`** (plan `planId`) — **owned by a sibling topic** (config-options-modes-and-plans,
  topic 9), not duplicated here. Not touched.
- **`ACP-PATCH-209`** (permission-request `requires_action` subject) — **owned by another sibling
  topic** (prompt-lifecycle milestone (b), already covered in
  `.agents/research/v2-prompt-lifecycle-and-turn-state-machine.md` §6.5). Not duplicated here.
- **`ACP-ENUM-201`** (`Tier.CAPABILITY`, lines 1252-1268): "Every value the agent emits at an
  open-enum site carrying dedicated per-site MUST prose -- `tool_call_update.kind`/`.status`
  (`ToolKind`/`ToolCallStatus`) and plan entries' `priority`/`status` ... is a defined constant or
  begins with `_`." Directly relevant to `CodexToolCallMapper.ts`'s `kind`/`status` literals (§3) —
  every `kind`/`status` value the mapper emits today (`"read"`, `"edit"`, `"delete"`, `"move"`,
  `"search"`, `"execute"`, `"think"`, `"fetch"`, `"other"`; `"pending"`, `"in_progress"`,
  `"completed"`, `"failed"`, `"cancelled"`) is already one of the schema's defined constants in both
  v1 and v2 (confirmed identical enum lists in both SDK type files, `ToolKind`/`ToolCallStatus`
  above) — **no change needed**, this requirement is already satisfied by the existing mapper code
  verbatim.
- **`ACP-ENUM-202`** (`Tier.ADVISORY`, lines 1269-1284): same defined-or-`_`-prefixed rule applied
  to `session/update`'s own `sessionUpdate` discriminator, `state_update.state`, and tool-call
  content blocks' `type`. Every `sessionUpdate` discriminator codex-acp emits today
  (`tool_call`/`tool_call_update`/`user_message_chunk`/etc.) is a defined v1 constant; migrating to
  v2's discriminator set (dropping `tool_call`, adding `tool_call_content_chunk`,
  `user_message`/`agent_message`/`agent_thought`, `state_update`) is exactly this milestone's/the
  sibling prompt-lifecycle topic's deliverable — no *new* enum-hygiene risk beyond what's already
  tracked.

## 3. Current codex-acp implementation

### 3.1 `src/CodexToolCallMapper.ts` (923 lines) — paired create/update functions throughout

The file is structured as **paired "create" and "update/complete" functions per tool-call
category**, where "create" always returns the literal `sessionUpdate: "tool_call"` and
"update"/"complete" always returns `sessionUpdate: "tool_call_update"`. A type alias enforces this
at the type level: `type AcpToolCallEvent = Extract<UpdateSessionEvent, { sessionUpdate:
"tool_call" }>` (`:50`) constrains functions like `createExecuteToolCallUpdate` (`:280-295`,
despite its name, always returns the create-literal shape) and `createCommandActionEvent`
(`:556-606`) to the create variant only.

Concretely, every category in the file follows this pattern (file:line references to the "create"
half / "update" half):

- File changes: `createFileChangeUpdate` (`:68-85`, always `"tool_call"` — no update counterpart in
  this file; completion is handled by history/event-driven re-emission, not a patch)
- Command execution: `createCommandExecutionUpdate` (`:87-109`, create, via `createCommandActionEvent`
  or `createTerminalCommandEvent`) / `createCommandExecutionCompleteUpdate` (`:111-150`, update)
- MCP tool calls: `createMcpToolCallUpdate` (`:152-164`, despite the name, wraps
  `createExecuteToolCallUpdate` which is create-typed — MCP tool calls are reported as a single
  one-shot create-shaped event, not create+patch)
- Dynamic tool calls: `createDynamicToolCallUpdate` (`:166-173`, same one-shot create pattern)
- Image view: `createImageViewUpdate` (`:175-196`, one-shot create, immediately `status: "completed"`)
- Image generation: `createImageGenerationStartUpdate` (`:198-211`, create) /
  `createImageGenerationCompleteUpdate` (`:213-223`, update) / `createImageGenerationUpdate`
  (`:225-240`, a third, general-purpose create-shaped variant used elsewhere)
- Context compaction: `createContextCompactionStartUpdate` (`:242-253`, create) /
  `createContextCompactionCompleteUpdate` (`:255-265`, update) /
  `createCompletedContextCompactionUpdate` (`:267-278`, one-shot create used when compaction is
  already done by the time it's reported)
- Guardian approval review: `createGuardianApprovalReviewToolCall` (`:323-335`, create) /
  `createGuardianApprovalReviewToolCallUpdate` (`:337-347`, update) — dispatch between the two
  already exists and is state-driven: `CodexEventHandler.ts:1475-1481` picks the update variant iff
  `this.activeGuardianApprovalReviews.delete(params.reviewId)` succeeds (i.e. an internal Set,
  keyed by review id, already tracks "have I seen this one's start"), else falls back to create —
  **this is the one place in the codebase that already has explicit "is this the first emission"
  state**, pre-dating this migration.
- Fuzzy file search: `createFuzzyFileSearchStartOrUpdate` (`:353-384`, takes an explicit `started:
  boolean` parameter and branches internally between the two literals) / `createFuzzyFileSearchComplete`
  (`:386-394`, update)
- Web search: `createWebSearchStartUpdate` (`:396-407`, create) / `createWebSearchCompleteUpdate`
  (`:409-419`, update)
- Collab-agent tool calls: `createCollabAgentToolCallUpdate` (`:430-442`, create) /
  `createCollabAgentToolCallCompleteUpdate` (`:444-455`, update)
- Subagent activity: `createSubAgentActivityUpdate` (`:481-518`) takes an explicit
  `sessionUpdate: "tool_call" | "tool_call_update"` parameter from its caller and branches
  internally — the caller (`CodexSubagentEventRouter.ts:233,247`, `CodexAcpServer.ts:2280`) already
  decides which literal to pass based on the upstream Codex event's own start/complete framing.

**Key structural finding: in every one of these cases, "is this the first emission for this
`toolCallId`" is decided by the *shape/type of the incoming Codex app-server event* (a distinct
"started" notification type vs. a distinct "completed"/"delta" notification type), not by codex-acp
maintaining its own "have I seen this id" bookkeeping** — with the single, already-noted exception
of the guardian-approval-review `activeGuardianApprovalReviews` Set. This directly answers the
task's core question (item 5): **the internal tool-call-tracking state does not need to change at
all for v2.** Every function above already unconditionally builds a complete object (with `title`,
`kind`, `status` etc. populated per its own category's rules) tagged with a literal discriminator;
merging v1's two discriminators into v2's one is purely a question of what literal string gets
attached at serialization time, not a new decision the business logic has to make.

Two other consumption sites read the `"tool_call"` literal for their own internal purposes and
would need no change under the recommended design (§4) since they consume the *internal* v1-shaped
representation before any v2 rewrite would occur:
- `CodexEventHandler.ts:3488-3497`-equivalent `historyUpdateKey` (actually at
  `CodexAcpServer.ts:3488-3499`) — builds a string dedup key, branching on `"tool_call"` vs.
  `"tool_call_update"` to produce different key prefixes (`tool_call:<id>:start` vs.
  `tool_call:<id>:update`) for history-replay deduplication.
- `CodexEventHandler.ts:1484-1487` (`toolCallTitle`) — extracts `title` only from a `"tool_call"`
  (create) literal event, used for the guardian-approval-review dispatch decision described above.

### 3.2 `src/ContentChunks.ts` (67 lines) — `messageId` is an optional parameter today, and several call sites never pass one

`createUserMessageChunk`/`createAgentMessageChunk`/`createAgentThoughtChunk` (`:13-59`) all take
`messageId?: string` as an **optional** parameter; when omitted, the returned `UpdateSessionEvent`
**has no `messageId` field at all** (confirmed by the `if (messageId) {...} return {...}` branching
in each function — the else-branch literal omits the key entirely, it does not even send
`messageId: undefined`). This is legal under v1 (`messageId` optional on chunks) but **violates
`ACP-PATCH-201` outright under v2** ("every agent-emitted message update/chunk carries a non-empty
string `messageId`").

Grepping every call site (excluding tests) shows two populations:

- **Call sites that already have a natural id to pass** (safe today, no gap): `CodexEventHandler.ts:712`
  (`event.itemId`), `:813` (a `messageId` already threaded through from the caller),
  `CodexAcpServer.ts:2333,2342` (a `messageId` variable already in scope from the prompt handler).
- **Call sites that pass no `messageId` at all today** (a real, concrete gap for v2): system/ad-hoc
  notices that aren't part of an LLM-generated message stream with a natural item id —
  `CodexEventHandler.ts:723` (config warning), `:744` (model-reroute warning as a thought via
  `createAgentTextThoughtChunk`), `:1032` (unspecified text notice), `:1037` (context-compaction
  notice), `:1236` (turn-failure error message); `ResponseItemHistoryFallback.ts:242` (passes
  `undefined` **explicitly**, for history-fallback-replayed agent messages); and six sites in
  `CodexCommands.ts` (`:271,286,300,318,373,422` — slash-command responses like logout
  confirmations, `/goal` validation errors, generic command-argument-hint errors).

**This is the one concrete, non-trivial gap this milestone surfaces beyond the tool-call rename**:
roughly a dozen call sites across three files emit agent-message/agent-thought chunks today with no
`messageId`, because they're one-off system notices rather than model-generated streamed content
that already carries an `itemId`. For v2 compliance, each of these needs a freshly-minted
`messageId` (e.g. a UUID or a monotonic per-notice counter) at emission time — cheap individually
(there's no state-machine complexity, just "mint an id if the caller didn't supply one"), but it is
**a real code change at each of ~12 call sites**, not something that falls out of the tool-call
rename for free. The lowest-risk fix is a one-line change *inside* `ContentChunks.ts` itself: make
`messageId` effectively required for the v2 path by generating a fresh id (e.g.
`crypto.randomUUID()`) whenever the caller omits one, rather than touching all ~12 call sites
individually — this keeps `ContentChunks.ts`'s v1 behavior (omit the field) for the v1 wire path and
adds a v2-only branch that never omits it. (`ResponseItemHistoryFallback.ts:242`'s explicit
`undefined` is a mild wrinkle: it's replaying *history*, so a freshly-minted id on each replay would
not be stable across replays of the same underlying item — worth flagging for whoever implements
this that history-fallback replay may need a *deterministic* id derived from the underlying item,
not a random one, to satisfy `ACP-RESUME-204`/`ACP-RESUME-205`'s replay-consistency expectations
from the session-lifecycle topic.)

### 3.3 `src/ACPSessionConnection.ts` — the (mostly) centralized wire choke point

`ACPSessionConnection.update()` (`:18-23`) is the single method most of the codebase calls to emit a
`session/update` notification: `await this.connection.notify(acp.methods.client.session.update,
asSdkSessionNotification({sessionId, update}))`. `update: UpdateSessionEvent` is typed as
`AcpSessionUpdate` (`src/AcpSessionExtensions.ts:6-9`), itself `SessionNotification["update"]` from
the bare (v1) `@agentclientprotocol/sdk` import plus codex-acp's own non-standard extension update
types (subagent/async-task updates). **This is exactly the kind of centralized
serialization/dispatch point the task's dual-version-lens question (item 5) was asking whether one
exists** — it does, and it is the natural place to add a v2-mode branch that (a) rewrites any
`sessionUpdate: "tool_call"` event into `sessionUpdate: "tool_call_update"` before sending (a pure
relabel, since every field the v1 create-shape carries is a valid v2 `ToolCallUpdate` field, per
§1.2), and (b) calls the v2-typed `acp.methods.client.session.update` binding from
`@agentclientprotocol/sdk/experimental/v2` instead of the v1 one, once the caller/session knows it
is on a v2-negotiated connection.

**However, this choke point is not perfectly exhaustive.** Five call sites bypass
`ACPSessionConnection` entirely and call `this.connection.notify(acp.methods.client.session.update,
{...})` directly with inline v1-typed literals:

- `CodexElicitationHandler.ts:221-225` and `:228-235` (tool-approval-driven `tool_call_update`
  patches sent directly from the elicitation-response handler)
- `CodexElicitationHandler.ts:556-559` (MCP-elicitation-driven `tool_call_update` patch)
- `CodexAcpServer.ts:2538-2541` (MCP startup status updates, iterating
  `CodexEventHandler.createMcpStartupUpdates(...)`)
- `CodexAcpServer.ts:3312-3320` (plan-implementation-approval outcome, a `tool_call_update` patch)

All five of these already emit **only** `tool_call_update`-shaped payloads (never the create
literal), so none of them need the tool-call rename — but all five are typed against and call the
v1 `acp.methods.client.session.update` binding directly, inline, bypassing whatever
version-dispatch mechanism gets added to `ACPSessionConnection`. **For a clean dual-version design,
these five should be refactored to route through `ACPSessionConnection.update()` too** (a mechanical
change — each site already has access to a `this.session`/`ACPSessionConnection`-shaped object in
its surrounding class in every case but `CodexAcpServer.ts:2538/3312`, which would need one
threaded in, or should call a to-be-added `CodexAcpServer`-level helper that itself delegates to
the session's `ACPSessionConnection`) rather than being individually duplicated for v2. This is a
concrete, bounded punch-list item, not a design risk.

## 4. Dual-version cost/risk assessment for milestone (a)

**This is a cheap, additive, serialization-layer-only change for the tool-call half — closer in
spirit to the `initialize` topic's cost profile than to the prompt-lifecycle topic's — plus one
bounded, mechanical gap for the message half.** Concretely:

1. **Tool-call upsert merge: cheap.** §3.1 establishes that no internal state-machine restructuring
   is needed — every "create" vs. "update" decision in `CodexToolCallMapper.ts` is already driven
   by the shape of the upstream Codex app-server event, not by codex-acp-maintained bookkeeping
   (except the one pre-existing guardian-approval-review Set, which needs no change either). The
   fork can live entirely at the `ACPSessionConnection.update()` choke point (§3.3): keep every
   existing v1-shaped internal object exactly as constructed today, and add one small rewrite step
   — "if this is a v2 connection and the update's `sessionUpdate` is `tool_call`, re-tag it
   `tool_call_update` before sending" — plus route the v2 send through the v2-typed
   `acp.methods.client.session.update` binding. No field remapping is needed (§1.2 confirms every
   field the v1 create-shape carries is valid on v2's merged `ToolCallUpdate`, and the one
   required-ness change, `title`, only relaxes from required to optional, never the reverse). The
   only non-trivial mechanical follow-up is fixing the five choke-point-bypassing call sites in
   `CodexElicitationHandler.ts`/`CodexAcpServer.ts` (§3.3) so the fork stays centralized rather than
   needing five individual v2 duplicates.
2. **`tool_call_content_chunk`: purely additive, no existing behavior to change.** Nothing in
   codex-acp emits incremental tool-call content today (tool output is always reported via whole-
   `content`-array `tool_call_update`/create emissions); adopting `tool_call_content_chunk` for
   streaming tool output (e.g. long-running command output, if desired) is a net-new capability to
   build, not a migration of existing logic — genuinely optional for v2 conformance (`content` via
   `tool_call_update` remains valid) and out of this milestone's required scope. Flagged as a
   nice-to-have.
3. **`messageId` requirement: a real but small, well-bounded gap.** §3.2 found ~12 call sites across
   3 files that build message chunks without a `messageId` today because they're ad-hoc system
   notices. This is not a design risk (no ordering/state-machine complexity — every fix is "mint an
   id if none was supplied"), but it is genuine required work, most cheaply centralized as a
   one-line default-id-generation change inside `ContentChunks.ts` itself (v2 path only) rather than
   touching every call site — except `ResponseItemHistoryFallback.ts:242`, which needs a
   *deterministic* (not random) id for replay-consistency reasons, flagged for whoever implements
   this to coordinate with the session-lifecycle topic's `ACP-RESUME-204`/`205` findings.
4. **No SDK type gap found for this milestone** (unlike the sibling prompt-lifecycle topic's
   `PromptResponse.messageId` staleness bug). Diffed the installed `1.4.0`'s
   `ToolCallUpdate`/`ToolCallContentChunk`/`UserMessage`/`AgentMessage`/`AgentThought`/`ContentChunk`
   types against `acp-typescript-sdk` `origin/main` (`69fda37`): the only differences are cosmetic
   (an `@experimental`/`UNSTABLE` doc-comment removed from `ToolCallUpdate.name` upstream, i.e. that
   field has since been stabilized in wording only — no type-shape change) and the addition of an
   unrelated `notice` session-update variant. All tool-call/message-shaped types codex-acp needs for
   this milestone are already correct in the installed `1.4.0`.

**Bottom line for milestone (a): low-to-moderate effort, low risk.** The tool-call merge is a clean
serialization-layer fork with a well-identified (if imperfectly centralized) choke point; the
`messageId` gap is real but mechanically simple and narrowly scoped. Nothing here rises to the
"structural redesign" risk level the prompt-lifecycle topic found for turn-lifetime decoupling —
this topic's risk, if any, is entirely in milestones (b) (terminal streaming ownership model change)
and (c) (diff restructuring), not in (a).

## 5. Milestone (b): agent-owned terminal streaming

Spec re-checked at `agent-client-protocol` local checkout: `git pull --ff-only` fast-forwarded
`8c90bb7` → `c245270` (one unrelated `docs/get-started/registry.mdx` wording change; no effect on
`tool-calls.mdx`/`migration.mdx`). SDK re-checked the same way as milestone (a): installed
`@agentclientprotocol/sdk@1.4.0` vs. `acp-typescript-sdk` `origin/main` (`69fda37`) — diffed
`src/v2/schema/types.gen.ts` between the two revisions and confirmed **zero changes** to
`TerminalUpdate`, `TerminalOutputChunk`, the `Terminal` content type, or any `Diff*` type (the only
terminal-related diff hits are all in the unrelated `AuthMethodTerminal`/interactive-auth-terminal
concept, wording-only). No SDK type gap for either milestone.

### 5.1 Correction to the milestone-(a) handoff: `src/async-tasks/` is not the relevant surface

The milestone-(a) handoff flagged `src/async-tasks/CodexBackgroundTerminalTasks.ts` as "the
architecture question" for terminal streaming. Having now read it in full, **this is a false
lead — that file has nothing to do with ACP's terminal-content/streaming surface at all**, in
either version:

- `CodexBackgroundTerminalTasks.ts`/`BackgroundTerminalApi.ts` model a wholly different, proprietary
  concept: **background/detached process bookkeeping for the AIR extension**, exposed to the client
  as two non-standard, extension-only `sessionUpdate` variants — `async_task_spawned` and
  `async_task_state_update` (`CodexBackgroundTerminalTasks.ts:296-304,353-358`) — neither of which
  exists in v1 or v2 core ACP schema (they live in codex-acp's own `AcpSessionExtensions.ts`, per
  milestone (a) §3.3's characterization of `ACPSessionConnection`'s update type).
- It never streams a background terminal's actual output text at all. It only ever (1) announces a
  spawn (`publishSpawn`, `:282-305`: one `tool_call_update` carrying an AIR "backgrounded" `_meta`
  flag, plus one `async_task_spawned`) and (2) announces a terminal state transition at the end
  (`publishTerminalState`, `:347-366`: one `async_task_state_update` carrying `state:
  "completed"|"failed"|"stopped"`). No `aggregatedOutput`, no output bytes, no `cwd`/`command`
  fields cross this class's boundary into a session update at all.
- Because it already emits a `tool_call_update` (`:283-295`), it needs milestone (a)'s generic
  v1→v2 tool-call fork (no rename needed — it already emits the update-shaped literal, never the
  create-shaped one) — but nothing terminal-streaming-specific applies to it. `async_task_spawned`/
  `async_task_state_update` are extension types outside ACP's v1/v2 schema entirely, so v2
  migration doesn't touch their shape either; they ride through `ACPSessionConnection.update()`
  unchanged regardless of connection version.

**The real surface that maps onto v2's `terminal_update`/`terminal_output_chunk` is spread across
three different files**, none of which is under `src/async-tasks/`:

- `src/TerminalOutputMode.ts` (46 lines, full file read) — a client-capability-negotiated mode
  switch (`"terminal_output"` vs. `"terminal_output_delta"`), driven entirely by a **non-standard**
  `clientCapabilities._meta["terminal_output_delta"|"terminal_output"]` boolean (confirmed by the
  sibling `v2-mcp-config-and-client-execution-surface-removal.md` §4 grep: this is not
  `clientCapabilities.terminal`, the real v1 client-execution marker — it's a private `_meta` key).
  `createTerminalOutputMeta(mode, terminalId, data)` (`:24-45`) builds one of two `_meta` shapes:
  `{terminal_output: {data, terminal_id}}` (full-snapshot/replace semantics) or
  `{terminal_output_delta: {data, terminal_id}}` (incremental/append semantics) — `data` is **raw
  UTF-8 text, never base64**, confirmed by tracing every caller's input type (see below).
- `src/CodexToolCallMapper.ts` — `createTerminalCommandEvent` (`:613-629`) is the one place that
  emits the real v1-spec-legal `ToolCallContent` variant `{type: "terminal", terminalId}` (this
  variant exists in both v1 and v2, unchanged — see §5.2), called only when
  `commandExecutionUsesTerminalOutput(item)` is true (`:608-611`, true for the `"unknown"`
  command-action case, i.e. no more specific structured action was recognized for this command).
  It synthesizes `terminalId = item.id` (the same id as the tool call itself — spec-legal: "It is
  independent of `toolCallId`, even when an Agent uses the same string for both") and smuggles
  `cwd`/`terminal_id` into a private `_meta.terminal_info` block (`:623-628`) rather than any
  standard field. `createCommandExecutionCompleteUpdate` (`:111-150`) builds the terminal-output
  `_meta` at command completion (final aggregated output + a private `_meta.terminal_exit` block,
  `:140-144`).
- `src/CodexEventHandler.ts` — the actual **live incremental streaming** happens here, driven by a
  real upstream Codex app-server event that milestone (a)'s pass never looked at:
  `item/commandExecution/outputDelta` (dispatch at `:594-596`) carries
  `CommandExecutionOutputDeltaNotification{threadId, turnId, itemId, delta: string}`
  (`src/app-server/v2/CommandExecutionOutputDeltaNotification.ts:5` — confirmed `delta` is a plain
  string, not base64). `createCommandOutputDeltaEvent`/`createCommandOutputEvent` (`:1046-1063`)
  turn each delta into a `tool_call_update` whose `_meta` is `createTerminalOutputMeta(...)`'s
  output — i.e. every live output chunk today rides as a private `_meta` patch on the *same*
  `tool_call_update` stream milestone (a) already covers, not as any separate wire concept.
  `item/commandExecution/terminalInteraction` (dispatch `:643-644`, handler
  `createTerminalInteractionEvent` at `:1065-1072`) reuses the exact same delta pipe to echo
  observed stdin back as a synthetic `\n<stdin>\n` delta. `completeCommandExecutionEvent`
  (`:1128-1167`) is the completion-time counterpart to `CodexToolCallMapper.ts`'s version: sends
  final status, and — only if the command wasn't already fully covered by streamed deltas
  (`!commandHadOutput`) and it either had a terminal reference or the client is delta-capable — a
  final full-snapshot `_meta.terminal_output`/`_meta.terminal_output_delta` plus, if the command had
  a terminal reference at all, `_meta.terminal_exit{exit_code, signal: null, terminal_id}`.

### 5.2 v1 vs v2: what's identical, what changes

**Identical, no change needed:** the tool-call-content-block reference itself. v1's
`ToolCallContent` `"terminal"` variant and v2's `Terminal` type (installed SDK,
`node_modules/@agentclientprotocol/sdk/dist/v2/schema/types.gen.d.ts:702-718`) are the same shape —
`{terminalId: TerminalId; _meta?}`, `terminalId` required, spec text at `tool-calls.mdx:395-411`
("A terminal content item references an Agent-owned terminal by ID... The item is only a display
anchor... independent of `toolCallId`... The reference and the terminal's session updates may
arrive in either order"). `createTerminalCommandEvent`'s content-array construction needs **zero
change** for v2.

**What v2 actually replaces:** the private `_meta`-smuggling mechanism codex-acp built because ACP
v1 core has no standardized way to stream/replace agent-owned terminal output — codex-acp invented
one out-of-band (custom `_meta` keys, custom client-capability negotiation) because v1 gave it
nothing better to use for output it never routes through a real client-executed `terminal/create`
object (confirmed by the sibling MCP/client-execution topic: codex-acp never calls `terminal/create`
at all). v2 formalizes exactly the two channels this hack was already informally distinguishing:

- `docs/protocol/v2/tool-calls.mdx:415-433` (`terminal_update`, quoted in full for the exact field
  semantics): upsert keyed by required `terminalId`; `command` ("Agents **SHOULD** provide it on
  the first update"), `cwd` ("**MUST** be absolute when supplied"), `output` (an **authoritative
  replacement snapshot** — "It replaces all previously stored bytes; Clients **MUST NOT** merge or
  splice"), `exitStatus` (`exitCode`/`signal`, "Terminal exit and tool call status are
  independent"). All patch-semantics: omit=unchanged, `null`=clear, value=replace.
- `docs/protocol/v2/tool-calls.mdx:455-465` (`terminal_output_chunk`): `terminalId` and `data`
  required; **always-append** semantics ("Clients decode each chunk separately and append the
  decoded bytes in received order... MUST NOT concatenate encoded strings before decoding").
- Crucially, **these are two independently-always-available channels, not a client-negotiated
  exclusive mode** — an agent can send both `terminal_output_chunk` (as bytes arrive) and a later
  `terminal_update.output` full-snapshot (e.g. at completion) for the *same* `terminalId`, and both
  are always spec-legal. This means v2 needs **none** of `TerminalOutputMode.ts`'s negotiation
  machinery (`resolveTerminalOutputMode`, `clientSupportsTerminalOutputDelta`, the private
  `clientCapabilities._meta["terminal_output"|"terminal_output_delta"]` keys) — that whole
  apparatus exists only because v1 gave codex-acp no standardized replace-vs-append contract, so it
  invented client-side negotiation to pick one. **v2 is strictly simpler here than the current v1
  hack, not harder**: always send `terminal_output_chunk` for live deltas and always send
  `terminal_update.output` for the completion snapshot; no mode selection logic needed at all.
- SDK-confirmed field shapes (installed, `types.gen.d.ts:3813-3868`) match the docs exactly:
  `TerminalUpdate{terminalId (required), command?, cwd?, output?: TerminalOutput|null, exitStatus?:
  TerminalExitStatus|null, _meta?}`; `TerminalOutputChunk{terminalId (required), data (required),
  _meta?}`.
- **Base64 requirement — the one real, concrete conversion needed.** v1's hack carries raw UTF-8
  text (`item.aggregatedOutput`, `event.delta` are both plain `string` per the app-server types
  above); v2 **requires** RFC 4648 base64 for both `terminal_output_chunk.data` and
  `terminal_update.output.data` (TCK `ACP-PATCH-207`, `Tier.CAPABILITY`, quoted in full:
  "`terminal_output_chunk.data` and `terminal_update.output.data` each decode as standalone, valid
  RFC 4648 base64 — independent of any other chunk"). This is a mechanical
  `Buffer.from(text, "utf8").toString("base64")` step at each of the emission points listed in
  §5.1 — no new state, just a different encode at serialization time.
- `cwd`/set-once constraint (TCK `ACP-PATCH-206`, quoted in full: "A supplied `terminal_update.cwd`,
  when present, is an absolute path; a given `terminalId` is never observed with two different `cwd`
  values within a session"): codex-acp's `item.cwd` is fixed per command execution today (already
  read once at tool-call creation, `CodexToolCallMapper.ts:97-108`), so sending it exactly once at
  the first `terminal_update` for that `terminalId` trivially satisfies set-once-ness — **provided**
  Codex's `item.cwd` is already an absolute path in practice (not independently verified in this
  run; the existing v1 `_meta.terminal_info.cwd` usage already assumes this implicitly, so no new
  risk is introduced by v2 requiring it explicitly).
- Exit reporting: today's private `_meta.terminal_exit{exit_code, signal: null, terminal_id}`
  (`CodexToolCallMapper.ts:140-144`, `CodexEventHandler.ts:1154-1158`) maps directly onto v2's
  standard `terminal_update.exitStatus{exitCode, signal}` — same information, cleaner field names,
  no restructuring of what codex-acp already tracks (it already always passes `signal: null` since
  Codex's `CommandExecutionItem` has no signal field at all — worth a follow-up check at
  implementation time on whether Codex ever reports a real signal, but not a migration blocker
  either way: `null` is spec-legal and means "not provided").
- `item/commandExecution/terminalInteraction` (stdin echo): maps onto a `terminal_output_chunk` the
  same way ordinary output deltas do — no special-casing needed beyond the same base64 step.

### 5.3 Dual-version design for milestone (b)

**Additive, not a restructuring — codex-acp already computes every piece of state v2's terminal
model needs.** It was already tracking `terminalId` (=`item.id`), `command`, `cwd`,
per-delta `data`, and final `aggregatedOutput`+`exitCode` to build its own private v1 `_meta` hack;
v2 needs the exact same inputs, just serialized differently (plus base64-encoding the byte
payloads). Concretely:

1. Keep every v1 code path in §5.1 exactly as-is (the private `_meta` hack stays load-bearing for
   v1 clients).
2. Add a parallel v2-only emission at the same four call sites: command start
   (`createTerminalCommandEvent`, add a `terminal_update{terminalId, command, cwd}` session/update
   alongside the unchanged tool-call content-block reference — spec confirms order between the two
   doesn't matter), each output delta (`createCommandOutputDeltaEvent`/`createTerminalInteractionEvent`,
   add a `terminal_output_chunk{terminalId, data: base64(delta)}` instead of the `_meta` patch), and
   completion (`completeCommandExecutionEvent`/`createCommandExecutionCompleteUpdate`, add a
   `terminal_update{terminalId, output: {data: base64(aggregatedOutput)}, exitStatus: {exitCode,
   signal}}`).
3. Two implementation shapes for where the v1-vs-v2 decision lives, both compatible with milestone
   (a)'s `ACPSessionConnection.update()` choke point: (i) have each of the functions in §5.1 build
   whichever wire shape matches the connection's negotiated version directly (needs the version
   threaded into `CodexToolCallMapper.ts`/`CodexEventHandler.ts`, which don't currently know it), or
   (ii) — cleaner, and preferred — have those functions keep emitting one small,
   version-agnostic internal descriptor per terminal event (`{terminalId, phase: "start"|"delta"|
   "complete", command?, cwd?, data?, exitCode?, signal?}`) and let a helper alongside
   `ACPSessionConnection.update()` render it into the v1 `_meta` hack or the v2
   `terminal_update`/`terminal_output_chunk` notifications depending on connection version — this
   keeps the "when to emit what" decision in one place instead of duplicating it per wire format.
4. `TerminalOutputMode.ts`'s negotiation logic (`resolveTerminalOutputMode`,
   `clientSupportsTerminalOutputDelta`) is **v1-only going forward** — it stays exactly as-is for v1
   connections, and the v2 path simply doesn't consult it at all (per §5.2, v2 needs no mode
   selection).

**Risk: low-to-moderate**, not the "genuinely new agent-owned state" risk the milestone-(a) handoff
speculated about. No new state needs to be invented; the base64 conversion is mechanical; the only
architectural decision is (3)'s choice of where the version fork lives, which is a design
preference, not a correctness risk either way.

## 6. Milestone (c): diff content restructuring

### 6.1 Current v1 implementation (`CodexToolCallMapper.ts:848-911`, `DiffStats.ts`, `AgentFileChangeReport.ts`)

Read in full. Backing data type, `src/app-server/v2/FileUpdateChange.ts:6`: `{path: string, kind:
PatchChangeKind, diff: string}`, where `PatchChangeKind` (`src/app-server/v2/PatchChangeKind.ts:5`)
is `{type:"add"} | {type:"delete"} | {type:"update", move_path: string|null}` — Codex has **no
separate "rename" kind**; a pure rename and a "rename + edit" are both reported as `update` with
`move_path` set, distinguished only by whether the accompanying `diff` text also carries content
hunks.

- **`createAddFileContent` (`:848-856`) / `createDeleteFileContent` (`:903-911`)**: for these two
  kinds, `change.diff` is **not a diff at all** — the code comment states it plainly: "app-server
  always returns file content instead of diff." `createAddFileContent` returns `{type: "diff",
  oldText: null, newText: change.diff, path, _meta}` (the *entire new file's raw content* as
  `newText`); `createDeleteFileContent` is the mirror (`oldText: change.diff, newText: ""`). No
  patch/hunk data exists for either case today.
- **`createUpdateFileContent`/`createUpdateDiffContent` (`:858-901`)**: here `change.diff` genuinely
  **is** unified-diff text (after `recoverCorruptedDiff`, `:921-923`, strips a synthetic "Moved
  to:" suffix Codex sometimes appends). It's parsed via `parsePatch` (from the `diff` npm package)
  into exactly one `StructuredPatch`, then **full before/after file content is reconstructed** by
  reading the current on-disk file (`readFileContent`) and applying/reversing the patch
  (`applyPatch`/`reversePatch`), with a fallback chain for the "full-access mode already applied
  it" case (`:870-878`). The result is `{type: "diff", oldText, newText, path, _meta: {kind:
  "update", diffStats}}` (`createUpdateDiffContent`, `:892-901`).
- **`DiffStats.ts`** (75 lines, full file read): computes `{version:1, added, removed}` line counts
  — for add/delete, by counting lines in the raw content (`lineCount`, `:65-73`); for update, by
  walking the already-parsed `patch.hunks` and validating hunk consistency (`update`, `:18-63`,
  returns `null` on any inconsistency it can't verify, e.g. binary or malformed hunks). This is
  purely a `_meta.jetbrains.air.diffStats` annotation, **independent of the `oldText`/`newText` vs.
  `changes[]`/`patch` restructuring** — it stays exactly as-is regardless of which wire shape wraps
  it, since it's `_meta`, not part of the standard content fields either version regulates.
- **`AgentFileChangeReport.ts`** (455 lines, full file read): a **separate, unrelated feature** —
  a custom `_meta`-request/response protocol (`AIR_AGENT_FILE_CHANGE_REPORT_REQUEST_KEY`) that
  audits which paths a whole *turn* touched, for a client-initiated report, not a per-tool-call
  content block at all; it never builds `ToolCallContent`. Included in this milestone's required
  reading only for cross-reference — and it's a useful one: its `extractRawFileHeaders`
  (`:171-189`) parses Codex's **turn-level** diff text by splitting on `/(?=^diff --git )/m` and
  reading `--- `/`+++ ` header lines, confirming that *that* diff-rendering path in Codex does use
  real `diff --git a/<path> b/<path>` git-style headers with `a/`/`b/`-relative paths (stripped via
  `normalizeDiffPath`, `:202-205`). This is **not proof** that the per-file `FileUpdateChange.diff`
  string consumed by `CodexToolCallMapper.ts` uses the identical header convention (it's a
  different Codex API surface — a whole-turn diff vs. a per-file-change diff) — flagged as an open
  question in §6.3, not resolved in this research pass; no fixture/fixture fixture in
  `src/__tests__/` contains a raw pre-mapping `change.diff` string to confirm directly (checked:
  `src/__tests__/CodexACPAgent/data/*.json` fixtures capture only the already-mapped ACP-shaped
  output, e.g. `file-change-add-raw-content.json`'s `newText` is already known to be raw content per
  the code comment above, not a diff either way, so it doesn't help resolve the `update` case's
  header format).

### 6.2 v2 target shape (`docs/protocol/v2/tool-calls.mdx:478-560`, SDK `types.gen.d.ts:560-691`)

Spec text, quoted: "File modifications shown as diffs. A diff always includes structured file
changes and can optionally include renderable patch text. `changes` is authoritative for affected
absolute paths and operations. `patch`, when present, provides renderable text for some or all of
those changes and MUST be consistent with `changes`. Agents SHOULD provide `patch` whenever
feasible. Clients MUST handle diffs where `patch` is omitted or `null`."

- `Diff = {changes: DiffChange[] (required), patch?: DiffPatch|null, _meta?}`.
- `DiffChange`: a per-operation union. `add`/`delete`/`modify` → `DiffPathChange{path: AbsolutePath}`
  (single path only — "For deletes, this is the deleted path"). `move`/`copy` →
  `DiffPathPairChange{oldPath: AbsolutePath, path: AbsolutePath}` ("`oldPath`... Required for `move`
  and `copy`"). All variants also carry optional `fileType?` (`text`/`binary`/`directory`/`symlink`)
  and `mimeType?`. **There is no content field anywhere in `DiffChange` — no `oldText`, no
  `newText`, no per-change diff text.** Content only ever travels via the sibling `patch` field.
- `DiffPatch = {format: "git_patch"|string (required), text: string (required)}` — spec: "`git_patch`
  ... is one or more `diff --git` sections in Git's `--patch` (`-p`) text format. Paths MUST be
  absolute. Surrounding commit metadata and email envelopes MUST NOT be included." `patch` itself is
  optional at the `Diff` level ("Omit `patch` when there is no useful text patch, such as a
  same-path binary update or symlink target change").
- SDK-confirmed field shapes match exactly (`DiffChange` union at `:566-609`, `DiffPathChange`
  `:621-626`, `DiffPathPairChange` `:630-639`, `DiffPatch` `:643-652`, `Diff` `:667-691`) — no
  discrepancy between docs and installed types, and (per the intro diff check above) no discrepancy
  between the installed `1.4.0` and `acp-typescript-sdk` `origin/main` either.
- No dedicated `ACP-DIFF-*` TCK requirement rows exist (grepped `requirements.py` for `diff`,
  case-insensitive — no hits beyond this file's own prose describing the general upsert-patch
  model). The only TCK rows that touch diff content at all are the general open-enum hygiene rows
  already covered by milestone (a) §2 (`ACP-ENUM-201`/`202`), which apply to `changes[].operation`/
  `.fileType` the same way they apply to `tool_call_update.kind`/`.status`: every value codex-acp
  would emit (`add`/`delete`/`modify`/`move` — `copy` is never emitted, since Codex's
  `PatchChangeKind` has no copy concept at all) is a defined constant, so this is trivially
  satisfied without new work.

### 6.3 Mapping analysis, function by function

- **`createUpdateFileContent`/`createUpdateDiffContent` — the easiest case, and actually *less*
  work than v1's current path.** codex-acp already has real unified-diff text (`change.diff`, after
  `recoverCorruptedDiff`) and an already-parsed structured `patch`. For v2:
  `changes: [{operation: change.kind.move_path ? "move" : "modify", ...(change.kind.move_path ?
  {oldPath: change.path, path: change.kind.move_path} : {path: change.path})}]` plus
  `patch: {format: "git_patch", text: <the diff text>}`. **v2 doesn't need the full-content
  reconstruction v1 requires at all** — the disk read (`readFileContent`) and
  `applyPatch`/`reversePatch` fallback chain (`:867-889`) exist *only* to produce v1's
  `oldText`/`newText`; that logic must stay for the v1 wire path but is dead weight for v2's output.
  **Open, unresolved question flagged for implementation, not blocking the design**: is
  `change.diff`'s text already valid `git_patch` format — i.e. does it carry a `diff --git a/<path>
  b/<path>` header line, and are the `---`/`+++` paths absolute (spec: "Paths MUST be absolute")?
  Not directly confirmed in this run (no fixture captures the raw pre-mapping string — see §6.1).
  §6.1's `AgentFileChangeReport.ts` finding shows Codex's *turn-level* diff-rendering does use
  git-style `diff --git`/`a/`,`b/`-relative headers, which is suggestive but not proof for this
  different, per-file API. If `change.diff` turns out to lack the `diff --git` line or use relative
  paths, the v2 path needs a bounded text-rewrite (synthesize/prepend the header, rewrite
  `---`/`+++` to absolute) before use as `patch.text` — mechanically similar to path-absolutization
  logic `AgentFileChangeReport.ts` already has for its own, different purpose, but not directly
  reusable as-is (operates on a different, whole-turn-scoped input).
- **`createAddFileContent`**: `changes: [{operation: "add", path: change.path, fileType: "text"}]`
  is trivial (simpler than v1's relabel-into-`newText`, no reconstruction of anything). `patch` is
  the harder part: there is no diff text at all today (`change.diff` is raw content, §6.1), so
  satisfying "Agents SHOULD provide `patch` whenever feasible" means **synthesizing** a git-style
  added-file patch (`--- /dev/null` / `+++ b/<path>` / one hunk, every line prefixed `+`) from raw
  content — new code, though a simple, deterministic, well-known transform (the `diff` npm package
  already in use elsewhere in this file likely has a `createPatch`/`structuredPatch`-style helper
  that does exactly this given `oldContent=""`, `newContent=<raw content>`). **Alternative,
  spec-legal fallback**: per "Omit `patch` when there is no useful text patch," codex-acp could
  simply omit `patch` for adds, at the cost of the client losing a renderable diff view for newly
  added files compared to v1 (a real product-behavior trade-off, not something this research pass
  can resolve — flagged for whoever implements this to decide against actual client UX
  expectations).
- **`createDeleteFileContent`**: symmetric to add — `changes: [{operation: "delete", path:
  change.path}]` trivial; `patch` synthesis is the mirror transform (`--- a/<path>` / `+++ /dev/null`
  / all lines prefixed `-`), same omit-or-synthesize trade-off as add.
- **The rename+edit structural mismatch — a genuine, narrow design question, not a blocker.**
  Codex's `PatchChangeKind` conflates "pure rename" and "rename with content edits" into the same
  `update`-with-`move_path` kind. v2's `DiffChange` union, by contrast, models `move`/`copy` via
  `DiffPathPairChange{oldPath, path}` with **no content-change field at all in the structural
  entry** — the closest v2 modeling choices for a Codex "moved and edited" change are: (a) emit a
  single `{operation: "move", oldPath, path}` entry and carry the actual content diff only in
  `patch.text` (git's own rename-diff convention already supports a single `diff --git a/old
  b/new` section with hunks, so this is representable), or (b) emit two entries (`move` then
  `modify` on the new path). **Recommendation: (a)** — `changes[].operation` is documented as
  informational metadata ("Clients can use this field... without parsing patch text"), not a claim
  that no content changed, and git's rename-with-changes convention already matches this shape
  naturally. This is a design recommendation for the implementer to confirm against real client
  rendering expectations, not a resolved certainty.

### 6.4 Dual-version design for milestone (c)

Fork lives at the same three functions (`createAddFileContent`/`createUpdateFileContent`/
`createDeleteFileContent`), the same choke point pattern as (a) and (b) — add v2-shaped sibling
builders reusing already-available inputs (`change.path`, `change.kind`, `change.diff`, and for
`update`, the already-parsed `patch` object) rather than requiring new upstream data from Codex.
No internal state divergence between v1 and v2 is needed anywhere in this milestone. The concrete
net-new work is: (1) patch-text synthesis for `add`/`delete` (or an accepted omit-`patch`
trade-off), (2) confirming/normalizing `change.diff`'s header format for `update` (§6.3's open
question), and (3) the rename+edit modeling decision (§6.3). None of these touch
`DiffStats.ts` (stays as-is, `_meta`-only) or `AgentFileChangeReport.ts` (unrelated feature, no
change needed at all).

**Risk: low for `update`** (mechanical, reuses already-parsed data, arguably less work than v1);
**low-to-moderate for `add`/`delete`** (real but bounded new synthesis code, or a documented
product trade-off); the rename+edit question is a narrow design decision, not a risk to the
migration's feasibility.

## 7. Topic-wide dual-version verdict (all 3 milestones)

- **(a) Message/tool-call upsert semantics: low-to-moderate effort, low risk** (unchanged from §4).
- **(b) Agent-owned terminal streaming: low-to-moderate effort, low risk.** codex-acp already
  computes every piece of internal state v2's `terminal_update`/`terminal_output_chunk` model needs
  — it was already tracking all of it to build its own private v1 `_meta` hack (`TerminalOutputMode.ts`,
  `CodexToolCallMapper.ts`, `CodexEventHandler.ts`). v2 is a wire-shape addition (new emission
  functions or a version-aware rendering helper at the choke point), not a state-machine
  restructuring, and it actually lets codex-acp **delete** a whole layer of custom client-capability
  negotiation (`TerminalOutputMode`'s mode selection) that v1 needed and v2 doesn't. `src/async-tasks/
  CodexBackgroundTerminalTasks.ts` — flagged by the milestone-(a) handoff as "the architecture
  question" — turned out to be an unrelated proprietary background-task extension, not the terminal-
  streaming surface at all; that correction is this run's most important course-correction for
  future readers of this file.
- **(c) Diff content restructuring: low risk for the `update` case (simpler than v1's current
  reconstruction path), low-to-moderate for `add`/`delete` (needs new patch-text synthesis or an
  accepted product trade-off), plus one narrow rename+edit structural-modeling decision.** No
  `DiffStats.ts`/`AgentFileChangeReport.ts` changes needed.
- **Topic-wide: the same `ACPSessionConnection.update()` choke point (§3.3) serves all three
  milestones.** No genuine internal-state or architectural divergence between v1 and v2 was found
  anywhere in this topic across all three milestones — every change is a serialization-layer fork
  over data codex-acp already computes today for its v1 wire path. The topic's overall risk
  profile is **low-to-moderate**, closer to the `initialize`/capability-negotiation topic's cost
  profile than to the prompt-lifecycle topic's structural-redesign profile.

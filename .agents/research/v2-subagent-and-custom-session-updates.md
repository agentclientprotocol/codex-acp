# How should codex-acp emit its subagent and other non-standard `sessionUpdate` values on an ACP v2 connection?

**Sources checked:**
- ACP spec `agent-client-protocol` `main` @ `c2452704b53a` (2026-09-23; `git pull --ff-only`: already up to date).
- ACP spec branch `origin/vbr/subagents-rfd` @ `a06ecf2` (2026-09-16). PR #1992 "Add subagents RFD" is **OPEN**, `reviewDecision: REVIEW_REQUIRED`, last updated 2026-09-16T23:38Z (`gh pr view 1992`).
- TypeScript SDK `acp-typescript-sdk` `main` @ `69fda37` (2026-09-23; already up to date). The relevant files are unchanged from `v1.5.0`, except `src/v2/acp.ts`, which only gains stream-size options. Also checked the installed `node_modules/@agentclientprotocol/sdk` **1.5.0** `dist/` directly, and ran an empirical zod probe (`/tmp/probe-su.mjs`).
- codex-acp working tree on `eugenethedev/acp-v2` (after `6f2e88e`).
- Supplemental client-side evidence. These are local checkouts that I did not pull, so they may be stale:
  - JetBrains monorepo `ultimate` @ `2d7e258ad7956` (2026-09-15), for the AIR client.
  - `acp-kotlin-sdk` @ `f7db7c4` (2026-09-18).
  - `claude-agent-acp` @ `36a0a59` (2026-09-22).

**Confidence:** high on the facts: the inventory, SDK behavior (read from code and probed), and the spec rules. Medium on the recommendations. They are judgment calls, because no ACP artifact on `main` defines subagent or async-task updates, and AIR has no v2 consumer yet.

## Answer

codex-acp emits four non-standard `sessionUpdate` values:
- `subagent_spawned`
- `subagent_state_update`
- `async_task_spawned`
- `async_task_state_update`

A fifth, `async_task_progress`, is declared as a type but never emitted. All other values it emits are standard v1 variants.

The v2 SDK (1.5.0) **neither rejects nor strips** these values in either direction:
- **Agent side.** `ctx.client.notify("session/update", …)` does no outbound validation. It only checks the method direction, then writes the params raw.
- **Client side.** The v2 zod `SessionUpdate` union has a catch-all variant for *any* unknown string, whether or not it starts with `_`, and it re-attaches the whole payload.
- **Types.** The v2 TS `SessionUpdate` type has an open `{sessionUpdate: string; [k]: unknown}` arm, so these values type-check without a cast.

The constraint therefore comes only from the spec:
- On v2, custom tagged-union values **MUST** be `_`-prefixed (`extensibility.mdx:117`).
- Receivers **MUST NOT** treat unknown non-`_` values as custom extensions (`:118`).

As a result, sending the current names on v2 is non-conforming, even though no SDK would catch it.

Recommendations:
- **Subagents.** Emit the RFD's single upsert-style `SubagentUpdate` payload, gated on AIR `nativeSubagentSessions`. Put it under the `_`-prefixed discriminator **`_subagent_update`** until `subagent_update` lands in `schema/v2/schema.unstable.json` on spec `main`. At that point, rename to `subagent_update`.
- **Async tasks.** Emit **`_async_task_spawned` / `_async_task_state_update`** with unchanged payloads, gated on AIR `asyncTasks`.

Every choice here is a judgment call on top of one spec-mandated fact: the value must start with `_`. AIR's v1 client matches the exact unprefixed strings and has no v2 path at all. Whatever codex-acp picks is therefore a new contract that the AIR team must adopt.

## Requirements

| # | Requirement | Tier | Citation |
|---|-------------|------|----------|
| R1 | Values beginning with `_` are reserved for implementation-specific extensions in tagged unions that define a custom/future fallback. | Definition (normative framing) | spec `docs/protocol/v2/extensibility.mdx:113-115` |
| R2 | Unknown non-`_` values are reserved for future ACP variants. | Definition | spec `docs/protocol/v2/extensibility.mdx:116`; `schema/v2/schema.json:4560-4566` (`SessionUpdate` "other" arm description) |
| R3 | Extensions **MUST NOT** define custom non-underscore values. | **MUST** | spec `docs/protocol/v2/extensibility.mdx:117` |
| R4 | Implementations **MUST NOT** treat unknown non-underscore values as custom extensions. This is a receiver rule, and it means a conforming v2 client may not interpret `subagent_spawned` as AIR's extension. | **MUST** (client-side) | spec `docs/protocol/v2/extensibility.mdx:118` |
| R5 | Receivers SHOULD preserve unknown values/raw payloads when storing/replaying/proxying, and otherwise ignore them or display them generically. | SHOULD (client-side) | spec `docs/protocol/v2/extensibility.mdx:122`; `schema/v2/schema.json:4561` |
| R6 | v2 clients tolerate unknown `sessionUpdate` types. | Migration guidance | spec `docs/protocol/v2/migration.mdx:760` |
| R7 | Implementations **MUST NOT** add custom fields at the root of a spec type. This matters for option (c): custom data goes in `_meta`, not in extra keys on a standard update. | **MUST** | spec `docs/protocol/v2/extensibility.mdx:39` |
| R8 | Extensions SHOULD advertise custom capabilities. codex-acp's AIR `nativeSubagentSessions` / `asyncTasks` keys satisfy this. | SHOULD | spec `docs/protocol/v2/extensibility.mdx:93,126` |
| R9 | (Proposal) The single `subagent_update` upsert is sent on the immediate parent. The first update for an unknown `subagentSessionId` announces the child and MUST precede any update bearing the child's session ID. | RFD proposal (unmerged) | `origin/vbr/subagents-rfd:docs/rfds/subagents.mdx:81-89,135-141` |
| R10 | (Proposal) The Agent MUST report exactly one terminal `state` per announced child, after all child updates and pending permission/elicitation requests, and MUST NOT send further updates for that child. | RFD proposal | `…/subagents.mdx:197-227,340-346` |
| R11 | (Proposal) v2 needs no capability, uses v2 patch semantics (omit = unchanged, `null` = clear), and has an open `state` enum. | RFD proposal | `…/subagents.mdx:379-394` |
| R12 | (Proposal) v2 Agents SHOULD still terminate announced children within the turn. | RFD proposal, SHOULD | `…/subagents.mdx:405-407` |
| R13 | (Proposal) Orphans on load are terminated as `disconnected`. The Agent MUST NOT send a standalone child terminal update during `session/resume`. | RFD proposal | `…/subagents.mdx:270-298` |
| R14 | Async tasks: **no spec, RFD, or schema exists** for them upstream. This is an AIR-private extension only. | n/a (extension) | `rg -il "async_task"` over spec `schema/`, `docs/protocol/`, `docs/rfds/` on `main` and over TS SDK `src/`, `schema/`: no hits |

## Details

### 1. Inventory of non-standard `sessionUpdate` values codex-acp emits

To build this list I grepped `sessionUpdate: "…"` literals in `src/`, excluding `src/__tests__` and `src/app-server`. Every value was checked against the v2 `SessionUpdate` union in the SDK. The standard values it emits are:

`user_message_chunk`, `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `plan_update`, `available_commands_update`, `config_option_update`, `session_info_update`, `usage_update`, `notice`, `compaction_update`.

These are all v1-standard or v1-unstable and are owned by topic 1b; see Open questions about `tool_call`/`plan`. Only the rows below are non-standard in *both* versions.

| Value | Type decl | Emission sites | Gate today | v2 SDK TS type | v2 SDK zod (client receive) | v2 agent `notify` |
|---|---|---|---|---|---|---|
| `subagent_spawned` | `src/subagents/AcpSubagents.ts:17-24` | live: `src/subagents/CodexSubagentEventRouter.ts:323` (materialize), `:385`, `:405` (reopen, new generation id); load replay: `src/CodexAcpServer.ts:2152`, `:2198` | `clientSupportsSubagents` (`src/subagents/AcpSubagents.ts:39-51`; callers `src/CodexAcpServer.ts:793,2059,2099,2975`) | Accepted by the open catch-all arm (`src/v2/schema/types.gen.ts:3682`, arm at `:3745`) | **Preserved** via the catch-all (`src/v2/schema/zod.gen.ts:3125,3227`; probe: `OK`, payload intact) | Sent raw |
| `subagent_state_update` | `src/subagents/AcpSubagents.ts:28-33` | live: `src/subagents/CodexSubagentEventRouter.ts:358`; load replay: `src/CodexAcpServer.ts:2213`, `:2230` (`disconnected` orphans) | same | same | Preserved | Sent raw |
| `async_task_spawned` | `src/async-tasks/AcpAsyncTasks.ts:3-14` | `src/async-tasks/CodexBackgroundTerminalTasks.ts:297` | AIR `asyncTasks` (`src/CodexAcpServer.ts:859`; `docs/async-tasks.md:7-9`) | same | Preserved (probe: `OK`, `_meta` intact) | Sent raw |
| `async_task_state_update` | `src/async-tasks/AcpAsyncTasks.ts:28-36` | `src/async-tasks/CodexBackgroundTerminalTasks.ts:354` | same | same | Preserved | Sent raw |
| `async_task_progress` | `src/async-tasks/AcpAsyncTasks.ts:16-26` | **never emitted** (the only literal is the type) | — | — | — | — |

Related `_meta`-carried AIR data is already conforming and needs no change: `tool_call_update._meta.jetbrains.air.asyncTasks.backgrounded` (`src/async-tasks/CodexBackgroundTerminalTasks.ts:283-296`).

The union these values join is `AcpSessionUpdate` (`src/AcpSessionExtensions.ts:6-10`). On v1 it is forced through `asSdkSessionNotification` (`:17-21`). On v2 no cast would be needed because of the open TS arm.

### 2. Does the v2 SDK validate or strip outbound `session/update`?

**No, for either outbound or inbound in the SDK's own code paths. Nothing is rejected or dropped.**

- **Agent → client send path** (TS SDK `main` = 1.5.0 for these lines):
  1. `AgentContext.notify(method, params)` → `assertV2MethodDirection(...)` → `waitUntilInitialized` → `this.sendNotification(method, params)`. See `src/v2/acp.ts:1061-1087`; the 1.5.0 dist has the same at `dist/v2/acp.js:450-455`.
  2. `assertV2MethodDirection` only checks that `session/update` is a client-direction notification (`src/v2/acp.ts:345-363`).
  3. `sendNotification` → `cx.sendNotification` (`src/v2/acp.ts:975-977`) → `jsonrpc.ts:1099-1104` `sendWireMessage({jsonrpc, method, params})`.
  4. At no step is `validate.zUpdateSessionNotification` applied to outbound params. That zod spec is registered only in `clientNotificationSpecs` (`src/v2/acp.ts:2500-2518`). It is used for direction lookup and for *receiving* handlers (`registerAppNotification`, `src/v2/acp.ts:2227-2240`).
- **Client receive path** (relevant to what an SDK-based v2 client sees):
  1. `SessionUpdateRouter.handleMessage` calls `validate.zUpdateSessionNotification.parse(message.params)` (`src/v2/acp.ts:2828-2840`).
  2. `zSessionUpdate` is `preserveCustomPayload(z.union([...known..., excludeKnownTags(z.object({sessionUpdate: z.string()}), ...)]))` (`src/v2/schema/zod.gen.ts:3125-3250`; helpers in `src/schema-deserialize.ts:54-113`, present unchanged in `v1.5.0`).
  3. The catch-all accepts **any** string tag outside the known list and re-attaches all raw keys (`schema-deserialize.ts:98-110`).
  4. There is no `_`-prefix check. A malformed *known* tag would fail. In that case a notification parse error is only logged, `console.error("Error handling notification", …)` (`jsonrpc.ts:1416-1432`), not surfaced.
- **Empirical probe** against installed 1.5.0 `dist/v2/schema/zod.gen.js`. `zUpdateSessionNotification.safeParse` returned `OK` with the full payload preserved for:
  - `subagent_spawned`, `_subagent_spawned`, `subagent_update`
  - `async_task_spawned` (with `_meta`)
  - and also v1-only `tool_call` and `plan`
- **Kotlin SDK (what AIR builds on).** The v2 `SessionUpdate.Unknown(sessionUpdate: String, rawJson: JsonObject)` preserves any unknown tag byte-identically (`acp-kotlin-sdk: acp-model/src/commonMain/kotlin/com/agentclientprotocol/model/v2/SessionUpdate.kt:830-838`). Any name codex-acp picks reaches AIR as `Unknown` + raw JSON.

In short, compliance is purely a spec/contract matter. The SDKs make any choice transport-safe.

### 3. v2-compliant options

#### Subagents (`subagent_spawned`, `subagent_state_update`)

**(a) `_`-prefixed rename, same two-message shape** (`_subagent_spawned`, `_subagent_state_update`).
- Conforms to R3.
- Smallest code change (a string swap).
- It preserves a shape the RFD's own author has abandoned (`subagents.mdx:482-491,567-569,577-584`). A later migration to the upsert shape would change both the discriminator *and* the payload semantics.

**(b) RFD `subagent_update`.** The exact v2 shape on the branch (`origin/vbr/subagents-rfd:schema/v2/schema.unstable.json`, new `$defs` `SubagentUpdate` / `SubagentState` / `SubagentSessionCapabilities` + a `SessionUpdate` arm with `const: "subagent_update"`):

```text
SubagentUpdate {
  subagentSessionId: SessionId            // required
  name?:  string | null                   // v2 patch: omit=unchanged, null=clear
  task?:  string | null
  capabilities?: { cancel?: boolean, _meta? } | null   // unset => no operations
  state?: "running"|"completed"|"failed"|"cancelled"|"disconnected"|<other string> | null  // unset => running; all but running terminal
  _meta?: object | null
}
```

- It is marked `**UNSTABLE**` in the branch schema.
- The mapping from codex-acp is 1:1:
  - spawn → `{subagentSessionId, name, task, capabilities: {}}` (omit `state`)
  - terminal → `{subagentSessionId, state}`
- Drop codex-acp's `SubagentSessionCapabilities.close` (`src/subagents/AcpSubagents.ts:11-15`). The RFD removed it (`subagents.mdx:501-511,581`), and codex-acp already sends `{}`.
- codex-acp's reopen-with-new-id pattern (`CodexSubagentEventRouter.ts:366-418`, `:generation:N`) satisfies "MUST NOT send further updates for that child" (R10). Each generation is a new child.

How stable is the RFD?
- It sits on an unmerged side branch, and PR #1992 is open with review still required.
- It was substantially reworked on 2026-09-15/16. That rework is the whole reason `subagent_spawned` became `subagent_update`.
- It is absent from `main` in every form: docs, schema, and unstable schema.

**Emitting the literal `subagent_update` today is technically a non-`_` value not defined by any merged schema.** R2 reserves such values for future ACP variants, and R3 forbids extensions from defining them. It anticipates a future standard value rather than defining an unrelated one, but it is still non-conforming until the RFD merges.

**(a+b) RFD shape under a `_` discriminator** (`_subagent_update`, payload = `SubagentUpdate` above).
- Conforms to R3 today.
- Adopts the single-entity upsert shape now.
- When the RFD merges, the migration is a one-token rename that AIR can overlap by accepting both names.

**(c) `_meta`-carried.** For example, put `_meta.jetbrains.air.subagent = {…}` on a standard parent-session update, such as `session_info_update` or the spawn tool call's `tool_call_update`.
- Conforming (R7 is respected by using `_meta`).
- Awkward: the child needs an announcement that precedes all child traffic (R9), and it must carry a terminal state. Piggybacking both on an unrelated standard update conflates entities.
- It diverges further from the RFD than (a) or (b).
- It forces a no-op-looking standard update just to carry metadata.

**(d) Not emitting on v2.**
- Conforming, and it matches codex-acp's existing no-support fallback: subagents stay ordinary tool calls on the root (`docs/subagent-sessions.md:26-28`).
- It loses native child sessions in AIR on v2, and AIR explicitly advertises `nativeSubagentSessions` to get them.

#### Async tasks (`async_task_spawned`, `async_task_state_update`; `async_task_progress` if ever emitted)

There is no upstream design at all (R14), so there is no (b).
- **(a)** `_async_task_spawned` / `_async_task_state_update` (and `_async_task_progress`), with payloads unchanged.
- **(c)** Carry task lifecycle in `tool_call_update._meta.jetbrains.air.asyncTasks.*`. This works for codex-acp, because every background-terminal task has a `toolCallId` (`CodexBackgroundTerminalTasks.ts:297-305`). It would, however, make codex-acp's wire diverge from claude-agent-acp's shared AIR async-task contract. That contract is a standalone entity with its own tab and Stop action (`ultimate: plugins/air/backend/acp/src/AcpProtocolExtensions.kt:222-250`; `claude-agent-acp: src/async-tasks.ts:464,553`).
- **(d)** Not emitting on v2. AIR loses its task tab and the `_session/async_task/stop` affordance, while the tool call itself still renders.

### 4. What JetBrains AIR would plausibly consume

This section uses supplemental evidence from local checkouts that I did not refresh.

- **AIR's v1 client matches exact unprefixed strings.**
  - `ultimate: plugins/air/backend/acp/src/AcpSessionRuntimeFacts.kt:1085-1089` defines `async_task_spawned`, `async_task_progress`, `async_task_state_update`, `subagent_spawned`, `subagent_state_update`.
  - Dispatch on `UnknownSessionUpdate.sessionUpdateType` happens at `:692-698`.
  - `ultimate: fleet/plugins/ai/protocol/srcCommonMain/fleet/ai/protocol/agents/acp/AcpNativeSubagentUpdates.kt:36-38,43-82` does the same for subagents.
  - `ultimate: plugins/air/backend/acp/src/pool/AcpPlanProtocolCompatibilityTransport.kt:80` routes children on `"subagent_spawned"`.
- **AIR has no `subagent_update` handling, no `_`-prefixed variants, and no ACP v2 client path.** A grep for `subagent_update|"_subagent|"_async_task` found no hits. The only v2 mention is a comment, `AcpClientOperations.kt:70`.
- **AIR is tracking the RFD.** `AcpNativeSubagentUpdates.kt:50-52` says: "Until … pull/1992 is merged, subagent lifecycle update types arrive as UnknownSessionUpdate. A newer SDK will give them their own types". It also accepts the early-draft `description` fallback (`:62-63`). That checkout (2026-09-15 14:04 UTC) predates the RFD's `subagent_update` rework commit (2026-09-15 23:26 UTC).
- **claude-agent-acp**, the other AIR-facing adapter, emits the same four unprefixed names (`src/acp-subagents.ts:28,39,48,75`) and has no v2 route.

**Plausible reading (hypothesis).** A v2 AIR client will be written fresh on the Kotlin v2 SDK, where every one of these arrives as `SessionUpdate.Unknown` + raw JSON. It will likely move to the RFD's `subagent_update` once PR #1992 merges, because AIR already anticipates SDK-typed subagent updates. It will need *some* async-task names, and nothing upstream constrains them. Settling this needs confirmation from the AIR team (see Open questions).

### 5. Recommendations

Beyond R3 itself, all of these are judgment calls.

1. **Subagents → (a+b): `sessionUpdate: "_subagent_update"` with the RFD v2 `SubagentUpdate` payload, gated on AIR `nativeSubagentSessions`** (per the user decision in `.agents/state.md:95-100`).
   - Rationale:
     - It is conforming today (R3).
     - It adopts the upsert shape the RFD will standardize, and that shape is explicitly the v2 design (`subagents.mdx:379-394`).
     - AIR needs a new v2 parser anyway, so the only extra cost is a later rename.
   - Encoding rules:
     - Announce with `name`, `task`, `capabilities: {}`. Omit `state` and never send `null`: under v2 patch semantics `null` clears.
     - Terminal: `{subagentSessionId, state}`.
     - Keep the existing ordering guarantees (announce before child traffic; terminal after child traffic and pending requests).
   - When `subagent_update` lands in `schema/v2/schema.unstable.json` on spec `main` (and hence in the TS SDK union), rename the discriminator to `subagent_update`.
   - **Alternative, if the user prefers zero future churn over strict conformance:** emit unprefixed `subagent_update` now. This deliberately violates `extensibility.mdx:117` in anticipation of the RFD, and it risks a mismatch if the RFD changes again before merge.
   - Do **not** use the two-message `subagent_spawned`/`subagent_state_update` shape on v2 in any form. It is the abandoned draft.
2. **Async tasks → (a): `_async_task_spawned` / `_async_task_state_update`, payloads unchanged, gated on AIR `asyncTasks`.**
   - Rationale:
     - There is no upstream design to align with.
     - This is the minimal conforming change.
     - It keeps codex-acp and claude-agent-acp on one AIR entity model, with AIR mapping `_x` → `x`.
   - If `async_task_progress` is ever emitted on v2, use `_async_task_progress`.
   - Namespacing (e.g. `_jetbrains.air/async_task_spawned`) is also conforming and more collision-proof. Choose it only if the AIR team prefers it. Either way it is a contract decision to make with AIR.
3. **Everything else codex-acp emits** is standard in v1 or unstable-v2. It is out of scope here and belongs to 1b's v1→v2 renderer.

## Testability notes

- **Transport.** Using the existing v2 connection harness (TS SDK client over an in-memory stream):
  - Assert that the raw JSON-RPC `session/update` frames for a native-subagent turn contain `update.sessionUpdate === "_subagent_update"` and never `subagent_spawned`/`subagent_state_update`.
  - Snapshot the frames with `toMatchFileSnapshot()`.
  - Conforming output: every non-standard discriminator on the v2 wire starts with `_`.
  - Non-conforming output: any tag outside the SDK's known list that does not start with `_`.
- **A generic guard test is feasible.** Import the known-tag list from the v2 zod (or hard-code it from `types.gen.ts:3682+`), capture all v2 `session/update` frames across the existing v2 scenarios, and assert `known.includes(tag) || tag.startsWith("_")`. This also catches v1 `tool_call`/`plan` leaking into v2, which the TS type and the SDK zod both silently allow.
- **RFD ordering on v2.** For a child with traffic, the first `_subagent_update` for id X (announce: `name`/`task`, no `state`) precedes any frame with `params.sessionId === X`. Exactly one frame with a terminal `state` follows the last X frame. After it, no X frames appear.
- **Patch semantics.** Assert that announces contain no `null` fields and no `state` key.
- **Gating.**
  - Without `capabilities._meta.jetbrains.air.capabilities: ["nativeSubagentSessions"]`, there is no `_subagent_update` and there is the tool-call fallback.
  - Without `asyncTasks`, there is no `_async_task_*`. The `tool_call_update._meta.jetbrains.air.asyncTasks.backgrounded` behavior should mirror the v1 gate; that is existing behavior, verify it.
- **v1 regression.** The v1 snapshots must stay byte-identical: v1 keeps `subagent_spawned`/`subagent_state_update`/`async_task_*`.
- **Untestable in codex-acp.** Whether AIR interprets the new names cannot be checked here; it is an external contract. Whether the SDK validates the frames cannot be observed either, because it does not.

## Discrepancies

1. **The spec forbids what the SDKs permit.** `extensibility.mdx:117-118` (MUST) requires `_`-prefixed custom values and forbids receivers from treating non-`_` unknowns as extensions. Neither the TS SDK (`zod.gen.ts:3227` catch-all; open TS arm `types.gen.ts:3745`; no outbound validation, `v2/acp.ts:1077-1087`) nor the Kotlin SDK (`SessionUpdate.Unknown`) distinguishes the two. The SDKs cannot enforce R3, so codex-acp must enforce it itself.
2. **The RFD disagrees with codex-acp's docs and the AIR client.** `docs/subagent-sessions.md:5-18` and AIR (`AcpNativeSubagentUpdates.kt:36-37`) implement the pre-rework two-message draft. The RFD now rejects that draft (`subagents.mdx:482-491,577-584`).
3. **The RFD's v2 "no capability, assumed" rule (`subagents.mdx:383-385`) conflicts with the user decision to gate on AIR `nativeSubagentSessions`.** Gating is stricter, and conforming either way, since sending fewer updates is always allowed. Note this so no one "fixes" the gate to match the RFD.
4. **The RFD's v2 replay story is internally v1-flavored.** It references `session/load` for authoritative replay (`subagents.mdx:270-298`), but v2 replaces `session/load` with `session/resume` + `replayFrom` (`docs/protocol/v2/migration.mdx:757`). See Open questions.

## Open questions

- **AIR contract.** Does the AIR team accept `_subagent_update` (RFD payload) and `_async_task_spawned`/`_async_task_state_update` as the v2 names? Would they prefer a namespaced form or the unprefixed RFD name? This needs a human decision with AIR; codex-acp cannot settle it from sources.
- **Subagent replay on v2.** How the load-time child-tree reconstruction and orphan `disconnected` synthesis (`src/CodexAcpServer.ts:2140-2233`) maps onto v2 `session/resume` with `replayFrom: {type: "start"}`, versus plain resume, where the RFD forbids standalone terminal updates (`subagents.mdx:291-298`). This belongs to the owner of the v2 resume/replay topic.
- **v1-only standard values on v2 (owned by 1b).** codex-acp emits `tool_call` and `plan`, which do not exist in v2. The v2 SDK's open TS arm and zod catch-all will *not* flag them, so the 1b renderer must map them explicitly (e.g. `tool_call` → `tool_call_update` upsert, `plan` → `plan_update`) and should not rely on `tsc`.
- **Trigger for the rename.** Watch for `subagent_update` appearing on spec `main`'s `schema/v2/schema.unstable.json` and in a TS SDK release. That is the point to switch `_subagent_update` → `subagent_update`, ideally with AIR accepting both during the overlap.

## Decision table

| Update type (today, v1) | Recommended v2 emission | Gate on v2 | Spec-mandated vs judgment call |
|---|---|---|---|
| `subagent_spawned` | `_subagent_update` with the RFD `SubagentUpdate` payload `{subagentSessionId, name, task, capabilities: {}}`; omit `state`; no `null`s | AIR `nativeSubagentSessions` only | `_` prefix: **spec-mandated** (`extensibility.mdx:117`). Merging into the upsert shape: **judgment call** (follows the unmerged RFD) |
| `subagent_state_update` | `_subagent_update` with `{subagentSessionId, state}` (`completed`/`failed`/`cancelled`/`disconnected`) | same | same as above |
| (future) either subagent type after PR #1992 merges | rename the discriminator to `subagent_update` | same | **judgment call** (trigger: the RFD lands in spec `main`'s v2 unstable schema) |
| `async_task_spawned` | `_async_task_spawned`, payload unchanged | AIR `asyncTasks` | `_` prefix: **spec-mandated**. Exact name/namespace: **judgment call** (no upstream design; AIR contract) |
| `async_task_state_update` | `_async_task_state_update`, payload unchanged | AIR `asyncTasks` | same as above |
| `async_task_progress` (type only, never emitted) | `_async_task_progress` if ever emitted | AIR `asyncTasks` | same as above |
| `tool_call_update._meta.jetbrains.air.asyncTasks.backgrounded` | unchanged (`_meta` is already conforming) | AIR `asyncTasks` | spec-permitted (`extensibility.mdx:10`); no change needed |

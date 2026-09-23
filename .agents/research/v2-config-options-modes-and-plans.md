# v2 topic: Config options, modes & plans

Spec checked at `agent-client-protocol` local checkout, commit `8c90bb7` ("docs: update
registry agents (#2217)"), working tree clean (same revision the capability-negotiation
subagent used). SDK checked at `acp-typescript-sdk` local checkout, fetched to `origin/main`
`69fda37` (working tree left untouched — dirty `package-lock.json` pre-existed; all SDK reads
below are via `git show origin/main:<path>`). Installed npm package in codex-acp:
`@agentclientprotocol/sdk@1.4.0`, whose `dist/schema/types.gen.d.ts` (v1) and
`dist/v2/schema/types.gen.d.ts` (v2) were both read directly for wire-shape comparison.

## 0. Headline finding

**Modes already live as config-option-shaped internal state in codex-acp today.** The `AgentMode`
class (`src/AgentMode.ts`) is the *only* mode-like concept with a v1 `SessionMode` wire
representation, and even it already exposes a `toConfigOption()` method that codex-acp puts into
the `configOptions` list on every session response, side by side with the legacy `modes` field.
Two of the three other "mode"-flavored knobs — `CollaborationModeConfig`
(`src/CollaborationModeConfig.ts`) and `FastModeConfig` (`src/FastModeConfig.ts`) — were built
**directly** against the config-option mechanism and have **no** v1 `SessionMode` representation
at all; they were never modeled as ACP "modes" in the protocol sense. The single internal mutator
`applyModeChange(sessionState, value)` (`src/CodexAcpServer.ts:1415-1421`) is shared, verbatim,
between the v1 `session/set_mode` handler and the `MODE_CONFIG_ID` branch of
`session/set_config_option`'s handler. And no `current_mode_update` notification is emitted
anywhere in the codebase — agent-initiated changes (fast-mode slash command, post-plan
collaboration-mode reset) already go out exclusively as `config_option_update` (already the v2
shape), via codex-acp's own forward-compatible `AcpSessionUpdate` union type
(`src/ACPSessionConnection.ts:26`, `src/AcpSessionExtensions.ts`) that is a superset of the
officially-typed v1 SDK `SessionUpdate` union.

**Verdict: this is a thin serialization-layer branch, not divergent internal state**, for both
modes and (mostly) plans — see §5 for the one small genuine v1/v2 behavioral fork (fast-mode's
boolean-support probe) and the one real gap (plan's `type: "items"`/`planId` restructuring for the
structured "update_plan" tool path, which is currently unconditionally v1-shaped).

## 1. v1 modes shapes (from installed `@agentclientprotocol/sdk@1.4.0`, `dist/schema/types.gen.d.ts`)

- `SessionModeState` (`:2561-2580`): `{ currentModeId: SessionModeId; availableModes: Array<SessionMode>; _meta?: {...} | null }`
- `SessionMode` (`:2590-2613`): `{ id: SessionModeId; name: string; description?: string | null; _meta?: {...} | null }`
- `NewSessionResponse`/`ResumeSessionResponse`/`LoadSessionResponse` all carry an optional
  `modes?: SessionModeState | null` field (`:2542`, `:2762`, `:2875`, `:2900`) **alongside** an
  optional `configOptions?: Array<SessionConfigOption> | null` — i.e. v1 already lets an agent
  advertise mode state through *both* channels simultaneously, which is exactly what codex-acp does.
- `session/set_mode` request/response: `SetSessionModeRequest {sessionId, modeId}` →
  `SetSessionModeResponse {_meta?}` (empty object in practice; `:2934-2945`).
- `current_mode_update` session-update variant: `CurrentModeUpdate & {sessionUpdate:
  "current_mode_update"}` (`:3428-3429`) — carries the new mode id.
- `SessionConfigOption` (v1, `:2617-2621`): identical `select`/`boolean` discriminated union to v2
  except the identifier field is named **`id`**, not `configId` (v2 renames it — see §2).

## 2. v2 shapes (spec + SDK)

### Spec (`docs/protocol/v2/session-config-options.mdx`, full file read)

- `ConfigOption`: `configId` (renamed from v1 `id`), `name`, `description?`, `category?`, `type`
  (`select` | `boolean` | custom `_`-prefixed), `currentValue` (`string | boolean`), `options`
  (required for `select`, omitted for `boolean`; flat `ConfigOptionValue[]` or grouped
  `ConfigOptionGroup[]`, never mixed).
- Stable categories: `mode`, `model`, `model_config`, `thought_level` — UX-only, MUST NOT be
  required for correctness, clients MUST tolerate unknown ones.
- `session/set_config_option` request: `{sessionId, configId, type: "id" | "boolean", value}` —
  **`type` is now a required, explicit discriminator on both branches** (v1's id-branch had no
  `type` field at all — see §1). Response/`config_option_update` notification both carry the
  **complete** `configOptions` array (superset semantics for dependent changes) — this rule already
  existed in v1 (TCK notes `ACP-CONFIG-202`/`206` "same encoding as v1's `ACP-MODES-001`/
  `ACP-CONFIG-001`").
- Migration doc's own summary (`docs/protocol/v2/migration.mdx:606-626`, "Session modes become
  config options"): *"The dedicated modes API is removed: the `modes` field on session responses,
  `session/set_mode`, the `current_mode_update` notification, and all `SessionMode*` types.
  Mode-like state ... is expressed through session config options, which already existed in v1."*
  Confirms this is exactly the codex-acp situation the spec authors had in mind.

### SDK v2 generated types (`@agentclientprotocol/sdk/experimental/v2`, `src/v2/schema/types.gen.ts`
in `acp-typescript-sdk@69fda37`, matches installed package)

```ts
export type SessionConfigOption = (
  | (SessionConfigSelect & { type: "select" })
  | (SessionConfigBoolean & { type: "boolean" })
  | { type: string; [key: string]: unknown }  // custom/future, must start with "_"
) & {
  configId: SessionConfigId;
  name: string;
  description?: string | null;
  category?: SessionConfigOptionCategory | null;  // "mode"|"model"|"model_config"|"thought_level"|string
  _meta?: {...} | null;
};
export type SessionConfigSelect = { currentValue: SessionConfigValueId; options: SessionConfigSelectOptions };
export type SessionConfigBoolean = { currentValue: boolean };
export type SessionConfigSelectOptions = Array<SessionConfigSelectOption> | Array<SessionConfigSelectGroup>;
export type SessionConfigSelectOption = { value: SessionConfigValueId; name: string; description?: string|null; _meta?; };
export type SessionConfigSelectGroup = { groupId: SessionConfigGroupId; name: string; options: Array<SessionConfigSelectOption>; _meta?; };

export type SetSessionConfigOptionRequest = (
  | { value: SessionConfigValueId; type: "id" }
  | { value: boolean; type: "boolean" }
  | { type: string; value: unknown }  // custom/future
) & { sessionId: SessionId; configId: SessionConfigId; _meta?: {...} | null };

export type SetSessionConfigOptionResponse = { configOptions: Array<SessionConfigOption>; _meta?: {...} | null };
export type ConfigOptionUpdate = { configOptions: Array<SessionConfigOption>; _meta?: {...} | null };
// SessionUpdate union member: (ConfigOptionUpdate & { sessionUpdate: "config_option_update" })
```

`grep -c "SessionMode" src/v2/schema/types.gen.ts` → **0 matches**. Confirms the migration doc's
claim literally at the type level: `SessionMode`, `SessionModeState`, `SetSessionModeRequest/
Response`, `CurrentModeUpdate`, and the `modes` field are **all absent** from the v2 generated
types — there is no v2 fallback path for them at all, not even as deprecated/optional fields.

## 3. TCK requirement texts (`/Users/eugene/Documents/JetBrains/projects/acp-tck/src/tck/v2/requirements.py`)

- **`ACP-CONFIG-201`** (CAPABILITY, `inferred:configOptions`): every `configOptions` entry in
  `session/new`'s result validates — `configId`/`name` present, `type` selects the right shape
  (`select` requires `currentValue`+`options`; `boolean` requires `currentValue`), and a `select`
  entry's `options` is flat or grouped, never mixed. "Inferred support, same encoding as v1's
  `ACP-MODES-001`/`ACP-CONFIG-001`."
- **`ACP-CONFIG-202`** (CAPABILITY): `session/set_config_option` responds with the **complete**
  `configOptions` list — every previously-advertised `configId` present (superset check; may add
  options or change other values for dependent changes). SKIPs on `-32601` if no `configOptions`
  were ever advertised.
- **`ACP-CONFIG-203`** (CAPABILITY): `session/resume`'s `configOptions`, when present, validates
  the same way as `ACP-CONFIG-201` — new carrier in v2 (v1's `session/load` had no analogue).
- **`ACP-CONFIG-204`** (CAPABILITY): a `select`-type option's `currentValue` is one of its declared
  `options` values (flat or grouped) — derived from the spec's "always provide a default value"
  MUST, not itself schema-enforced.
- **`ACP-CONFIG-206`** (CAPABILITY): an observed `config_option_update` carries the complete
  configuration state — its `configId` set is a superset of the last known set. Vacuous/SKIPPED if
  no such update is ever observed.
- **`ACP-PATCH-205`** (CAPABILITY): every `plan_update.plan` — including an unknown/`_`-prefixed
  `type` variant — carries a non-empty `planId`. SKIPs if no `plan_update` is ever observed.

No `ACP-MODES-*` rows exist in the v2 registry at all (confirmed: the v1 registry's mode rows have
no v2 counterpart, consistent with the API being removed rather than re-gated).

## 4. Plans: v1 vs v2 shapes

### v1 (flat, no identity) — `docs/protocol/v2/migration.mdx:532-570` ("Plans" section)

```json
{ "sessionUpdate": "plan", "entries": [{ "content": "...", "priority": "high", "status": "pending" }] }
```
"The v1 `plan` update was a flat entries list with no identity and no room to grow."

### v2 (`docs/protocol/v2/agent-plan.mdx`, full file read; `migration.mdx:551-570`)

```json
{
  "sessionUpdate": "plan_update",
  "plan": { "type": "items", "planId": "plan-1", "entries": [{ "content": "...", "priority": "high", "status": "pending" }] }
}
```

- `plan` is a **tagged union keyed by required `planId`** — stable v2 defines only the `items`
  content type; `file`/`markdown` variants exist in the SDK's generated types
  (`PlanUpdateContent = (PlanItems & {type:"items"}) | (PlanFile & {type:"file"}) | (PlanMarkdown &
  {type:"markdown"}) | {type: string, planId, ...}` — the latter two remain **unstable** per spec
  prose: "Additional plan operations remain unstable while the Plan Operations RFD is in
  progress"). Every variant, including custom/unknown ones, MUST carry `planId`.
  `PlanEntry` (`content`, `priority`, `status`, all required) is byte-identical to v1's entry
  shape; `priority`/`status` are now open enums (`status` additionally gains `cancelled`).
- Each `plan_update` for a given `planId` **replaces** that plan's entries wholesale (same
  replace-not-merge semantics as v1). `planId` exists purely so **multiple concurrent plans** can
  be tracked per session and so future content types (markdown/file) can share the notification
  kind without another breaking change.
- SDK type (`src/v2/schema/types.gen.ts`): `PlanUpdate = { plan: PlanUpdateContent; _meta?: {...} |
  null }`; `PlanItems = { planId: PlanId; entries: Array<PlanEntry>; _meta?: {...} | null }`;
  `PlanId = string`.

## 5. Current codex-acp implementation

### Modes / config options (`src/AgentMode.ts`, `src/CollaborationModeConfig.ts`,
`src/FastModeConfig.ts`, `src/ModelConfigOption.ts`, `src/CodexCommands.ts`,
`src/CodexAcpServer.ts`)

- **`AgentMode`** (`src/AgentMode.ts:8-133`) — three static instances (`ReadOnly`, `Agent`,
  `AgentFullAccess`) each carrying approval/sandbox policy plus **both** wire projections:
  - `toSessionMode()`/`toSessionModeState()` (`:83-97`) — v1 `SessionMode`/`SessionModeState`.
  - `toConfigOption()` (`:99-114`) — `SessionConfigOption` with `id: MODE_CONFIG_ID` ("mode"),
    `category: "mode"`, `type: "select"`, `options` built from the same three static instances,
    each carrying a `_meta: {kind}` extension.
  - Both projections are pure, side-effect-free derivations of the *same* `AgentMode` enum value
    stored once per session (`sessionState.agentMode`).
- **`CollaborationModeConfig`** (`src/CollaborationModeConfig.ts:10-23`) — `default`/`plan` toggle,
  **only** ever expressed as a `SessionConfigOption` (`COLLABORATION_MODE_CONFIG_ID =
  "collaboration_mode"`, `category: "collaboration_mode"`, `type: "select"`). No `SessionMode`
  counterpart exists or ever existed for this concept.
- **`FastModeConfig`** (`src/FastModeConfig.ts:21-57`) — on/off toggle, **only** ever expressed as
  a `SessionConfigOption`, but with a v1-only wrinkle: `clientSupportsBooleanConfigOptions()`
  (`:21-23`) reads a non-standard `clientCapabilities?.session?.configOptions?.boolean` probe (not
  part of the official v1 SDK `ClientCapabilities` type — a codex-acp/extension field) to decide
  whether to emit `type: "boolean"` (`createFastModeConfigOption(enabled, true)`) or fall back to a
  `type: "select"` on/off pair (`createFastModeConfigOption(enabled, false)`) for older v1 clients
  that predate boolean-typed config options.
- **Shared mutator**: `applyModeChange(sessionState, value)` (`CodexAcpServer.ts:1415-1421`) looks
  up `AgentMode.find(value)` and assigns `sessionState.agentMode`. It is called from **both**:
  - `setSessionMode(_params: acp.SetSessionModeRequest)` (`:1345-1357`, the v1 `session/set_mode`
    handler) — 13 lines, pure passthrough to `applyModeChange`.
  - `applySessionConfigOption`'s `case MODE_CONFIG_ID` branch (`:1379-1381`, the shared
    `session/set_config_option` handler, used by both v1 and — once wired — v2).
- **`applySessionConfigOption`** (`:1374-1394`) is the single switch statement covering all five
  config ids today (`FAST_MODE_CONFIG_ID`, `MODE_CONFIG_ID`, `COLLABORATION_MODE_CONFIG_ID`,
  `MODEL_CONFIG_ID`, `REASONING_EFFORT_CONFIG_ID`) — this is already the v2-shaped dispatcher; v2
  needs no new dispatch logic, only a new wire-parsing wrapper (see §6).
- **`createSessionConfigOptions(sessionState)`** (`:1766-1797`) builds the full array — including
  `sessionState.agentMode.toConfigOption()` — and is called from `session/new`, `session/resume`,
  `session/set_config_option`'s response, and every `config_option_update` notification site.
- **Double-advertisement today**: `newSession`/`resumeSession` (`:834-838`, `:853-857`) return
  `{ models: modelState, modes: modeState, ...this.createSessionConfigOptionsResponse(...) }` — the
  v1 `modes` field is populated from `sessionState.agentMode.toSessionModeState()`
  (`CodexAcpServer.ts:754`, `:2014`) *in addition to* the config-option list that already contains
  the same mode as a `configId: "mode"` entry. This is the empirical proof that codex-acp's
  internal model was never mode-shaped in the ACP sense — it was config-option-shaped from the
  start, with the v1 `modes` field bolted on as an additional serialization for v1 clients.
- **No `current_mode_update` is ever emitted** (confirmed via `grep -n "current_mode_update"` —
  zero hits). Every agent-initiated config/mode change already surfaces as `config_option_update`
  (`CodexAcpServer.ts:2928-2939` for the `/plan`-adjacent fast-mode slash-command path,
  `:3108-3114` for the post-plan-approval collaboration-mode reset) via codex-acp's own
  forward-compatible `AcpSessionUpdate` type (`src/ACPSessionConnection.ts:26`,
  `src/AcpSessionExtensions.ts`), which is a **superset of the officially-typed v1 SDK
  `SessionUpdate` union** — i.e. codex-acp already ships a v2-shaped notification today, riding on
  top of v1 transport, tolerated by v1 clients as an unrecognized-but-harmless update kind.
- **v1 wire-shape delta codex-acp must still parse for**: the v1 SDK's `SetSessionConfigOptionRequest`
  id-branch has **no `type` field at all** (`node_modules/.../dist/schema/types.gen.d.ts:5102-5113`
  — `{value: boolean, type: "boolean"} | {value: SessionConfigValueId}`, no `type` on the second
  branch), whereas v2 requires an explicit `type: "id"` on both branches. codex-acp's
  `stringConfigValue`/`applyFastModeChange` (`:1396-1413`) already disambiguate purely by
  `typeof params.value` rather than by a `type` field, so they're already resilient to both v1's
  implicit-id-branch and v2's explicit `type: "id"` — no parsing change needed, though a v2-typed
  wrapper would have `params.type` available if a future custom variant needs it.

### Plans (`src/PlanCapabilities.ts`, `src/CodexEventHandler.ts`, `src/CodexAcpServer.ts`)

Two structurally distinct "plan" features exist, at different levels of v2-readiness:

1. **Structured tool-driven plan** (Codex's native `update_plan`/`TurnPlanUpdatedNotification`) —
   `CodexEventHandler.updatePlan()` (`src/CodexEventHandler.ts:1169-1179`) **unconditionally**
   emits the pure v1 shape: `{ sessionUpdate: "plan", entries: [...] }` — flat, no `planId`, no
   client-capability gate at all. **This is the one genuine gap**: v2 needs `{ sessionUpdate:
   "plan_update", plan: { type: "items", planId, entries } }` instead, and today there is no
   `planId` concept anywhere near this code path (Codex's plan tool has no stable plan identifier
   in its own event; codex-acp would need to mint/track one — e.g. a per-session constant plan id,
   since this feature can only have one instance per turn today).
2. **Narrative "plan" thread item** (Codex's plan-as-markdown-text feature, a distinct
   `ThreadItem & {type: "plan"}`) — `createPlanHistoryUpdate()`/`createPlanUpdateEvent()`
   (`CodexAcpServer.ts:2374-2392`, `CodexEventHandler.ts:1008-1017`) **already** emit the v2 shape
   conditionally: `{ sessionUpdate: "plan_update", plan: { type: "markdown", planId: item.id,
   content } }`, gated on `clientSupportsPlanUpdates(this.clientCapabilities)`
   (`src/PlanCapabilities.ts:3-7`, which checks a non-standard `clientCapabilities?.plan != null` —
   again a codex-acp/extension probe with no v1 SDK type equivalent), falling back to a plain
   `agent_message_chunk` for clients that don't advertise it. Note `type: "markdown"` here is one
   of the **unstable** v2 plan content variants (per `agent-plan.mdx:12`), not the stable `items`
   type the TCK's `ACP-PATCH-205` and the migration doc's canonical example use — this feature is
   already ahead of stable v2, riding an extension capability, and will need re-validating once the
   Plan Operations RFD stabilizes markdown/file plan types.
- **`PlanCapabilities.ts`** itself is a 7-line file with a single predicate; trivially reusable
  as-is for both v1 (as an extension capability check) and v2 (once `session/new`'s v2 handler
  populates equivalent capability state) — no restructuring needed for the file itself.

## 6. Dual-version cost/risk assessment

**Cheap for config options / modes.** The internal representation
(`sessionState.agentMode`/`.collaborationMode`/`.fastModeEnabled`, the `AgentMode`/
`CollaborationModeConfig`/`FastModeConfig` builders, and the single `applySessionConfigOption`
dispatcher) needs **zero changes** to serve v2. What's needed:
- A v2-typed `setSessionConfigOptionV2` wrapper (or reuse of the existing method with a v2-typed
  params/response signature) that calls the same `applySessionConfigOption`/
  `createSessionConfigOptions` — pure serialization-layer duplication, same pattern as
  `initializeV2` from the capability-negotiation topic.
- Field rename awareness at the wire boundary only: v2's `SessionConfigOption.configId` vs v1's
  `SessionConfigOption.id` — codex-acp's builders (`ModelConfigOption.ts`, `AgentMode.ts`,
  `CollaborationModeConfig.ts`, `FastModeConfig.ts`) all currently construct objects with a field
  literally named `id: MODE_CONFIG_ID` etc. (typed against v1 `acp.SessionConfigOption`). These
  builders need either a v2-typed sibling (renaming `id`→`configId`) or a small mapping shim at the
  v2 handler boundary; the *values* (ids, names, categories, options) are identical either way.
- **The v1 `session/set_mode` handler and `modes` response field are dropped entirely from the v2
  chain** — not ported, not adapted, simply not wired into `v2Agent`'s registration (per the
  spec, v2 has no equivalent at all, confirmed by the 0-hit grep in §2). v1's chain keeps
  `setSessionMode` and the `modes` field exactly as-is, since v1 clients still expect them.
- One **genuine small behavioral fork**: `FastModeConfig`'s `clientSupportsBooleanConfigOptions`
  probe/select-fallback exists only because *some v1 clients* predate boolean-typed config
  options. Every v2 client, by construction, supports `type: "boolean"` (it's baseline schema, not
  an extension) — so the v2 path can unconditionally call
  `createFastModeConfigOption(fastModeEnabled, true)` and skip the probe/fallback branch entirely.
  This is the one place where v1 must keep more logic (the capability probe + select fallback) than
  v2 needs — a subtractive fork, not an additive one, and confined to a single call site.

**Slightly more work, but still scoped, for plans.** The narrative-plan path (item 2 in §5) is
already v2-shaped and needs no new work beyond eventually adopting the stable `items` type instead
of the unstable `markdown` type once that becomes the sanctioned representation for this feature.
The structured tool-plan path (item 1 in §5) needs real, if small, new logic: mint a stable
`planId` (codex-acp doesn't currently have one for this feature — likely a per-session constant,
since only one structured plan exists per turn today) and switch `updatePlan()`'s v2-chain output
from `{sessionUpdate: "plan", entries}` to `{sessionUpdate: "plan_update", plan: {type: "items",
planId, entries}}`. The v1 chain keeps emitting the flat `plan` shape unchanged. This is a
straightforward *parallel construction function* (same pattern as `initializeV2`), not a rewrite —
the entry-mapping logic (`status`/`content`/`priority` derivation from `TurnPlanUpdatedNotification`)
is reused verbatim; only the outer envelope changes.

**No blockers found.** Both the config-options and plans migrations fit the "thin protocol surface
behind shared application logic" pattern the spec recommends for dual-version support
(`migration.mdx:770-772`, cited by the capability-negotiation research). The only work that isn't
literally free is: (a) v2-typed builder/wrapper functions at the wire boundary (renaming `id`→
`configId`, adding explicit `type` handling), (b) dropping the fast-mode boolean-support probe in
the v2 path, and (c) minting a `planId` for the one plan feature that doesn't have one yet.

## 7. Files touched (for the eventual implementation subagent — not edited here)

- `src/AgentMode.ts`, `src/CollaborationModeConfig.ts`, `src/FastModeConfig.ts`,
  `src/ModelConfigOption.ts` — need v2-typed builder variants (or a mapping shim) for the
  `id`→`configId` rename; internal logic unchanged.
- `src/CodexAcpServer.ts` — add `setSessionConfigOptionV2` (thin wrapper around
  `applySessionConfigOption`/`createSessionConfigOptions`); drop `modes`/`setSessionMode` from the
  v2 registration chain only (v1 chain keeps them, `:1345-1357`, `:754`, `:834-838`, `:853-857`,
  `:2014`); adjust `createFastModeConfigOption` call site (`:1791-1794`) to skip the boolean-probe
  fallback on the v2 path.
- `src/CodexEventHandler.ts` — `updatePlan()` (`:1169-1179`) needs a v2-chain variant emitting
  `plan_update`/`type:"items"`/`planId`; `createPlanUpdateEvent`/`createPlanHistoryUpdate`
  (`:1008-1017`, `CodexAcpServer.ts:2374-2392`) need no change (already v2-shaped, modulo the
  unstable `markdown` vs stable `items` type distinction).
- `src/PlanCapabilities.ts` — no change; predicate is already generically reusable.
- `src/CodexCommands.ts` — no change; already calls `setConfigOption` through the shared
  `CommandHandleOptions.setConfigOption` callback (`:34`, `:225-226`), which is version-agnostic.

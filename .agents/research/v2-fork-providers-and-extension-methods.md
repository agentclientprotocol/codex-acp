# Topic 10: `session/fork`, `providers/*`, `_session/goal`, `_session/async_task/stop` on ACP v2

**Sources checked:**
- ACP spec `agent-client-protocol` @ `d8805733` (2026-09-24; `pull --ff-only`: already up to date).
- ACP TS SDK `acp-typescript-sdk` @ `69fda37` (origin/main = release 1.5.0 `f1ba3a9` + 1 transport fix;
  `pull --ff-only` up to date; only untracked `.idea/`, `v2_negotiation.md` in the tree). Installed in
  codex-acp: `node_modules/@agentclientprotocol/sdk` **1.5.0** (`package.json:68` `~1.5.0`). Where the
  source and the installed `dist` are both cited, they match.
- codex-acp @ `6affa50` (branch `eugenethedev/acp-v2`), Codex pinned `@openai/codex ^0.156.1` (`package.json:69`).
- acp-tck @ `64b62b6` (`src/tck/v2/requirements.py`, `src/tck/v2/conformance/*`).

**Confidence:** high for schema status, shapes, and SDK exposure: I read the schema JSON, the SDK
source and the installed `dist`. Medium for the provider-restart and fork-subscription notes. Those
come from reading codex-acp code and are labelled as hypotheses.

## Answer

- **All four surfaces are non-stable on v2.** `session/fork` and `providers/{list,set,disable}`
  exist only in the **unstable** v2 schema (`schema/v2/meta.unstable.json:6-8,16`; absent from
  `meta.json`). Both RFDs are **Draft** (`docs/docs.json:186-195`). `_session/goal` and
  `_session/async_task/stop` are codex-acp's own `_` extensions.
- **What changes on v2:**
  - Fork: the v2 response **drops `modes`**, and `configOptions` becomes a non-null optional array.
  - Providers: the shapes are field-for-field identical to v1, apart from `format: uri` on
    `baseUrl`. The v2 SDK enforces that format, so it rejects a non-URL `baseUrl` with -32602
    before codex-acp sees the request.
  - Extensions: v2 has no rule changes for extension methods. The only new v2 rule concerns
    `_`-prefixed *enum/union values*, not method names.
- **No replay, and no new prompt/state obligations.**
  - `session/fork` has no replay (`replayFrom`) or primer obligation.
  - `_session/goal` is not a prompt. The Codex goal turn it triggers is an unowned
    (Codex self-started) turn, and the existing tracker already brackets it with `running` → one
    `idle`.
- **codex-acp already advertises these features on v2 but has not registered the methods.**
  `capabilities.session.fork`, `capabilities.providers` and `_meta.goal.controlMethod:
  "_session/goal"` are all in the v2 `initialize` response (`src/CodexAcpServer.ts:593,605,617-622`).
  None of these methods is on the v2 chain (`src/AcpAgentRouter.ts:137-153`), so v2 clients get
  -32601 for methods the agent advertises.
- **Most logic is shareable:**
  - fork: a thin `forkSessionV2` wrapper;
  - providers: direct delegates;
  - extension methods: the same zod parsers plus `extMethod`.
- **TCK coverage is thin.** The TCK tests none of these methods. The only related row is the
  advisory ACP-EXT-202, which flags `capabilities.providers` because the TCK validates against the
  *stable* v2 schema, where `providers` doesn't exist.

## Requirements

| # | Requirement | Tier | Citation |
|---|---|---|---|
| R1 | `session/fork` is advertised by `capabilities.session.fork: {}` | capability:`session.fork` (UNSTABLE; RFD Draft) | spec `schema/v2/schema.unstable.json:3479` (`SessionCapabilities`), `:3743` (`SessionForkCapabilities`); `docs/rfds/session-fork.mdx:45-47`; `docs/rfds/v2/required-session-methods.mdx:63-64` ("remains an unstable optional capability") |
| R2 | Fork request: `sessionId`, `cwd` required; `additionalDirectories`, `mcpServers`, `_meta` optional | capability:`session.fork` | `schema/v2/schema.unstable.json:8480` |
| R3 | Fork response: `sessionId` (req.), `configOptions?` (non-null array), `_meta?`; **no `modes`** | capability:`session.fork` | `schema/v2/schema.unstable.json:4989`; v1 `schema/v1/schema.unstable.json:4174` has `modes` + nullable `configOptions` |
| R4 | Agent MAY reject a fork it can't support (e.g. different cwd) with an error | MAY (RFD) | `docs/rfds/session-fork.mdx:65-66` |
| R5 | Unstable v2 features are not implied by `protocolVersion: 2`; gate each by its own capability | MUST-equivalent guidance | `docs/protocol/v2/migration.mdx:22` |
| R6 | Providers support advertised by `capabilities.providers: {}` (agent-level) | MUST advertise if supported (RFD Draft); capability:`providers` (UNSTABLE) | `docs/rfds/custom-llm-endpoint.mdx:332`; `schema/v2/schema.unstable.json:3407` (`AgentCapabilities.providers` at `:3435`), `:3767` |
| R7 | Provider methods only after `initialize`; agents SHOULD apply changes to sessions created/loaded after the change, MAY skip running sessions | MUST / SHOULD / MAY (RFD) | `docs/rfds/custom-llm-endpoint.mdx:333` |
| R8 | `providers/set`: unknown id / unsupported `apiType` / malformed params → SHOULD `invalid_params`; omitted `headers` = empty map | SHOULD (RFD) | `custom-llm-endpoint.mdx:337`; v2 `SetProviderRequest.baseUrl` `format: uri` `schema/v2/schema.unstable.json:8086` |
| R9 | `providers/disable`: disabled provider MUST be listed with `current` omitted/`null`; `required: true` → MUST `invalid_params`; unknown id SHOULD succeed | MUST / SHOULD (RFD) | `custom-llm-endpoint.mdx:336,338,349` |
| R10 | Custom methods MUST be `_`-prefixed (MAY expose them); unknown ones answered with Method not found | MAY (conditioned on `_`); unchanged v1→v2 | `docs/protocol/v2/extensibility.mdx:43,52`; diff v1↔v2 `extensibility.mdx` changes only the `_meta` wording and adds the enum-variant section (`v2 :111-123`) |
| R11 | Custom enum/union values MUST be `_`-prefixed | MUST (v2-only) | `docs/protocol/v2/extensibility.mdx:113-118`. Relevant to the renderer cases (`subagent_*`/`async_task_*`), not to the extension *methods* |
| R12 | Extension capabilities SHOULD go in a capability object's `_meta` | SHOULD | `extensibility.mdx:93,124-149` (basis of TCK EXT-202) |
| R13 | `running` when foreground work starts; `idle` (with stopReason when ending work) when ready | MUST | `docs/protocol/v2/prompt-lifecycle.mdx:188,377` |
| R14 | Background updates MAY flow while `idle` | MAY | `prompt-lifecycle.mdx:39,526` |

## Details

### 1. `session/fork` on v2

**Wire diff v1 → v2.** Both are unstable. Sources: v1 `schema/v1/schema.unstable.json:7168,4174`
and v2 `schema/v2/schema.unstable.json:8480,4989`.

| Field | v1 | v2 |
|---|---|---|
| req `sessionId`, `cwd` | required, `cwd: string` | required, `cwd: AbsolutePath` (SDK zod is `z.string()`, so there is no runtime difference: `dist/v2/schema/zod.gen.js:238`) |
| req `additionalDirectories` | `string[]` optional | `AbsolutePath[]` optional |
| req `mcpServers` | `McpServer[]` optional | `McpServer[]` optional, v2 union (`type` required, no `sse`). **Not removed.** Topic 7 kept it and made it opaque through `WithAcpMcpServers` (`src/McpServerConfig.ts:9,91`) |
| req `_meta` | yes | yes. It carries AIR's `_meta.jetbrains.air.fork` fork point, and SDK zod keeps `_meta` (`zod.gen.ts:3762`) |
| resp `modes` | optional | **absent** |
| resp `configOptions` | `array \| null` | `array` (optional, not nullable) |

**Advertising.** v2 `initialize` already returns `capabilities.session.fork: {}`
(`src/CodexAcpServer.ts:605`, snapshot `src/__tests__/CodexACPAgent/data/initialize-v2-response.json:20`).
There is nothing to change here. Keep it only once the handler is registered (R5).

**Replay and state.** None required.
- The RFD and schema define no replay field on fork. Replay is a `session/resume` concern
  (`replayFrom`), and the v2 protocol docs never mention fork (`rg fork docs/protocol/v2/*.mdx`
  finds nothing outside `draft/schema.mdx`).
- No v2 rule requires a `state_update` when a session is created. `idle` is due only when the agent
  becomes ready *after* work (R13), and codex-acp sends no initial state for `session/new` either.
- A client that wants the forked history calls `session/resume {replayFrom:{type:"start"}}` on the
  new id, which goes through the existing 5b path.
- Known caveat, already unscheduled in `state.md`: the response-item fallback misses the inherited
  prefix of forked threads.

**v1 fork handler.** Source: `src/CodexAcpServer.ts:1223-1240`, then `tryCreateSession(params,
"fork")` at `:808-936`, then `CodexAcpClient.forkSession` at `src/CodexAcpClient.ts:611-625`, then
`src/SessionFork.ts:25-56`. The steps:
1. Wait for any in-flight provider update.
2. `checkAuthorization`.
3. `refreshSkills`.
4. Resolve AIR's `_meta.jetbrains.air.fork` point to `lastTurnId` (`SessionFork.ts:58-85`). It
   matches any item id, or an agentMessage SHA-256 fingerprint.
5. Codex `thread/fork {excludeTurns:true, config, cwd, lastTurnId?, modelProvider, threadId}`, then
   `thread/unsubscribe` on the new thread (`SessionFork.ts:31-43`).
6. Fetch models, then `installSessionState`, which also installs the baseline turn tracker
   (`:966-1004`).
7. Because `canPublishSessionUpdates = false` for fork (`:915`), a fork sends **no**
   `available_commands_update` and no MCP-startup status, and no goal/async-task publish (those are
   resume-only, `:928-931`).
8. On error, call `handleError`.

**Shareable.** Everything above. The v2 handler only needs to reshape the response, the same way
`newSessionV2` (`:1360-1366`) and `resumeSessionV2` (`:1210-1221`) do:

```ts
async forkSessionV2(params: acpV2.ForkSessionRequest): Promise<acpV2.ForkSessionResponse> {
    const {sessionId} = await this.forkSession(params);          // v1 body unchanged
    return {sessionId, ...this.createSessionConfigOptionsResponseV2(this.getSessionState(sessionId))};
}
```

`forkSession`'s parameter type must widen to `WithAcpMcpServers<acp.ForkSessionRequest>`. This is
type-only, the same change 5a made for new/resume. `tryCreateSession` already accepts it (`:811`).

**Why the reshape is mandatory.** The v2 SDK does **not** serialize or strip built-in responses,
except for `initialize` (`src/v2/acp.ts:2218-2220`; the fork spec at `:2347-2353` has no
`serializeResponse`). Returning v1's `{modes, …}` would therefore put `modes` on the v2 wire.

**AIR fork-point ids on v2.**
- Agent `messageId` on v2 is the Codex item id when one exists (`src/AcpV2SessionUpdate.ts:107`,
  which falls back to `randomUUID()`), so direct id lookup still works.
- When the id is random, the fingerprint fallback covers the lookup.
- A v2 *user* messageId is `clientId ?? item.id`. `resolveForkTurnId` matches only `item.id`, so
  a fork point at a live v2 user message would miss (see Open questions). AIR's fingerprint path is
  agentMessage-only, which suggests fork points are agent messages.

**SDK exposure.**
- Method name: `acpV2.methods.agent.session.fork` = `"session/fork"` (`src/v2/acp.ts:755`).
- Handler type: `AgentRequestHandler<ForkSessionRequest, ForkSessionResponse>` (`:2568-2571`). The
  response is required: no `| void`, and it is not wrapped in `emptyObjectResponse`.
- Registration: `.onRequest(acpV2.methods.agent.session.fork, (ctx) => getAgent().forkSessionV2(ctx.params))`.
  It takes no parser; passing one throws "Cannot replace the built-in…" (prior research
  `v2-extension-capabilities-placement.md` §C).
- Inbound params are parsed by `zForkSessionRequest` (`src/v2/schema/zod.gen.ts:3762`). That
  parser strips unknown root keys and applies `defaultOnError` to `additionalDirectories`,
  `mcpServers` and `_meta`, so invalid items are skipped rather than rejected.
- The SDK has no v2 fork tests (`rg fork src/v2/acp.test.ts`: none). The client-side
  `ActiveSession` helper attaches only to `session/new` responses (`acp.ts:1150-1158`), so an SDK
  client must drive a forked session through raw requests.

### 2. `providers/list|set|disable` on v2

**Wire diff.** Same fields, required-ness and nullability on both versions: v1
`schema/v1/schema.unstable.json:3531,3553,6763,6805` vs v2 `schema/v2/schema.unstable.json:4406,4428,8086,8129`.
Installed SDK types agree (`dist/v2/schema/types.gen.d.ts:2488-2567,4816`). Differences:
- **`baseUrl` gains `format: uri`** in `SetProviderRequest` and `ProviderCurrentConfig`.
  - The v2 SDK enforces this inbound with `z.url()` (`src/v2/schema/zod.gen.ts:3560-3563`; v1
    `src/schema/zod.gen.ts:3321-3324` uses `z.string()`), so a v2 `providers/set` with a non-URL
    `baseUrl` gets -32602 from the SDK before codex-acp runs.
  - This is consistent with R8, and there is no v1 impact.
  - Outbound `providers/list` isn't validated, so `current.baseUrl` from `config.toml` goes out
    verbatim (`acp.ts:2218-2220`).
- `LlmProtocol`'s open fallback is documented as `_`-prefixed = custom
  (`schema/v2/schema.unstable.json:4477`). codex-acp's `supported` list is
  `Object.keys(SUPPORTED_GATEWAY_PROTOCOLS)` (`src/CodexAcpClient.ts:421`). If those are standard
  names, nothing changes (not re-verified here).

**Advertising.** `capabilities.providers: {}` is already emitted (`src/CodexAcpServer.ts:593`), at
the location the unstable schema defines (R6). For EXT-202, see §4.

**Shareable.** All of it. `listProviders`, `setProvider` and `disableProvider`
(`src/CodexAcpServer.ts:1430-1446`, `src/CodexAcpClient.ts:404-490`) plus `enqueueProviderUpdate`
(`:1449-1505`) are version-agnostic. Register them as direct delegates, as topic 8 did for
`auth/*`:
- `.onRequest(acpV2.methods.agent.providers.list, (ctx) => getAgent().listProviders(ctx.params))`
- `set` and `disable` the same way.

The v2 handler types are `AgentRequestHandler<ListProvidersRequest, ListProvidersResponse>` and
`<SetProviderRequest|DisableProviderRequest, …Response | void>` (`src/v2/acp.ts:2532-2543`). Method
names are at `:746-749`; specs are at `:2275-2303`, where set and disable use `emptyObjectResponse`.
The types are structurally identical, so no casts should be needed (hypothesis; the compiler will
confirm).

**Pre-existing v1 behavior that looks like an RFD deviation (flag only).**
`disableProvider("openai")` clears the gateway override. `listProviders` then reports
`current = native OpenAI config` (`CodexAcpClient.ts:406-411,472-490`), never `null`, and
`required: false`. The RFD says a disabled provider MUST be listed with `current` null/omitted and
MUST NOT be used (R9). codex-acp's "disable" really means "revert to native routing". Changing that
would be v1-visible → user decision (Q3).

### 3. `_session/goal` and `_session/async_task/stop` on v2

**Registration.** The v1 registrations work unchanged on v2 through the `ExtensionMethod`
overload. v1 registers them at `src/AcpAgentRouter.ts:134-135`; the parsers are at `:29-44`, with
`.passthrough()`, so `_meta` survives:
- `.onRequest(GOAL_CONTROL_METHOD, goalControlParamsParser, (ctx) => getAgent().extMethod(GOAL_CONTROL_METHOD, ctx.params))`
- the same pattern for `ASYNC_TASK_STOP_METHOD`.

This matches how `_session/steering` is already registered on v2 (`:153`). Do not register the
legacy `_codex/session/goal_control` alias. It isn't registered on v1 either, and it is
unreachable (`v2-extension-capabilities-placement.md:152`).

**No protocol reason for the payloads to differ.**
- The v2 extensibility doc changes nothing for extension methods (R10).
- Params (`sessionId`, `action`, `objective` / `asyncTaskId`) and responses (`{}` / `{stopped}`)
  are custom, and the spec doesn't constrain them.
- The goal snapshot is published as `session_info_update._meta.goal`
  (`src/CodexAcpServer.ts:2278-2297`), which is already a v2 pass-through renderer case. The
  extension doc (`docs/goal-extension.md:7-27`) holds on v2 as written.

**Goal: state and prompt-lifecycle obligations.**
- On 0.156.1 codex-acp starts **no** turn itself for `set` or `resume`. J11 removed the fallback
  (`state.md:80-87`). `extMethod` calls `setGoal`/`resumeGoal` → `runGoalSet`
  (`src/CodexAcpServer.ts:666-705`, `src/CodexAppServerClient.ts:393-483`).
- Codex then auto-starts the goal turn, with no userMessage. `runGoalSet` keeps the
  `_session/goal` request **pending until that goal turn completes** (`:463-476`), or returns once
  no turn starts within the grace period.
- That turn is a Codex self-started turn. `trackCodexTurnStart`/`trackCodexTurnCompletion` → `reportUnownedTurnState`
  (`src/CodexAcpServer.ts:1044-1087`) send `running` at `turn/started` and exactly one `idle`
  (`end_turn`, or `cancelled` if interrupted) at `turn/completed`. Because `_session/goal` isn't
  in `v2PromptsInFlight`, these fire. No `user_message` is sent (J3). This satisfies R13 under the
  J1-J3 user decisions.
- **The pending request is not a prompt.**
  - Wire level: it isn't `session/prompt`, and it has no `messageId` insertion contract.
  - SDK level: the client treats an `idle` as a prompt stop only when an `ActiveSession.prompt()`
    is pending (`src/v2/acp.ts:2839-2851`). `activePrompts` is filled only by `beginPrompt()` from
    `prompt()` (`:1195-1209,1888`), so a pending `_session/goal` is unaffected by the goal turn's
    `idle`.
- A v2 `session/prompt` arriving during the goal turn follows J8 (steer) and M2. Nothing new is
  needed here.
- `pause` and `clear` start no turn. They publish a snapshot only, with no state obligation.

**Async-task stop: state obligations.** None. Stopping a background terminal is idle-time
background activity (R14). But on v2 it is **inert until the renderer cases land**:
- `stop()` returns `false` unless the task's spawn was `"published"`
  (`src/async-tasks/CodexBackgroundTerminalTasks.ts:180-205`).
- On v2, `async_task_spawned` currently goes to the fail-loud renderer case and is never published.
- Even for a published task, `finish` → `publishTerminalState` awaits
  `session.update(async_task_state_update)` (`:337-365`) and would throw.

**So slice 10(a) (the `_async_task_*` renderer cases) must land before the async-stop slice.**

### 4. TCK coverage

`rg -l "fork|providers|_session/goal|async_task" acp-tck/src/tck` finds only false positives. There
are **no v2 or v1 requirements or tests for fork, providers, goal or async-task stop.** Related rows:

| Req id | Tier | What it checks | Test (module::function) |
|---|---|---|---|
| ACP-EXT-202 | ADVISORY | `capabilities` has no root key outside the **stable** vendored `AgentCapabilities` (`session`, `auth`, `_meta`) | `test_extensibility.py::test_extensions_are_advertised_under_capabilities_meta` (`:147-176`); requirement `requirements.py:1349-1358` |
| ACP-EXT-001 | MANDATORY | unknown `_` request gets a response (-32601) | `test_extensibility.py::test_unknown_custom_method_receives_a_response` |
| ACP-EXT-201 | ADVISORY | unknown `_` notification gets no response | `…::test_unrecognized_custom_notification_produces_no_response` |
| ACP-SCHEMA-001 | MANDATORY | initialize exchange validates against the stable schema. It passes with `providers`/`session.fork` because `AgentCapabilities` has no `additionalProperties:false` | `test_initialize.py::test_initialize_exchange_validates_against_schema` |
| ACP-INIT-204 | CAPABILITY | markers are objects (`fork: {}`, `providers: {}` OK) | `test_initialize.py::test_capabilities_markers_are_objects_not_booleans` |
| ACP-SCHEMA-002 | ADVISORY | no unknown root keys over a new+prompt exchange | `test_extensibility.py::test_full_exchange_has_no_unknown_root_keys` |

**The EXT-202 finding is a TCK-versus-unstable-schema mismatch, not a codex-acp defect.**
- The TCK vendors only the stable `schema.json` (`src/tck/v2/validation.py:2`; vendored
  `AgentCapabilities` properties = `session`, `auth`, `_meta`).
- `capabilities.providers` is a typed field in the unstable schema (R6), and the RFD says MUST
  advertise it.
- Moving it to `capabilities._meta.providers` would satisfy the TCK but break the unstable schema
  and every SDK-typed client that reads `capabilities.providers`.
- `session.fork` is nested, so EXT-202 doesn't flag it.

**`-k` filters** (these match module and function names, not requirement ids; `.agents/tck/HOW-TO-RUN.md`):

| Slice | v2 filter | v1 non-regression filter |
|---|---|---|
| 10(a) renderer cases | `-k "test_session or test_prompt"` | `-k "test_session or test_prompt"` |
| any slice touching init/capabilities | `-k "test_initialize or test_extensibility"` | `-k "test_initialize or test_extensibility"` |
| extension methods | `-k test_extensibility` | `-k test_extensibility` |
| fork | `-k "test_session or test_initialize"` (shared `tryCreateSession`; nothing calls fork) | `-k test_session` |
| providers + EXT-202 | `-k "test_extensibility or test_initialize"` | same |

Real coverage for these methods has to come from Vitest.

### 5. Recommended slices (one handler family each)

1. **10(a) renderer cases.** `toV2SessionUpdate`: `subagent_spawned`/`subagent_state_update` →
   `_subagent_update`, and `async_task_*` → `_async_task_*`, as already decided in
   `v2-subagent-and-custom-session-updates.md`. **Prerequisite for 10(c).**
2. **10(b) `_session/goal` on v2.**
   - Change: register it on the v2 chain.
   - Tests (Vitest, v2 harness): `set` → `running`, goal-turn content, one `idle end_turn`,
     `session_info_update._meta.goal` pass-through, then response `{}`; unknown session → -32602;
     blank `objective` → -32602; `pause`/`clear` → snapshot only, no states.
   - This makes the advertised `_meta.goal.controlMethod` true on v2.
3. **10(c) `_session/async_task/stop` on v2** (after 10(a)).
   - Change: register it on the v2 chain.
   - Tests: with AIR `asyncTasks`, a stop yields `{stopped:true}` and `_async_task_state_update
     {state:"stopped"}`; unknown session → `{stopped:false}`; no `state_update` is emitted.
4. **10(d) `session/fork` on v2.**
   - Change: add `forkSessionV2`, widen the `forkSession` param type, and register it.
   - Tests: the response has **no `modes`** and v2-shaped `configOptions` (booleans); a v2
     `mcpServers` entry with `type:"stdio"` is accepted; the AIR `_meta.jetbrains.air.fork` point
     resolves `lastTurnId`; nothing is sent before the response. Keep the v1
     `session-fork.test.ts` unchanged.
5. **10(e) `providers/{list,set,disable}` on v2 plus the EXT-202 decision.**
   - Change: register the three delegates.
   - Tests: list returns the `openai` slot; set with an unknown id → -32602; set with a non-URL
     `baseUrl` → -32602 (from the SDK); disable of an unknown id → `{}`; set with a live session
     restarts and resumes it.
   - Then apply whatever the user decides for EXT-202 (Q1).

Order: 10(a) → 10(b) → 10(c) → 10(d) → 10(e). 10(b) and 10(d) don't depend on 10(a) and could go
earlier. Until each slice lands, v2 advertises a method it answers with -32601.

## Testability notes

- Assert on what an `acpV2.client()` actually **receives** over the in-memory pair, not on handler
  return values. The SDK passes fork and providers responses through verbatim, so a leaked `modes`
  shows up only on the wire.
- A fork test should fail if `"modes" in response`. That is the concrete non-conforming case.
- Goal: order the `running` … `idle` pair relative to the goal turn's `turn/started`/`turn/completed`.
  Whether the `_session/goal` response comes before or after `idle` is racy by construction and
  not protocol-relevant, so don't snapshot that order.
- Async-task stop before 10(a) is observable only as `{stopped:false}`. Don't write a test that
  pins that.
- `baseUrl` URL validation is SDK behavior. One test documents it; it isn't codex-acp logic.
- Provider RFD rule R9 (disabled = `current: null`) is testable, but codex-acp deliberately doesn't
  conform on v1 (Q3). Don't add a test that encodes either answer until the user decides.

## Discrepancies

1. **TCK EXT-202 vs the unstable schema and RFD.** The TCK flags `capabilities.providers`, which the
   unstable v2 schema defines and the RFD requires (MUST). Root cause: the TCK vendors only the
   stable schema.
2. **Advertised but unregistered on v2 today.** `session.fork`, `providers` and `_meta.goal` are all
   advertised (`src/CodexAcpServer.ts:593,605,617-622`), but the methods are not on the v2 chain.
   This currently violates the spirit of R5/R6: clients SHOULD be able to call what is advertised.
3. **Provider "disable" semantics.** codex-acp (v1 and v2) keeps `current` populated with native
   OpenAI routing after `providers/disable("openai")`. RFD R9 says `current` null/omitted (MUST,
   Draft).
4. **SDK vs spec strictness on `baseUrl`.** The v2 SDK rejects non-URI values inbound (`z.url()`);
   the v1 SDK accepts any string. Both sides derive from the schema (`format: uri` exists only in
   v2), so this is an intended v2 tightening, not an error.
5. Minor: the question premise "`mcpServers` removal per topic 7" is inaccurate. v2
   `ForkSessionRequest.mcpServers` still exists (`schema/v2/schema.unstable.json:8480`). Topic 7
   removed only SSE and client `fs/*`/`terminal/*`, and typed the union.

## Open questions

- **Q1 (user decision, no v1 impact): EXT-202.**
  - (a) Keep `capabilities.providers` (schema- and RFD-conformant) and fix or carve out the TCK fork
    so that unstable-schema keys pass. **Recommended**; the user already patched the TCK for
    `_auth/status_update`.
  - (b) Keep it and accept the advisory fail.
  - (c) Move it to `capabilities._meta.providers`. This breaks unstable-schema conformance and
    typed clients.
- **Q2 (user decision, v1 parity):** v1 forks publish no `available_commands_update`
  (`canPublishSessionUpdates=false`, `src/CodexAcpServer.ts:915`). Keep that on v2 (recommended,
  shared logic) or publish on v2 only?
- **Q3 (user decision, v1-visible if changed):** provider-disable semantics vs RFD R9 (Discrepancy 3).
  Recommendation: leave as is and document it in the AIR v2 contract docs (Phase 4).
- **Q4 (hypothesis, needs verification; v1 + v2): provider restart drops the baseline turn
  tracker.**
  - How: `enqueueProviderUpdate` swaps `codexAcpClient` and re-resumes sessions through
    `replacement.resumeSession` (`src/CodexAcpServer.ts:1467-1492`) without
    `installSessionState`/`startCodexTurnTracker`. The subscriptions live in the old client's
    `subagents` registry (`src/CodexAcpClient.ts:936-948`).
  - Effect 1: after `providers/set`/`disable` with live sessions, Codex self-started turns (for
    example a goal auto-turn triggered by that very `thread/resume`) would get no rendering and no
    v2 `running`/`idle`.
  - Effect 2: an **unowned** running goal turn isn't waited for (only `activePrompts` is,
    `:1456-1460`). Killing it could leave a v2 client in `running` with no `idle`, which violates
    R13 (MUST).
  - Route to a programmer or researcher to confirm it with a test before 10(e).
- **Q5 (hypothesis):** v1 fork calls `thread/unsubscribe` on the new thread (`src/SessionFork.ts:43`).
  If the source thread had an active goal and Codex copies it to the fork, an auto goal turn on the
  fork might be invisible until the first prompt resubscribes. Needs a live `/run-codex` check.
  Low priority.
- **Q6 (adjacent):** `resolveForkTurnId` matches only `item.id`. A v2 client forking at a *user*
  message would send `clientId` (`src/SessionFork.ts:64-67`). Adding a `userMessage.clientId` match
  is additive, and v1 never sets `clientId`. Ask AIR whether user-message fork points exist.
- **Q7 (topic 10, not researched here):** child-session primers on native replay, and child-session
  permissions getting no `requires_action` (`state.md:204`). These belong to the renderer and
  subagent slices, not to these methods.

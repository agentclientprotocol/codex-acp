# Where do codex-acp's non-standard/unstable capabilities, extension probes and non-baseline methods live on the v2 wire and v2 handler chain?

**Sources checked:**
- ACP spec repo `agent-client-protocol` @ `c2452704b53af74238d11d9fb0d5f816b802f9df` (2026-09-23, `git pull --ff-only`: already up to date). Also read the unmerged branch `origin/vbr/subagents-rfd` @ `a06ecf2` (2026-09-16) for the subagents RFD. It is a **proposal on a side branch** and is not on `main`.
- ACP TypeScript SDK `acp-typescript-sdk`. `git pull --ff-only` **failed** because the working tree has a pre-existing local change to `package-lock.json`. I did not modify the checkout. The fetch still ran, so every SDK citation below comes from `git show origin/main:<path>` @ `69fda37` (2026-09, which is release 1.5.0 plus one transport fix). `git diff f1ba3a9 69fda37 -- src/v2` changes only 9 lines in `src/v2/acp.ts`. The working tree itself is still at the stale `f1c0141`.
- Installed npm package in codex-acp: `node_modules/@agentclientprotocol/sdk@1.4.0`. This does not match the `package-lock.json` entry, which says `1.5.0` (`package-lock.json:31-33`). I ran runtime zod probes against the installed `dist/`. The origin/main source has the same zod construction, and I cite it for that.
- codex-acp @ `b2678b1` (branch `eugenethedev/acp-v2`).
- Codex app-server: not consulted. Nothing in this question touches Codex app-server fields.

**Confidence:** high for wire placement, SDK registrability and SDK stripping behavior (I checked the schema and SDK source and ran the zod parsers myself). The placement of items that have no upstream home is labelled "judgment call" throughout.

## Answer

Schema reference: the v2 SDK's generated `AgentCapabilities` types come from the **unstable** v2 schema. So `capabilities.providers`, `capabilities.session.fork` and `capabilities.session.mcp.acp` all exist as typed fields, and each is gated by its own marker.

Agent-side advertisements (A):
- **Keep as typed fields:** `sessionCapabilities.fork` becomes `capabilities.session.fork: {}`, and `agentCapabilities.providers` becomes `capabilities.providers: {}`.
- **No v2 home:** `auth.logout`, `sessionCapabilities.subagents`, `mcpCapabilities.sse` and the `list`/`resume`/`close` markers have no v2 field. The v2 SDK **silently strips them from the outgoing `initialize` response.** Its zod `z.object` parse drops unknown keys, and I confirmed this empirically. They must be dropped, or moved into a `_meta` bag.
- **`_meta` survives everywhere:** `_meta` is preserved at every level (`capabilities._meta`, `capabilities.auth._meta`, `capabilities.session._meta`, top-level `_meta`).
- **Top-level extension descriptors:** steering, goal and `jetbrains.air` carry over unchanged in `InitializeResponse._meta`. Spec note: `extensibility.mdx:126` says extension capabilities *SHOULD* go in a capability object's `_meta`, and top-level `_meta` is not one. codex-acp already deviates from that on v1.

Client-side probes (B):
- **Moot on v2:** terminal output mode, boolean config options, plan updates, compaction and notices are all baseline or capability-free, so these probes are not needed.
- **Unchanged:** elicitation `form`/`url` keep the same shape at `capabilities.elicitation`.
- **Move with their container:** the gateway, AIR and terminal-output probes live under `_meta`. They move with the renamed container (`clientCapabilities.*._meta.X` becomes `capabilities.*._meta.X`) and survive the SDK.
- **Cannot be read at all:** the canonical `clientCapabilities.subagents` probe is not a v2 field, and the SDK strips it from the parsed request.

Method registration (C):
- **Built-in methods:** `session/fork` and `providers/*` are v2 built-ins. Register them with the typed overload `onRequest(acpV2.methods.agent.…, handler)`. Passing a parser throws.
- **Legacy non-underscore methods:** `session/load`, `session/set_mode`, `session/set_model`, `authentication/status` and `authentication/logout` *can* be registered through the SDK's `UnrecognizedMethod` overload, `onRequest("name", parser, handler)`. However:
  - v2 removed `session/load` and `session/set_mode`.
  - `session/set_model` is a withdrawn unstable method.
  - Custom methods must be `_`-prefixed to be conforming.
  - My recommendation is not to register any of them on v2.
- **`_`-prefixed extensions:** register them through the `ExtensionMethod` overload with the existing zod parsers, unchanged.

## Requirements

| # | Requirement | Tier | Citation |
|---|-------------|------|----------|
| R1 | Custom request/notification names must start with `_`. Custom requests are allowed only "as long as their name starts with an underscore". | MAY, conditioned on the `_` prefix (non-`_` custom names are not conforming) | spec `docs/protocol/v2/extensibility.mdx:43,52,97`; same text in v1 `docs/protocol/v1/extensibility.mdx:47,56,101` |
| R2 | Extensions SHOULD advertise custom capabilities so callers can check before calling. | SHOULD | spec `docs/protocol/v2/extensibility.mdx:93` |
| R3 | Implementations SHOULD use the `_meta` field *in capability objects* to advertise extensions. The example uses `capabilities._meta`. | SHOULD | spec `docs/protocol/v2/extensibility.mdx:124-149`; client side: "Extension-specific capabilities belong in `_meta`" `docs/protocol/v2/initialization.mdx:115-117` |
| R4 | Implementations MUST NOT add custom fields at the root of a spec type. | MUST | spec `docs/protocol/v2/extensibility.mdx:39` |
| R5 | Custom enum/tagged-union values MUST begin with `_`. Extensions MUST NOT define custom non-underscore values. | MUST | spec `docs/protocol/v2/extensibility.mdx:113-118` (v2-only section; absent in v1) |
| R6 | Unstable v2 features are not implied by `protocolVersion: 2`. Gate each one behind its own capability. | MUST-equivalent guidance (migration guide) | spec `docs/protocol/v2/migration.mdx:22` |
| R7 | No logout marker. `capabilities.auth` advertises only auth-related *extensions*. A non-empty `authMethods` requires both `auth/login` and `auth/logout`. | MUST (agent implements both); "do not add a logout support marker" | spec `docs/protocol/v2/migration.mdx:198,730`; schema `schema/v2/schema.json` `AgentAuthCapabilities` (3387) has only `_meta` |
| R8 | `session/fork` is advertised by `capabilities.session.fork: {}`. | capability:`session.fork` (UNSTABLE) | schema `schema/v2/schema.unstable.json:3743` (`SessionForkCapabilities`), `:3479` (`SessionCapabilities.fork`); `schema/v2/meta.unstable.json` `session_fork`; RFD `docs/rfds/session-fork.mdx:46` (Draft) |
| R9 | `providers/*` is advertised by `capabilities.providers: {}`. RFD: "agents that support provider methods MUST advertise …providers: {}". | capability:`providers` (UNSTABLE; RFD Draft) | schema `schema/v2/schema.unstable.json:3767`, `AgentCapabilities.providers` at `:3407`; RFD `docs/rfds/custom-llm-endpoint.mdx:332` |
| R10 | `mcp.acp` is an object marker. Omitted means unsupported. SSE was removed in v2. | capability:`session.mcp.acp` (UNSTABLE); SSE removed | schema `schema/v2/schema.unstable.json:3635,3707`; `schema/v2/schema.json:3303` (stable `McpCapabilities` = `stdio`,`http` only); spec `migration.mdx:741` ("Drop SSE") |
| R11 | Every support marker is an object. Omitted or `null` means unsupported, and presence checks replace `=== true`. | MUST (schema shape) | spec `docs/protocol/v2/migration.mdx:181-183` |
| R12 | `session/load` and `session/set_mode` are removed in v2. | Removed (checklist: "Remove `session/load`", "Drop `session/set_mode`") | spec `docs/protocol/v2/migration.mdx:42,49,738,739` |
| R13 | Model selection goes through session config options. There is no model API. | Removed | spec `docs/protocol/v2/migration.mdx:608`; spec history `9c10c14` "Remove dedicated session modes and models apis from v2 (#1324)", `822ef53` "Remove unstable session model API (#1325)" |
| R14 | Agents MUST NOT request an elicitation mode the client has not advertised. Form/URL support requires an explicit non-null `form`/`url`. | MUST | spec `docs/protocol/v2/elicitation.mdx:40-55`; `initialization.mdx:131-138` |
| R15 | Stable v2 `plan_update` needs no capability. `ClientCapabilities.plan` is removed. markdown/file plans stay behind the unstable plan-operations surface, with no runtime handshake. | Baseline (stable `items`); unstable variants have no negotiation | RFD `docs/rfds/v2/plan-variants.mdx:58-61`; spec `agent-plan.mdx:12,69` |
| R16 | Compaction and notice updates: "V2 does not add or require a capability." | capability-free on v2 (RFDs: compaction = Preview, notices = Draft) | RFD `docs/rfds/session-compaction.mdx:183`; `docs/rfds/session-notices.mdx:137,158` |
| R17 | Clients tolerate unknown `sessionUpdate` types. | Guidance (migration checklist) | spec `docs/protocol/v2/migration.mdx:760` |
| R18 | Boolean config options are part of the v2 baseline schema, with no client capability. | Baseline | spec `docs/protocol/v2/session-config-options.mdx:96,149-158`; v2 `ClientCapabilities` has no `session` field (`schema/v2/schema.json:5842`) |
| R19 | Agent-owned terminal display is baseline and needs no client capability negotiation. | Baseline | spec `docs/protocol/v2/migration.mdx:191,734` |
| R20 | (Proposal) Subagents: no agent-side capability in either version. In v2 there is no client capability either, and support is "assumed rather than negotiated". | RFD proposal only (unmerged branch) | `origin/vbr/subagents-rfd:docs/rfds/subagents.mdx:52-77,379-385,434-440` |

## Details

### How the v2 SDK treats keys that are not in the schema (this drives most of A and B)

- **Outgoing `initialize` response.** On the agent side, the response is passed through `mapV2InitializeResponse` = `validate.zInitializeResponse.parse(...)`.
  - SDK `src/v2/acp.ts:418-431`. It is wired as the `serializeResponse` of the initialize spec at `src/v2/acp.ts:2258-2264` and applied in `registerAppRequest` at `src/v2/acp.ts:2218-2221`.
  - The zod schemas are plain `z.object(...)` from `zod/v4` (`src/v2/schema/zod.gen.ts:10,1291,1313,1599,1714`). They **strip unknown keys** but keep `_meta` records.
  - **Only `initialize` is serialized this way.** Other built-in responses such as fork and providers have no `serializeResponse` and go out verbatim (`src/v2/acp.ts:2347-2356`, `2218-2220`). Legacy extra fields like `modes`/`models` therefore would **not** be stripped from fork responses. codex-acp must remove them itself.
- **Incoming `initialize` request.** It is parsed by `parseV2InitializeRequest` → `validate.zInitializeRequest.parse` (`src/v2/acp.ts:391-403`, `src/v2/schema/zod.gen.ts:3479,3503`), so unknown client capability keys are stripped before the handler runs. The same applies to the guard path (`src/v2/acp.ts:582-640`).
- **Empirical check (installed 1.4.0 `dist/v2/schema/zod.gen.js`, `node /tmp/probe.mjs`).** I fed codex-acp's candidate v2 response in. The output kept `session.prompt`, `session.mcp.http`, `session.mcp.acp`, `session.delete`, `session.additionalDirectories`, `session.fork`, `session._meta`, `auth._meta`, `providers`, `capabilities._meta.authStatus`, top-level `_meta.steering` and `_meta.jetbrains`. It **dropped** `auth.logout`, `session.subagents`, `session.list`, `mcp.sse`.
- **Same probe on the request side.** It kept `auth.terminal`, `auth._meta.gateway`, `elicitation.form/url`, `_meta.terminal_output_delta`, `_meta.jetbrains.air.*`. It **dropped** `capabilities.subagents`, `capabilities.plan`, `capabilities.session.*`.
- **Contrast with v1.** The installed v1 SDK does *not* validate the outgoing initialize response. `zInitializeResponse` appears only in `dist/acp.test.js`, and the v1 initialize spec is `requestSpec(..., validate.zInitializeRequest)` with no response serializer (`dist/acp.js:594`). That is why codex-acp's non-schema keys (`sessionCapabilities.subagents`) reach v1 clients today and would silently vanish on v2.

### A. Agent-side advertisements

| v1 today (`src/CodexAcpServer.ts:371-431`) | v2 standard home? | Recommended v2 placement |
|---|---|---|
| `sessionCapabilities.fork: {}` (`:376`) | Yes, UNSTABLE `SessionCapabilities.fork: SessionForkCapabilities` (`schema/v2/schema.unstable.json:3479,3743`). SDK type `src/v2/schema/types.gen.ts:1810,2127`; zod keeps it (`zod.gen.ts:1299`). | `capabilities.session.fork: {}`. codex-acp implements fork today: `src/index.ts:152` registers `acp.methods.agent.session.fork` → `CodexAcpServer.forkSession`. |
| `sessionCapabilities.subagents: {}` (`:378`; type `src/subagents/AcpSubagents.ts:35-37`) | No. It is not in the v2 stable or unstable schema on `main`. The RFD proposal says there is no agent-side capability in either version (`subagents.mdx:71-77`). The SDK strips it (empirical). | **Drop** on v2 (judgment). The AIR descriptor already advertises `nativeSubagentSessions` in top-level `_meta.jetbrains.air.capabilities` (`src/CodexAcpServer.ts:425`, documented at `docs/subagent-sessions.md:11`), so AIR clients lose nothing. If a standalone marker is still wanted, the conforming slot is `capabilities.session._meta.subagents: {}`. That is a codex-acp convention, not a spec location. |
| `sessionCapabilities.resume/list/close: {}` (`:372-374`) | No. They are implied by advertising `capabilities.session` (`migration.mdx:190`; `initialization.mdx:150-156`). | Drop. |
| `sessionCapabilities.delete`, `additionalDirectories` | Yes, stable (`schema/v2/schema.json:3159`). | `capabilities.session.delete: {}`, `capabilities.session.additionalDirectories: {}` |
| `agentCapabilities.providers: {}` (`:391`) + `providers/list/set/disable` (`src/index.ts:161-163`) | Yes, UNSTABLE `AgentCapabilities.providers` (`schema/v2/schema.unstable.json:3407,3767`). It is agent-level, not under `session`. The methods are in `schema/v2/meta.unstable.json` `agentMethods`. | `capabilities.providers: {}` |
| `agentCapabilities.auth: {logout: {}}` (`:388-390`) | No. v2 `AgentAuthCapabilities` has only `_meta`, and the migration guide says "do not add a logout support marker" (`migration.mdx:198,730`). The SDK strips `logout` (empirical). | Drop `logout`. The logout surface is implied by non-empty `authMethods`. |
| `agentCapabilities._meta[AUTH_STATUS_META_KEY]` = `authStatus: {}` (`:403-407`; key `src/AuthStatusMeta.ts:35`) | No standard field. `capabilities.auth` is defined as the home of "authentication-related extensions" (`schema/v2/schema.unstable.json` `AgentCapabilities.auth` description; `initialization.mdx:158-161`; `migration.mdx:198`). The `get-auth-state` RFD (Draft) would also nest under `…auth` (`docs/rfds/get-auth-state.mdx:78,245`). | **`capabilities.auth._meta.authStatus: {}`** (judgment). This matches codex-acp's own client-side convention of `auth._meta.gateway`, and it is where the spec says auth extensions go. The alternative, `capabilities._meta.authStatus`, is a mechanical v1→v2 rename and is also valid and preserved by the SDK. Pick one, and do not emit both. |
| `mcpCapabilities.http: true` | Yes: `capabilities.session.mcp.http: {}` (stable). | `capabilities.session.mcp.http: {}` |
| `mcpCapabilities.acp: false` (`:399`) | UNSTABLE `McpCapabilities.acp: McpAcpCapabilities` (object marker; `schema/v2/schema.unstable.json:3635,3707`). | **Omit** (unsupported means omitted, `migration.mdx:181`). Do not move it to `_meta`, because a typed field exists. |
| `mcpCapabilities.sse: false` (`:401`) | No. SSE was removed from v2 (`migration.mdx:741`; `schema/v2/schema.json:3303` has `stdio`/`http` only). | Drop. |
| Top-level response `_meta`: `steering`, `goal`, `jetbrains.air` (`:410-431`) | `InitializeResponse._meta` exists in v2 (`schema/v2/schema.json` `InitializeResponse`) and the SDK preserves it (empirical). | **Carry over unchanged** (judgment). This keeps codex-acp's documented contracts intact (`docs/goal-extension.md:7-19`, `docs/async-tasks.md:7`, `docs/agent-file-change-report.md:5`, `docs/recommended-config-values-extension.md:27`). Spec note: `extensibility.mdx:126` (SHOULD) points at `capabilities._meta`, not top-level `_meta`. The v1 code already deviates in the same way. If you want strict SHOULD-conformance on the fresh v2 surface, move these to `capabilities._meta`, but that changes the key path clients read. |

Adjacent note on MCP, owned by the MCP topic: v2 also has a `session.mcp.stdio` marker (`initialization.mdx:228-239`, `migration.mdx:741`). In v1, stdio was implicit.

### B. Client-side probes

| Probe (file:line) | Reads on v1 | v2 equivalent | Still meaningful on v2? |
|---|---|---|---|
| `resolveTerminalOutputMode` / `clientSupportsTerminalOutputDelta` (`src/TerminalOutputMode.ts:5-22`) | `clientCapabilities._meta.terminal_output(_delta)` (private) | Would survive as `capabilities._meta.terminal_output_delta` (empirical). | **Moot.** The v2 `terminal_update` / `terminal_output_chunk` are baseline, with no negotiation (`migration.mdx:191,734`; see `.agents/research/v2-tool-calls-messages-and-terminal-streaming.md` §5.2). Don't consult it on v2. |
| `clientSupportsBooleanConfigOptions` (`src/FastModeConfig.ts:21-23`) | `clientCapabilities.session.configOptions.boolean`. This is **stable v1** (`schema/v1/schema.json` `ClientSessionCapabilities.configOptions` → `BooleanConfigOptionCapabilities`). | None. v2 `ClientCapabilities` has no `session` field (`schema/v2/schema.json:5842`), and the SDK strips it. | **Moot.** Boolean is baseline (`session-config-options.mdx:96,149`). Always emit `type:"boolean"` on v2. |
| `clientSupportsPlanUpdates` (`src/PlanCapabilities.ts:3-7`) | `clientCapabilities.plan`. This is **unstable v1** `PlanCapabilities` (`schema/v1/schema.unstable.json`). | Removed (`plan-variants.mdx:58,82`). | **Moot.** `plan_update` is baseline on v2 (`plan-variants.mdx:61`). codex-acp's `type:"markdown"` variant is unstable v2 with no handshake (`plan-variants.mdx:61`). Clients preserve and display unknown plan types generically (`agent-plan.mdx:69`). Sending it unconditionally on v2 is a judgment call. |
| `clientSupportsCompaction` (`src/CodexSessionCompactions.ts:13-15`) | `clientCapabilities.session.compaction` (unstable v1) | None. | **Moot.** Capability-free on v2 (`session-compaction.mdx:183`). `compaction_update` exists in the v2 unstable `SessionUpdate`. |
| `clientSupportsNotices` (`src/SessionNotice.ts:3-6`) | `clientCapabilities.session.notices` (unstable v1) | None. | **Moot.** Capability-free on v2 (`session-notices.mdx:137,158`). `notice` exists in the v2 unstable `SessionUpdate`. |
| Auth gateway flag (`src/CodexAuthMethod.ts:79`) | `clientCapabilities.auth._meta.gateway === true` | `capabilities.auth._meta.gateway`. v2 `AuthCapabilities` keeps `_meta` (`schema/v2/schema.json:5878`), and the SDK preserves it (empirical). | Yes. Same relative path. Judgment: no spec defines `gateway`. |
| Elicitation `form`/`url` (`src/ElicitationCapabilities.ts:4-14`; used at `CodexAuthMethod.ts:76`, `CodexAcpServer.ts:1011,2516`, `CodexElicitationHandler.ts:251,341-343`) | `clientCapabilities.elicitation.form/url != null` | `capabilities.elicitation.form/url` (stable; `initialization.mdx:131-138`). The `!= null` check matches spec semantics exactly (`elicitation.mdx:40-55`). | Yes. **Spec-mandated** (R14). Only the type import changes. |
| Subagents canonical (`src/subagents/AcpSubagents.ts:39-50`) | `clientCapabilities.subagents` (draft RFD field; not in any schema on `main`) | None. **The SDK strips `capabilities.subagents`** (empirical), so this branch cannot be read on v2. Side note: the installed v1 1.4.0 SDK also strips it on v1 (`node /tmp/probe1.mjs`), so today only the AIR fallback works on v1 either. | See below. |
| Subagents AIR fallback / all AIR caps (`src/AirExtension.ts:47-61`; callers `CodexAcpServer.ts:240-246,788,1768,1988,2028,2904`) | `clientCapabilities._meta.jetbrains.air.{version,capabilities[]}` | `capabilities._meta.jetbrains.air.*`, preserved by the SDK (empirical). | Yes. Same relative path. Judgment. Subagent gating on v2 should use the AIR key only, because (a) the canonical field is stripped, and (b) codex-acp emits the pre-rework `subagent_spawned` / `subagent_state_update` discriminators rather than the RFD's v2 `subagent_update`. The RFD's "assume support on v2" proposal therefore does not fit codex-acp's current wire shape (see Open questions). |
| Steering / goal probes | none. There are no client-side probes (`rg` over `src/`). These features are agent-advertised only. | n/a | n/a |
| `clientInfo` (`CodexAcpServer.ts:363,1812` `isJetBrains2026_1Client`) | `clientInfo` | `info` (required in v2) | Yes. Rename only (topic 1 owns this). |

**Convention for an unspecified client-side extension probe (judgment call, grounded in spec + SDK):** keep the **same key at the same relative position under the renamed container**:
- `clientCapabilities._meta.X` → `capabilities._meta.X`
- `clientCapabilities.auth._meta.X` → `capabilities.auth._meta.X`

Rationale:
1. The spec places extension capabilities in capability-object `_meta` (`extensibility.mdx:126`; `initialization.mdx:115-117`).
2. v2 renamed only the container.
3. The v2 SDK preserves `_meta` at every level but strips every other non-schema key. So a probe that today reads a *non-`_meta`* ad-hoc field (like `capabilities.subagents`) has no v2 home. It must either move under `_meta` or be dropped.

Do not invent new top-level fields: that violates R4 and the SDK strips them anyway.

### C. Method registrability on the v2 chain

API (SDK `src/v2/acp.ts`, origin/main):
- `AgentApp.onRequest` has three overloads (`:3053-3068`):
  1. `onRequest(method: AgentRequestMethod, handler)` for built-ins, with parser and response types inferred.
  2. `onRequest<P,R>(method: ExtensionMethod /* `_${string}` */, params: ParamsParser<P>, handler)`.
  3. `onRequest<P,R,const M>(method: UnrecognizedMethod<M>, params, handler)` for non-`_` names that are *not* current v2 built-ins. The doc comment says it "permits methods from older or newer unstable ACP revisions… Prefer ExtensionMethod for new custom methods" (`:161-180`).
- `AgentApp.onNotification` has the same three overloads (`:3103-3118`).
- Runtime rules:
  - Passing a parser for a built-in name throws `Cannot replace the built-in ACP v2 request parser for '…'` (`assertUnrecognizedV2Method`, `:365-374`, over `knownProtocolMethods` = the unstable `AGENT_METHODS`/`CLIENT_METHODS`/`PROTOCOL_METHODS`, `:339-343`).
  - Omitting the parser for a non-built-in throws `Unknown ACP request method` (`:3082-3085`).
  - `ParamsParser` accepts a zod schema or a function (`:2025-2032`), so codex-acp's existing zod parsers in `src/index.ts:21-51` work unchanged.
- An agent must register an `initialize` handler before `connect` (`:3228-3234`). Every non-initialize inbound message is blocked until initialized (`agentInitializationGuard`, `:582-640`).
- Tests: `src/v2/acp.test.ts:1442-1549` exercises exactly these names: `"session/load"` request, `"session/set_model"` notification, `"authentication/logout"` / `"authentication/status"` on the client side, `_vendor/acme/*`, and the "Cannot replace the built-in" error. Type-level coverage is at `:68-88`.
- Outbound custom methods from the agent side:
  - `ctx.client.notify<P>("_auth/status_update", params)` and `ctx.client.request<R,P>("_x", params)` use `ExtensionMethod` / `UnrecognizedMethod` overloads (`AgentContext.request` `:1016-1051`, `AgentContext.notify` `:1061-1088`).
  - The same calls work from `onConnect` via `connection.client` (test `:1478-1488`).
  - Both wait for initialization to finish before sending (`:1044,1085`). This matters for `publishFirstAuthStatusAfterResponse` (`CodexAcpServer.ts:370`): on v2 the SDK itself guarantees the push goes after the initialize response.

| v1 registration (`src/index.ts`) | In v2 method table? | v2 registration | Recommendation |
|---|---|---|---|
| `session.fork` (`:152`) | Yes, unstable (`methods.agent.session.fork`, `:754`) | `.onRequest(acpV2.methods.agent.session.fork, (ctx) => …)` (typed; no parser) | Register, gated by `capabilities.session.fork: {}`. The response must be v2-shaped (no `modes`; `schema/v2/schema.unstable.json` `ForkSessionResponse` = `sessionId, configOptions, _meta`), because the SDK does not strip it. |
| `providers.list/set/disable` (`:161-163`) | Yes, unstable (`methods.agent.providers.*`, `:743-747`) | `.onRequest(acpV2.methods.agent.providers.list, …)` etc. (typed) | Register, gated by `capabilities.providers: {}`. |
| `session.load` (`:151`) | No (removed) | Technically `.onRequest("session/load", parser, …)` via `UnrecognizedMethod` | **Do not register.** Removed in v2 (R12). Replaced by `session/resume` + `replayFrom`. |
| `session.setMode` (`:157`) | No (removed) | Technically `.onRequest("session/set_mode", parser, …)` | **Do not register.** Removed in v2 (R12). Use config options. |
| `LEGACY_SET_SESSION_MODEL_METHOD` = `"session/set_model"` (`:168`; `src/AcpExtensions.ts:42`) | No (withdrawn unstable method) | `.onRequest(LEGACY_SET_SESSION_MODEL_METHOD, legacySetSessionModelParamsParser, …)` type-checks via `UnrecognizedMethod` | **Do not register** (judgment, spec-backed: R1, R13). A v2 client has no reason to call it. |
| `"authentication/status"`, `"authentication/logout"` (`:166-167`) | No | `.onRequest("authentication/status", emptyExtensionParamsParser, …)` type-checks via `UnrecognizedMethod` | **Do not register** (judgment, spec-backed: R1 non-`_` names; R7 `auth/logout` is required baseline). Both are already deprecated (`src/AcpExtensions.ts:93-103`). |
| `authenticate` / `logout` (`:159-160`) | Renamed: `methods.agent.auth.login` / `.logout` (`:741-744`) | typed | Register (owned by the auth-rename topic). |
| `_session/steering`, `_session/goal`, `_session/async_task/stop` (`:169-171`) | No (custom) | `.onRequest(SESSION_STEERING_METHOD, sessionSteerParamsParser, …)` (`ExtensionMethod` overload), same for the others | Register unchanged. |
| outbound `_auth/status_update` (`CodexAcpServer.ts:1339`) | No (custom) | `connection.notify("_auth/status_update", {authStatus})` on the v2 `AgentContext` | Keep. |
| `session.cancel` notification (`:165`) | Yes | `.onNotification(acpV2.methods.agent.session.cancel, …)` | Register (baseline). |

Side observation: `LEGACY_GOAL_CONTROL_METHOD = "_codex/session/goal_control"` is accepted by `isExtMethodRequest` (`src/AcpExtensions.ts:88`) but is **not registered** in `src/index.ts`. It is unreachable on v1 today, and it needs no v2 registration either.

## Testability notes

- **Outgoing capability shape.** Snapshot the v2 initialize response *as received by a v2 `acpV2.client()` over an in-memory pair*: `agentApp.connect(clientApp)` / `clientApp.connectWith(agentApp, …)` (SDK `src/v2/acp.ts:2997-3006,3198-3221`). This captures the post-zod wire object.
  - Conforming: `capabilities.session.fork`, `capabilities.providers`, `capabilities.auth._meta.authStatus` (or `capabilities._meta.authStatus`), top-level `_meta.goal/steering/jetbrains` present; no `auth.logout`, `session.list/resume/close/subagents`, `mcp.sse`.
  - Caveat: snapshotting the *handler's return value* instead would hide the stripping. Assert on what the client receives.
- **Stripping regression guard.** A test that returns `session.subagents: {}` from the handler and asserts the client does not receive it documents the SDK behavior. Optional, since it tests the SDK.
- **Probes.** Send a v2 `initialize` with `capabilities._meta.jetbrains.air.capabilities: ["nativeSubagentSessions"]` and assert `subagent_*` updates appear. Send one without it and assert the tool-call fallback. Do the same for `auth._meta.gateway` → `authMethods` contains `gateway`, and `elicitation.url` → `chat-gpt-device-code`.
- **Moot probes.** Assert that a v2 client *without* any `_meta` gets boolean fast-mode and `plan_update`/`terminal_output_chunk`. Those are the observable consequences.
- **Method registrability.** Assert that a v2 `session/load`, `session/set_mode`, `session/set_model` or `authentication/status` request yields JSON-RPC `-32601` Method not found. Assert that `_session/steering` succeeds.
  - Registration errors are construction-time throws (`Cannot replace the built-in…`, `Unknown ACP request method…`), so a mis-registration fails the test at setup.
- **Ordering.** Ordering of `_auth/status_update` after the initialize response is guaranteed by the SDK (`:1085`), so it is observable as message order on the client.
- **Not observable over the wire:** whether codex-acp "consults" a moot probe. Test only outputs.

## Discrepancies

1. **v1 vs v2 SDK response handling.** The v1 SDK passes the agent's `initialize` response through verbatim (no response serializer, `dist/acp.js:594`). The v2 SDK zod-parses it and strips non-schema keys (`src/v2/acp.ts:418-431,2258-2264`). The same codex-acp return value therefore produces different wires on v1 and v2. This is the root cause of items A2/A4/A7 needing explicit decisions.
2. **The subagents RFD proposal disagrees with codex-acp's own docs.** The RFD says there is no agent-side capability (`subagents.mdx:71`) and no v2 capability (`:383-385`). codex-acp's own `docs/subagent-sessions.md:7-10` describes a bilateral negotiation with `agentCapabilities.sessionCapabilities.subagents: {}`. The RFD is unmerged, on branch `vbr/subagents-rfd`.
3. **Prior research mislabels two probes as "non-standard".** `.agents/research/v2-config-options-modes-and-plans.md:187-188,246-247` calls `clientCapabilities.session.configOptions.boolean` and `clientCapabilities.plan` non-standard/extension probes. The first is **stable v1** and the second is **unstable v1** (`schema/v1/schema.json` / `schema.unstable.json` `ClientSessionCapabilities`, `PlanCapabilities`). Their v2 conclusion (moot) still holds.
4. **Prior research calls `session/fork` "codex-acp's own v1 extension".** `.agents/research/v2-session-lifecycle-new-resume-list-close-delete.md:193-194` says this. It is actually an unstable ACP method in both v1 and v2 (`schema/v1/meta.unstable.json:18`, `schema/v2/meta.unstable.json`).
5. **Minor spec inconsistencies (not blocking):**
   - `migration.mdx:191` says "Stable v2 currently defines no standard Client capability fields", but stable `ClientCapabilities` has `auth` and `elicitation` (`schema/v2/schema.json:5842`).
   - The `AgentCapabilities.session` description in both v2 schemas lists only 4 baseline methods, while `SessionCapabilities` and `initialization.mdx:150-156` list 7.
6. **The SDK is more permissive than the spec about non-`_` custom methods.** The SDK's `UnrecognizedMethod` overload deliberately allows them. The spec only permits `_`-prefixed custom methods (R1).

## Open questions

- **Subagent wire on v2:** codex-acp emits `sessionUpdate: "subagent_spawned"` / `"subagent_state_update"`. These are non-`_` values that are not defined in the v2 schema on `main`, so on v2 they conflict with R5 (`extensibility.mdx:117`). The RFD branch reworks them into `subagent_update`. Route to whoever owns subagents-on-v2.
- **SDK version drift:** the installed SDK is `1.4.0` while the lock is `1.5.0`. The installed v1 SDK strips `clientCapabilities.subagents` and `session.notices` on v1 too (`/tmp/probe1.mjs`), so the canonical v1 subagents probe may already be dead code. This belongs to the parallel `v2-sdk-version-sanity-check.md`.
- **`session.mcp.stdio` marker on v2:** owned by the MCP topic.
- **SDK checkout state:** the local SDK checkout could not fast-forward because of a pre-existing dirty `package-lock.json`. The user may want to stash or clean it. I did not touch it.

## Decision table

| Item | v2 placement | Tier / justification | Spec-mandated or judgment call |
|---|---|---|---|
| `sessionCapabilities.fork` | `capabilities.session.fork: {}` | capability:`session.fork` (UNSTABLE), `schema.unstable.json:3479,3743` | spec-mandated (unstable schema) |
| `sessionCapabilities.subagents` | **Drop**. AIR `nativeSubagentSessions` in top-level `_meta.jetbrains.air.capabilities` remains. Optional fallback: `capabilities.session._meta.subagents` | No v2 field; SDK strips it; RFD proposal says no agent capability | judgment call |
| `sessionCapabilities.list/resume/close` | Drop | Implied by `capabilities.session` (`migration.mdx:190`) | spec-mandated |
| `sessionCapabilities.delete/additionalDirectories` | `capabilities.session.delete/additionalDirectories: {}` | stable | spec-mandated |
| `agentCapabilities.providers` | `capabilities.providers: {}` | capability:`providers` (UNSTABLE), RFD MUST advertise | spec-mandated (unstable schema) |
| `agentCapabilities.auth.logout` | Drop | "no logout support marker" (`migration.mdx:198,730`); SDK strips it | spec-mandated |
| `agentCapabilities._meta.authStatus` | `capabilities.auth._meta.authStatus: {}` (alt: `capabilities._meta.authStatus`) | `capabilities.auth` = home of auth extensions (`migration.mdx:198`); symmetric with `auth._meta.gateway` | judgment call |
| `mcpCapabilities.http: true` | `capabilities.session.mcp.http: {}` | object markers (`migration.mdx:181-183`) | spec-mandated |
| `mcpCapabilities.acp: false` | Omit | UNSTABLE `mcp.acp` object marker; unsupported = omitted | spec-mandated |
| `mcpCapabilities.sse: false` | Drop | SSE removed in v2 (`migration.mdx:741`) | spec-mandated |
| Top-level `_meta` steering/goal/`jetbrains.air` | Unchanged in `InitializeResponse._meta` | Schema allows it and the SDK preserves it; keeps documented contracts. `extensibility.mdx:126` SHOULD would prefer `capabilities._meta` | judgment call |
| Terminal output mode probe | Don't consult on v2 | baseline terminal surface (`migration.mdx:734`) | spec-mandated (moot) |
| Boolean config option probe | Don't consult; always boolean | baseline (`session-config-options.mdx:96`) | spec-mandated (moot) |
| Plan update probe | Don't consult; always `plan_update` | `plan-variants.mdx:58-61` (RFD); `ClientCapabilities.plan` removed | spec-mandated for `items`; judgment call for sending unstable `markdown` |
| Compaction / notices probes | Don't consult; capability-free | RFDs: "V2 does not add or require a capability" | spec-mandated (RFD Preview/Draft) |
| Gateway auth probe | `capabilities.auth._meta.gateway === true` | same relative `_meta` path; SDK preserves it | judgment call |
| Elicitation form/url probe | `capabilities.elicitation.form/url != null` | stable; agents MUST NOT request unadvertised modes | spec-mandated |
| AIR capability probes (sessionFailure, agentFileChangeReport, asyncTasks, recommendedValue, nativeSubagentSessions) | `capabilities._meta.jetbrains.air.*` | same relative `_meta` path; SDK preserves it | judgment call |
| Subagent client probe | AIR key only; the canonical `capabilities.subagents` cannot be read (SDK strips it) | no v2 field; RFD "assume on v2" does not fit codex-acp's pre-rework wire | judgment call |
| General convention for unspecified client probes | Same key, same relative path, under the renamed container's `_meta` | `extensibility.mdx:126`, `initialization.mdx:115-117`; SDK keeps only `_meta` | judgment call (spec-guided) |
| `session/fork` method | `onRequest(acpV2.methods.agent.session.fork, handler)` | typed built-in; parser would throw | spec-mandated (unstable) + SDK-enforced |
| `providers/*` methods | `onRequest(acpV2.methods.agent.providers.{list,set,disable}, handler)` | typed built-ins | spec-mandated (unstable) + SDK-enforced |
| `session/load`, `session/set_mode` | Not registered on v2 (SDK would allow `onRequest(name, parser, h)`) | Removed in v2 (`migration.mdx:42,49,738-739`) | spec-mandated |
| `session/set_model` | Not registered on v2 (SDK would allow it) | Withdrawn unstable API (#1324/#1325); non-`_` name (R1) | judgment call (spec-backed) |
| `authentication/status`, `authentication/logout` | Not registered on v2 (SDK would allow it) | Non-`_` names (R1); deprecated; `auth/logout` is baseline | judgment call (spec-backed) |
| `_session/steering`, `_session/goal`, `_session/async_task/stop` | `onRequest("_…", zodParser, handler)` | `ExtensionMethod` overload; conforming `_` names | spec-mandated (MAY, conforming) |
| `_auth/status_update` (outbound) | `ctx.client.notify("_auth/status_update", params)` / `connection.client.notify(...)` | `ExtensionMethod` overload; the SDK sends it only after initialize | spec-mandated (MAY, conforming) |

# At `@agentclientprotocol/sdk` ≥ 1.5.0, do the v2 types match spec + SDK `origin/main`, and does the router / `acpV2.agent` API match our architecture?

**Sources checked:**
- npm registry: `@agentclientprotocol/sdk` latest = **1.5.0** (published 2026-09-21T08:27Z; no newer version). Tarball unpacked to `/tmp/acpv2check/pkg/package` (outside the repo).
- `agentclientprotocol/typescript-sdk` **`origin/main` @ `69fda37`** (2026-09-23, "fix: bound incoming transport message sizes (#259)"). The 1.5.0 release commit is `f1ba3a9`; 1.4.0 is `e6463f4`. **Note:** `git pull --ff-only` in the local checkout (`../acp-typescript-sdk`) *aborted* because of an uncommitted `package-lock.json` change there. The fetch still went through, so I read `origin/main` through `git archive origin/main` into `/tmp/acpv2check/main`. The local working tree was left untouched and is **not** current (it is 29 commits behind).
- `agentclientprotocol/agent-client-protocol` **`main` @ `c245270`** (2026-09-23). v2 schema crate version `2.0.0-alpha.5` (`schema/v2/Cargo.toml:3`, `schema/v2/CHANGELOG.md:10`).

**Confidence:** high. The type check is mechanical: file hashes plus a `tsc` declaration diff. The runtime API was read from source and cross-checked against the published `.d.ts`.

## Mismatches (lead list)

**Type shapes: none.** The 1.5.0 v2 generated types are identical to SDK `origin/main` and to the spec's current v2 schema. `PromptResponse.messageId` is present and required.

Things that do matter for implementation:

1. **Breaking runtime-API change 1.4.0 → 1.5.0 (not a schema mismatch).** The v2 `session/prompt` handler must now return `PromptResponse` with a required `messageId`. In 1.4.0 it could return `void`, and the SDK filled in `{}` (`emptyObjectResponse`). 1.5.0 removed that default. Outgoing responses are **not** validated at runtime, so a handler that returns `undefined` through an `any`/cast would send an invalid response on the wire. The TS type is the only guard.
2. **Architecture §3 cites stale example line numbers.** `dual-version-agent.ts:139-141,171-179,251-264` are 1.4.0-era. At 1.5.0/main the lines are: cancel handler **150-152**, `cancelV2Turn` **182-190**, idle/cancelled catch **255-268**. The example's semantics also changed. The user message is now built and given its `messageId` *inside* the prompt handler, which returns `{messageId}` (`:121-148`). The `user_message` update itself is still sent later, from the turn task (`:227-230`).
3. **SessionUpdate union gained a `notice` variant between 1.4.0 and 1.5.0.** It is unstable-only. This does not affect emitters. It does affect any exhaustive `switch` over `v2.SessionUpdate`: per AGENTS.md, add an explicit no-op `case`. In the same range, `ToolCallUpdate.name` lost its `@experimental` marker; that change is doc-only.
4. **The SDK's v2 types come from `schema.unstable.json`, a superset of the spec's stable-draft v2 `schema.json`.** Extras visible to codex-acp's types:
   - `McpServer` `{type:"acp"}` and `McpCapabilities.acp`
   - SessionUpdate `plan_removed` / `notice` / `compaction_update` / `compaction_summary_chunk`
   - `SessionCapabilities.fork`
   - `nes` / `positionEncoding(s)` / `providers` on the capability objects

   Every other in-scope type is structurally identical between the two files. Descriptions differ only in doc URLs (`/protocol/v2/…` vs `/protocol/v2/draft/…`). Earlier topic files cite line numbers in `schema/v2/schema.json` (the stable file); that is fine for the shapes they cite.
5. **Unreleased on `origin/main` after 1.5.0 (#259).** `ndJsonStream(output, input, options?: {maxMessageBytes})` gains a **default 32 MiB inbound message cap** and a `MessageTooLargeError` export. 1.5.0 has no cap. This lands with the next release. It is adjacent to this question (see Open questions).

## Answer

The latest published version is **1.5.0**. Its `dist/v2/schema/types.gen.d.ts` is byte-identical to declarations emitted from SDK `origin/main`'s `src/v2/schema/types.gen.ts`: the diff has 0 lines. Its bundled `schema/v2/schema.unstable.json` is byte-identical to both SDK `origin/main` and the spec repo's `schema/v2/schema.unstable.json` (sha1 `fba16d2c…` for all three). `PromptResponse` is `{ messageId: MessageId; _meta? }`, and `messageId` is required.

Between 1.4.0 and 1.5.0, the only in-scope *shape* changes are `PromptResponse.messageId` and the new `notice` SessionUpdate variant. That confirms `messageId` was essentially an isolated omission.

The runtime API matches what the architecture assumes:
- `acpV2.agentProtocolRouter().withV1(a).withV2(b).connect(stream)`
- `acpV2.agent({name}).onRequest(acpV2.methods.agent.…, (ctx) => …)` and `.onNotification(...)`
- `ctx = {params, signal, client, requestId}`
- `ctx.client.notify(acpV2.methods.client.session.update, …)` and `ctx.client.request(acpV2.methods.client.session.requestPermission, …, {cancellationSignal})`

The one behavioral change the programmer must absorb is that the v2 prompt handler now has to return `{messageId}`.

## Requirements

| # | Requirement | Tier | Citation |
|---|-------------|------|----------|
| 1 | `PromptResponse.messageId` is required and non-null | MUST (schema) | spec `schema/v2/schema.unstable.json:5082-5101`; SDK `src/v2/schema/types.gen.ts:3234-3244` |
| 2 | v2 `session/prompt` handler returns `PromptResponse` (no `void`) | MUST (SDK 1.5.0 type contract) | SDK `src/v2/acp.ts:2316` (no `emptyObjectResponse`), `:2545-2548` |
| 3 | The user-message session update carries the same `messageId` as the response and may arrive before or after it | MUST (schema doc) | SDK `src/v2/schema/types.gen.ts:3235-3243` (doc text generated from the schema) |
| 4 | v2 `AgentApp` needs an `initialize` handler registered before `connect` (otherwise it throws) | MUST (SDK runtime) | SDK `src/v2/acp.ts:2981,3089,3226-3232` |
| 5 | v2 `AgentApp` rejects `protocolVersion !== 2` in initialize | SDK runtime | SDK `src/v2/acp.ts:391-400` |
| 6 | The router selects v2 iff v2 is configured and requested ≥ 2; it normalizes and zod-parses initialize params before handing off | SDK runtime | SDK `src/protocol-router.ts:236-246,275-283,558-569` |
| 7 | New SDK SessionUpdate variants (`notice`, etc.) are unstable-only | informational | spec `schema/v2/schema.json` vs `schema.unstable.json` `$defs.SessionUpdate` (structural diff) |

## Details

### Step 1: version and `messageId`

- `npm view @agentclientprotocol/sdk versions` ends at `1.5.0`. dist-tag times: 1.4.0 = 2026-08-20, 1.5.0 = 2026-09-21.
- Published `dist/v2/schema/types.gen.d.ts`:
  ```ts
  export type PromptResponse = { messageId: MessageId; _meta?: { [key: string]: unknown } | null };
  ```
- Published `dist/v2/acp.d.ts:688`: `[schema.AGENT_METHODS.session_prompt]: AgentRequestHandler<schema.PromptRequest, schema.PromptResponse>;`
- SDK CHANGELOG: `feat: update schemas to v1.23.0 and v2.0.0-alpha.5 (#255)` shipped in 1.5.0 (`CHANGELOG.md:9`). Spec `schema/v2/CHANGELOG.md:10-14`: alpha.5, "return message ID on prompt insertion (#2175)".
- The repo's `package.json:68` already reads `"^1.5.0"`, but `node_modules/@agentclientprotocol/sdk` is still `1.4.0`. That is the programmer's in-flight bump; I did not touch either.

### Step 2: per-type table

Method: (a) sha1 of `schema.unstable.json` in the package, SDK main, and spec main: **all identical**. (b) `tsc --declaration` of SDK-main `src/v2/schema/types.gen.ts`, diffed against the package's `.d.ts`: **0 lines**. (c) Per-`$defs` structural diff between the spec's stable `schema.json` and `schema.unstable.json`, with `description` stripped.

"1.5.0 = main = spec" holds for **every** row, because of (a) and (b). The last two columns record what is worth knowing.

| Type | Key shape at 1.5.0 (required fields in **bold**) | Stable vs unstable schema | Changed 1.4.0→1.5.0? |
|---|---|---|---|
| InitializeRequest | **protocolVersion**, **info**, capabilities?, _meta? | same | no |
| InitializeResponse | **protocolVersion**, **info**, capabilities?, authMethods?, _meta? | same | no |
| ClientCapabilities | auth?, elicitation?, _meta? (+ nes?, positionEncodings? unstable) | unstable adds nes/positionEncodings | no |
| AgentCapabilities | auth? (`AgentAuthCapabilities` = `{_meta?}`), session?, _meta? (+ nes?, positionEncoding?, providers? unstable) | unstable adds 3 | no |
| SessionCapabilities | prompt?, mcp?, delete?, additionalDirectories?, _meta? (+ fork? unstable) | unstable adds fork | no |
| AuthCapabilities (client) | terminal?, _meta? | same | no |
| McpCapabilities | stdio?, http?, _meta? (+ acp? unstable) | unstable adds acp | no |
| AuthMethod | open union `terminal` \| `agent` \| other `{type, methodId, name, …}`; AuthMethodAgent: **methodId**, **name** | same | no |
| LoginAuthRequest / Response | **methodId**, _meta? / `{_meta?}` | same | no |
| LogoutAuthRequest / Response | `{_meta?}` / `{_meta?}` | same | no |
| NewSessionRequest / Response | **cwd**, additionalDirectories?, mcpServers?, _meta? / **sessionId**, configOptions?, _meta? | same | no |
| ResumeSessionRequest / Response | **sessionId**, **cwd**, additionalDirectories?, mcpServers?, replayFrom?, _meta? / configOptions?, _meta? | same | doc text only ("retained history") |
| ReplayFrom / ReplayFromStart | open union `{type:"start"}` \| other `{type, …}` / `{_meta?}` | same | doc text only |
| ListSessionsRequest / Response / SessionInfo | cursor?, cwd? / **sessions**, nextCursor? / **sessionId**, **cwd**, title?, updatedAt?, additionalDirectories? | same | no |
| CloseSessionRequest / Response | **sessionId** / `{_meta?}` | same | no |
| DeleteSessionRequest / Response | **sessionId** / `{_meta?}` | same | no |
| PromptRequest | **sessionId**, **prompt**, _meta? | same | no |
| **PromptResponse** | **messageId**, _meta? | same | **yes: `messageId` added** |
| UpdateSessionNotification (session/update params; *not* named `SessionNotification` in v2) | sessionId, update | n/a | no |
| SessionUpdate union | user_message_chunk, user_message, agent_message_chunk, agent_message, agent_thought_chunk, agent_thought, state_update, tool_call_content_chunk, tool_call_update, terminal_update, terminal_output_chunk, plan_update, available_commands_update, config_option_update, session_info_update, usage_update, other (+ unstable: plan_removed, notice, compaction_update, compaction_summary_chunk) | unstable adds 4 | **yes: `notice` added (unstable)** |
| StateUpdate | open union on `state`: running \| idle `{stopReason?, usage?}` \| requires_action \| other | same | no |
| ToolCallUpdate | **toolCallId**, title?, kind?, status?, content?, locations?, rawInput?, rawOutput?, name?, _meta? | same | `name` de-experimentalized (doc only) |
| TerminalUpdate | **terminalId**, command?, cwd?, output?, exitStatus? | same | no |
| TerminalOutputChunk | **terminalId**, **data** | same | no |
| PlanUpdate / PlanItems | **plan** (open union items \| file \| markdown \| other) / **planId**, **entries** | same | no |
| ConfigOptionUpdate | **configOptions** | same | no |
| ContentChunk (message chunks; there is no `MessageChunk` def) | **messageId**, **content** | same | no |
| RequestPermissionRequest | **sessionId**, **title**, **options**, subject?, description? | same | no |
| RequestPermissionSubject | open union `tool_call` `{toolCall}` \| `command` `{command, cwd, toolCallId?, terminalId?}` \| other | same | no |
| RequestPermissionOutcome / Response | open union `cancelled` \| `selected` `{optionId}` \| other / **outcome** | same | no |
| SetSessionConfigOptionRequest / Response | **sessionId**, **configId**, + union `{type:"id", value}` \| `{type:"boolean", value}` \| other / **configOptions** | same | no |
| SessionConfigOption | **configId**, **name**, description?, category?, + union select \| boolean \| other | same | no |
| McpServer | open union http \| stdio \| other (+ `acp` `{name, serverId}` unstable). Stdio: **name**, **command**, args?, env?. Http: **name**, **url**, headers? | unstable adds `acp` | no |
| CancelSessionNotification | **sessionId**, _meta? | same | no |
| Diff / DiffChange / DiffPatch | **changes**, patch? / open union on `operation` add\|delete\|modify\|move\|copy\|other, fileType?, mimeType? / **format**, **text** | same | no |

Citations for the TS side: SDK `src/v2/schema/types.gen.ts`: ToolCallUpdate `:143`, PromptResponse `:3234`, UpdateSessionNotification `:3654`, SessionUpdate `:3682`, ContentChunk `:3758`, Notice `:4626`, McpServer `:5324`, ReplayFrom `:5614`, RequestPermissionOutcome `:6226`. Spec side: `schema/v2/schema.unstable.json` UpdateSessionNotification `:5700`, SessionUpdate `:5731`, McpServer `:8207`; stable `schema/v2/schema.json` PromptResponse `:4097`, UpdateSessionNotification `:4269`, SessionUpdate `:4300`, McpServer `:6052`.

The earlier research files already handle the `acp` McpServer variant (`v2-mcp-config-…md:22,43,112`) and `notice` (`v2-tool-calls-…md:387`).

### Step 3: runtime API at 1.5.0 (identical on `origin/main` except the #259 stream-limit addition)

Import paths (package `exports`):
- `@agentclientprotocol/sdk` for v1
- `@agentclientprotocol/sdk/experimental/v2` for v2 and the router (`dist/v2/acp.d.ts:44` re-exports `AgentProtocolRouter` and `agentProtocolRouter` from `../protocol-router.js`)

The router is **not** exported from the v1 entry point.

**Router** (`src/protocol-router.ts`):
- `agentProtocolRouter()` (`:308`) → `AgentProtocolRouter` with `withV1(AgentConnector)`, `withV2(AgentConnector)` (both return `this`, `:55-70`) and `connect(stream, options?) → AgentConnectionLifecycle` (`:73-90`).
- `AgentConnector` is structural: `{ connect(stream, options?: {deferConnectHandlers?}) }` (`src/connection.ts:11-25`). Both v1 `acp.agent()` and v2 `acpV2.agent()` apps satisfy it.
- Behavior (`:92-266`):
  - Reads the first wire item. It must be `initialize`, either bare or as a single-entry batch; otherwise the router answers `-32600` and closes.
  - Picks the highest configured version ≤ the requested one (`:275-283`).
  - Zod-parses and normalizes the initialize params, rewriting `protocolVersion` to the selected version (`:558-576`). A malformed v2 initialize is therefore rejected by the router with `invalidParams` before our handler runs.
  - Calls `agent.connect(routedStream, {deferConnectHandlers: true})`, then starts **only the selected app's** `onConnect` handlers, exactly once (`:246-252`, `:333-364`; test `src/protocol-router.test.ts:405-430`).
  - Every later message is forwarded unchanged.

**v2 app** (`src/v2/acp.ts`):
- `agent(options?: {name?})` (`:2953`) → `AgentApp` (`:2967`).
- `onRequest(method, handler)` / `onNotification(method, handler)` for built-ins (`:3053-3140`). Extension methods use `onRequest(method, paramsParser, handler)`.
- Non-`_` custom names (e.g. codex-acp's `authentication/status`) are allowed as long as they don't collide with a v2 built-in name (`knownProtocolMethods` = v2 AGENT/CLIENT/PROTOCOL methods only, `:339-374`).
- `onConnect((conn: AgentConnection) => …)` (`:3041`). `AgentConnection` = `{client: AgentContext, signal, closed, initialized, close()}` (`:811-848`).
- Throws at `connect` if no initialize handler was registered (`:3226-3232`).
- `methods` table (`:739-800`):
  - `methods.agent.initialize`
  - `methods.agent.auth.{login,logout}`
  - `methods.agent.session.{new,list,delete,fork,resume,close,setConfigOption,prompt,cancel}`
  - `methods.agent.providers.*`
  - `methods.client.session.{requestPermission,update}`
  - `methods.client.elicitation.{create,complete}`
  - `methods.protocol.cancelRequest`

  There is **no** `methods.agent.session.load` / `setMode` / `authenticate` / `logout` at the top level in v2.

**Handler ctx** (`:2037-2068`):
- Request handlers get `{ params, signal, client: AgentContext, requestId: JsonRpcId }`.
- Notification handlers get `{ params, signal /* connection signal */, client }` with no `requestId`.
- The `requestId` property is also on `ctx.client.requestId` (`:953-958`).

**Response typing** (`:2523-2601`). These return types allow `void`, which is serialized as `{}`:
- `auth/login`
- `auth/logout`
- `session/delete`
- `session/close`
- `providers/set`
- `providers/disable`

`initialize`, `session/new`, `session/list`, `session/resume`, `session/set_config_option`, `session/fork`, and **`session/prompt`** require a full response object. Handler return values are not schema-validated before sending (`registerAppRequest`, `:2191-2229`).

**Sending to the client from a v2 chain** (`AgentContext`, `:1000-1130`):
- `ctx.client.notify(method, params)` and `ctx.client.request(method, params, {cancellationSignal?})`.
- Both wait until initialize has completed before sending (`:1044,1085`).
- Both throw a `TypeError` if you pass a v2 method in the wrong direction (`:345-363`).
- `request` zod-parses the client's response (e.g. `zRequestPermissionResponse`, `:2455-2463`).
- Aborting `cancellationSignal` sends `$/cancel_request` (`src/jsonrpc.ts:97-105`).

Code-shaped summary a programmer can follow (mirrors `src/examples/dual-version-agent.ts` at 1.5.0; the file ships compiled as `dist/examples/dual-version-agent.js`):

```ts
import * as acp from "@agentclientprotocol/sdk";
import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2";

const v1Agent = acp.agent({ name }).onConnect(/* existing */)/* …existing v1 chain… */;

const v2Agent = acpV2.agent({ name })
  .onConnect((conn) => { /* conn.client is an acpV2.AgentContext, conn.signal aborts on close */ })
  .onRequest(acpV2.methods.agent.initialize, (ctx) => getAgent().initializeV2(ctx.params))
  .onRequest(acpV2.methods.agent.auth.login, (ctx) => getAgent().authenticate(ctx.params, ctx.requestId))
  .onRequest(acpV2.methods.agent.auth.logout, (ctx) => getAgent().logout(ctx.params))
  .onRequest(acpV2.methods.agent.session.resume, (ctx) => /* branch on ctx.params.replayFrom?.type === "start" */ …)
  .onRequest(acpV2.methods.agent.session.prompt, (ctx) => {
    const messageId = crypto.randomUUID();      // mint synchronously
    /* start the turn in the background (the example defers with setTimeout(0) so the response is queued first) */
    return { messageId };                       // REQUIRED at 1.5.0
  })
  .onNotification(acpV2.methods.agent.session.cancel, (ctx) => getAgent().cancel(ctx.params));

acpV2.agentProtocolRouter().withV1(v1Agent).withV2(v2Agent).connect(acpJsonStream);

// session/update from anywhere holding the AgentContext:
await client.notify(acpV2.methods.client.session.update, {
  sessionId, update: { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" },
});
// permission request:
const res = await client.request(acpV2.methods.client.session.requestPermission,
  { sessionId, title, options, subject: { type: "tool_call", toolCall } },
  { cancellationSignal: activePrompt.signal });
if (res.outcome.outcome === "selected") { res.outcome.optionId; }
```

Reference usage: SDK `src/examples/dual-version-agent.ts:54-158`:
- chain `:54-152`
- router `:158`
- prompt returning `{messageId}` `:108-149`
- resume/replay `:79-102`
- cancel `:150-152, 182-190`
- `state_update` emission `:233-267`

**Fit with codex-acp today:** `src/index.ts:139-172` builds the v1 chain and creates `CodexAcpServer` inside `.onConnect((connection) => createAgent(connection.client))`. Under the router, only the selected chain's `onConnect` runs, so each chain's `onConnect` must create the agent with its own context type. The `v2.AgentContext` class is distinct from `acp.AgentContext`. `src/ACPSessionConnection.ts:7` (`Pick<acp.AgentContext, "notify" | "request">`) is v1-typed and needs a v2 counterpart or a union. This is consistent with architecture.md's "ACPSessionConnection needs to know which version" note.

## Testability notes

- **messageId:** drive a v2 `session/prompt` through an in-memory client (`acpV2.client().connect(agentApp)`, or the router over `memoryStreamPair`). Assert the response is `{messageId: <string>}` and that a later `user_message`/`user_message_chunk` update carries the same id. Non-conforming: `{}` or `null` result. TS compilation at 1.5.0 already catches a missing `messageId` in the handler return.
- **Routing:** send `initialize` with `protocolVersion: 2`, then with `1`. Snapshot that the v2 response has `info`/`capabilities` and the v1 response has `agentInfo`/`agentCapabilities`. A non-initialize first message should produce `-32600` and close.
- **`notice` / unstable variants:** unobservable from the agent side unless codex-acp emits them. Only compile-time exhaustiveness matters.
- **Stream cap (#259):** only testable once a release includes it. Send a line larger than 32 MiB and expect `MessageTooLargeError` and connection teardown.

## Discrepancies

- **Spec stable vs SDK typing surface:** the SDK types v2 from `schema.unstable.json`, while the spec also publishes a stable-draft `schema/v2/schema.json` without the `acp` MCP transport, `fork`, `notice`/`plan_removed`/`compaction_*`, `nes`, `providers`, or position encodings. This is not a conflict for codex-acp as an emitter, but the SDK's types accept inputs (e.g. `McpServer{type:"acp"}`) that a stable-v2 client would never send.
- **SDK `origin/main` vs 1.5.0:** runtime-only difference (#259 inbound message-size cap, `ndJsonStream` `options` param). There is no type difference.
- **architecture.md vs current example:** stale line citations and a changed example structure (Mismatch 2).
- Otherwise none found.

## Open questions

- **32 MiB inbound cap (unreleased, #259):** can codex-acp receive single ACP messages over 32 MiB, e.g. large base64 image or audio prompts or embedded resources? If so, should `ndJsonStream(..., {maxMessageBytes})` be raised once the next SDK release lands? This is a v1 concern too.
- **Pinning:** v2 is `@experimental` and the schema is `2.0.0-alpha.5`. The prompt-handler return type already broke between SDK minors 1.4 and 1.5. Should `package.json` pin `~1.5.0` (or exact) rather than `^1.5.0`? This is a release-policy question for the orchestrator.
- **Local SDK checkout hygiene:** `../acp-typescript-sdk` has an uncommitted `package-lock.json` change that blocks `git pull --ff-only`. The user should decide whether to stash or discard it; I did neither.

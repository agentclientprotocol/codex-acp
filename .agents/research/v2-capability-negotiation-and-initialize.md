# v2 topic: Capability negotiation & `initialize`

Spec checked at `agent-client-protocol` local checkout, commit `8c90bb7` ("docs: update
registry agents (#2217)"), working tree clean. SDK checked at `acp-typescript-sdk` local
checkout, fetched to `origin/main` `69fda37` (local working tree left un-merged — it had an
unrelated uncommitted `package-lock.json` diff and an untracked `v2_negotiation.md` I did not
touch; all reads below were done via `git show origin/main:<path>`, not the dirty working
tree). Installed npm package in codex-acp: `@agentclientprotocol/sdk@1.4.0`
(`node_modules/@agentclientprotocol/sdk/package.json`), whose `dist/v2/*` already matches this
`origin/main` shape (same `exports` map, same subpath).

## 0. Dual-version support (v1 preserved + v2 added) — scope addendum

codex-acp must keep speaking ACP v1 for existing clients while adding v2, not cut over. This
section answers the four questions the orchestrator raised.

### 0.1 How version selection actually happens on the wire

It is **not** a separate signal, method, notification, or transport-level choice (no separate
port/flag/CLI-invocation mechanism exists in the protocol). It is exactly one field inside the
very first message on the connection: the `initialize` request's `protocolVersion` integer.

- `docs/protocol/v2/migration.mdx:26`: "the Client sends the latest protocol version it supports
  in `initialize`, and the Agent responds with the same version if supported, or its own latest
  version otherwise."
- `docs/protocol/v2/migration.mdx:30`: "Nothing about v2 changes the underlying JSON-RPC framing,
  so a single connection always speaks exactly one negotiated version after `initialize`."
- `docs/protocol/v2/migration.mdx:770-772` (section "**Supporting v1 and v2 side by side**"):
  "Supporting both versions is the recommended path, not an edge case ... Version negotiation
  gives you one protocol version per connection, so the cleanest approach is to keep two thin
  protocol surfaces behind shared application logic and select one after `initialize`." This is
  the spec's own explicit guidance for exactly codex-acp's situation, and it confirms: one
  connection = one version for its whole lifetime, decided once, at the first message.
- `ACP-INIT-201`/`ACP-INIT-003`/`ACP-INIT-202` (TCK) independently confirm the wire contract:
  the agent must read the requested `protocolVersion` from `initialize` params and echo it back
  if supported, else return its own latest — there is no other place version information flows.

### 0.2 Does the installed SDK support serving both versions from one process/server?

**Yes, this ships as a first-class, ready-to-use mechanism** — not something codex-acp has to
build from scratch. Found in the SDK repo (same content in the installed `1.4.0` package under
`node_modules/@agentclientprotocol/sdk/dist/v2/acp.js` / `dist/v2/acp.d.ts`):

- `src/protocol-router.ts` defines `AgentProtocolRouter` (and a factory `agentProtocolRouter()`),
  re-exported from the v2 entry point at `src/v2/acp.ts:97-99`
  (`export { AgentProtocolRouter, agentProtocolRouter } from "../protocol-router.js";`) — so it is
  reachable via the same `@agentclientprotocol/sdk/experimental/v2` subpath import used for all
  other v2 types.
- Usage is `.withV1(v1AgentConnector).withV2(v2AgentConnector).connect(stream)` where each
  `AgentConnector` is a fully-built agent object from `v1.agent({...}).onRequest(...)...` (v1
  namespace) or `v2.agent({...}).onRequest(...)...` (v2 namespace) respectively — i.e. exactly two
  independent, version-native handler-registration chains, not one merged one.
- The SDK ships a **complete worked example** at `src/examples/dual-version-agent.ts` (269 lines)
  showing precisely this pattern for a toy agent: a `v1Agent` built with `v1.agent(...)` returning
  v1-shaped `initialize`/session responses, a `v2Agent` built with `v2.agent(...)` returning
  v2-shaped ones, and a single process wiring both into
  `v2.agentProtocolRouter().withV1(v1Agent).withV2(v2Agent).connect(stream)` at the bottom (last
  line of the file).
- **How the router decides, mechanically** (`protocol-router.ts:83-249`, class
  `AgentProtocolRouter.route`): it reads only the *first* wire item from the stream. That item
  must be a JSON-RPC `initialize` request (or a single-entry batch containing one — batched
  `initialize` is otherwise disallowed per `migration.mdx:722`, and the router enforces this).
  It extracts `params.protocolVersion` (`protocol-router.ts:183`), computes
  `highestCompatible(requested)` (`:255-263`: picks `2` if a v2 agent is configured and
  `requested >= 2`, else `1` if a v1 agent is configured and `requested >= 1`, else rejects with
  `invalidRequest`), then hands the **entire rest of the raw stream, untouched**, to the selected
  agent's own `connect()` (`:232-249`). Every later wire item is forwarded unchanged — the router
  only ever touches the first message.
- **Cross-version fallback translation exists but won't be exercised once both v1 and v2 are
  configured.** If only one side is configured and the client requests the other version, the
  router rewrites just the `initialize` params before forwarding (`rewriteInitializeParams`,
  `:558-569`): e.g. `v2InitializeToV1` (`:578-585`) downgrades a v2-shaped `capabilities`/`info`
  request into v1's `clientCapabilities`/`clientInfo` shape so a v1-only agent can still be
  reached by a v2-speaking client. There is no `v1→v2` counterpart (verified by grep — none
  exists), because that direction is never needed: if only v1 is configured, `highestCompatible`
  never selects v2 regardless of what the client requested. **Since codex-acp's plan is to
  configure both `.withV1` and `.withV2` with codex-acp's own native handlers, this rewrite path
  is dead code for codex-acp's case** — each client always gets routed to the handler chain that
  matches what it actually asked for, with zero shape translation.

### 0.3 Proposed concrete mechanism for codex-acp

Replace the current single `.connect(acpJsonStream)` call at the bottom of `startAcpServer()`
(`src/index.ts:139-172`) with the router pattern:

1. Keep the existing v1 registration chain in `src/index.ts` exactly as-is (imported from the bare
   `@agentclientprotocol/sdk` specifier) — this is `v1Agent`.
2. Add a **new**, separate registration chain built with `acpV2.agent({name: packageJson.name})`
   (imported from `@agentclientprotocol/sdk/experimental/v2`) that registers v2-shaped handlers —
   at minimum `acpV2.methods.agent.initialize` for this topic; the other 6 baseline methods
   (`session.new/list/resume/close/prompt/cancel` + `session.update` notifications) are the
   session-lifecycle/prompt-lifecycle topics' concern, but the same chain is where they'll attach.
   This is `v2Agent`.
3. Both chains delegate to the **same underlying `CodexAcpServer`/`CodexAcpClient` business-logic
   objects** (per `migration.mdx:772`'s "shared application logic" advice) — i.e. `CodexAcpServer`
   grows a second method, e.g. `initializeV2(params: v2.InitializeRequest): Promise<v2.InitializeResponse>`,
   alongside the existing `initialize(params: acp.InitializeRequest)`, both populating the same
   `this.clientInfo`/`this.clientCapabilities`-equivalent internal state (v2's version of that
   state needs its own fields, since the shapes differ) but sharing all the session/turn machinery
   below the handshake.
4. At the bottom of `startAcpServer()`, replace `.connect(acpJsonStream)` on the v1 chain with:
   `acpV2.agentProtocolRouter().withV1(v1Agent).withV2(v2Agent).connect(acpJsonStream)`.
5. Per-connection state: codex-acp's current `.onConnect` (`src/index.ts:140-148`) creates one
   `CodexAcpServer` per connection and closes over it in both chains' handlers; this pattern is
   unaffected by adding the router — each of `v1Agent`/`v2Agent` keeps its own `.onConnect`, and
   whichever one the router actually invokes (based on the negotiated version) is the only one
   that ever fires for a given connection, since the router hands off the *entire* connection to
   exactly one of them.

### 0.4 Cost assessment for this topic specifically

**Cheap — a thin serialization/dispatch-layer branch, not a divergent handshake code path.** The
version-detection and stream-splitting logic is entirely supplied by the SDK
(`AgentProtocolRouter`); codex-acp writes zero protocol-sniffing code. The real work concentrated
in *this* topic is: (a) swapping one `.connect()` call for the router call in `src/index.ts`, and
(b) writing one new `initializeV2` handler in `CodexAcpServer.ts` that returns the v2-shaped
response described in §1 below, reusing all the same auth-method/elicitation/goal/steering
capability-sourcing logic that `initialize` (v1) already has — it's a parallel construction
function, not a rewrite of existing v1 logic. The heavier, more divergent work is in the *other*
topics that must also stand up v2-native handlers behind `v2Agent` (prompt lifecycle, session
lifecycle, tool calls) — those are genuinely two separate code paths per method, but that's their
scope, not this one's.

### 0.5 Blockers

**No hard blocker found** to serving both versions from the same process/binary. Two soft notes:

- The whole v2 surface (including `AgentProtocolRouter`) is explicitly marked `@experimental` in
  the SDK and backed by `schema/v2/schema.unstable.json` — codex-acp would be depending on an
  unstable upstream API that may still change shape before ACP v2 stabilizes. This is a
  version-churn risk to track, not a design blocker.
  Not a functional blocker, but worth noting as a structural cost: today `CodexAcpServer` mixes
  transport-shape concerns (reading `_params.clientCapabilities`) with business logic in one
  class; introducing a genuinely separate v2 handshake method is straightforward, but the two
  method bodies (`initialize` v1 and `initializeV2`) will necessarily duplicate structure (both
  build an auth-methods list, both build a capabilities object, both stash client info) since the
  shapes are incompatible by design (booleans vs. objects, different nesting) — expect deliberate,
  reviewed duplication here rather than a shared builder, at least for the capability object
  itself.

## 1. The new v2 `initialize` shape

Source: `docs/protocol/v2/initialization.mdx:24-244`, `docs/protocol/v2/migration.mdx:78-191`.

### Request (Client → Agent)

```json
{
  "jsonrpc": "2.0",
  "id": 0,
  "method": "initialize",
  "params": {
    "protocolVersion": 2,
    "info": { "name": "my-client", "title": "My Client", "version": "1.0.0" },
    "capabilities": {
      "auth": { "terminal": {} },
      "elicitation": { "form": {}, "url": {} }
    }
  }
}
```

### Response (Agent → Client)

```json
{
  "jsonrpc": "2.0",
  "id": 0,
  "result": {
    "protocolVersion": 2,
    "info": { "name": "my-agent", "title": "My Agent", "version": "0.3.0" },
    "capabilities": {
      "session": {
        "prompt": { "image": {}, "audio": {}, "embeddedContext": {} },
        "mcp": { "stdio": {}, "http": {} },
        "delete": {},
        "additionalDirectories": {}
      },
      "auth": {}
    },
    "authMethods": []
  }
}
```

### Key rules (each cited to spec text)

- **`clientCapabilities`/`clientInfo` → `capabilities`/`info`, and `agentCapabilities`/`agentInfo`
  → `capabilities`/`info`.** Same two field names on both sides now. `info` is **required** on
  both sides (v1's `agentInfo`/`clientInfo` were optional). (`migration.mdx:80-82`,
  `initialization.mdx:246-263`)
- **Booleans are gone.** Every support marker in v1 that was `true`/`false` (e.g.
  `promptCapabilities.image: true`, `clientCapabilities.terminal: true`) becomes an object marker:
  presence of the key (even `{}`) = supported, absence or `null` = unsupported.
  `promptCapabilities.image === true` becomes `capabilities.session.prompt.image != null`.
  (`migration.mdx:179-183`; TCK `ACP-INIT-204` enforces this — see below)
- **Session capability reorg + baseline commitment.** All session-scoped groups move under
  `capabilities.session` (`agentCapabilities.promptCapabilities` → `capabilities.session.prompt`,
  `agentCapabilities.mcpCapabilities` → `capabilities.session.mcp`). `capabilities.session` itself
  is optional (an agent that doesn't do session-based prompting can omit it). **Advertising
  `capabilities.session` at all — even as `{}` — now commits the agent to implementing the full
  baseline of 7 methods: `session/new`, `session/list`, `session/resume`, `session/close`,
  `session/prompt`, `session/cancel`, `session/update`.** The individual v1 `list`/`resume`/`close`
  markers are gone — there's no way to advertise a subset. Only `session.delete`,
  `session.additionalDirectories`, `session.prompt.*`, and `session.mcp.*` remain separately
  gated. `loadSession` and `session/load` are removed entirely (superseded by `session/resume` with
  an optional `replayFrom`). (`initialization.mdx:149-167`, `migration.mdx:185-191`,
  `migration.mdx:604`)
- **`auth` capability is orthogonal to `authMethods`.** `capabilities.auth` (both client- and
  agent-side) only advertises auth-related *extensions*; it does not gate `auth/login`/
  `auth/logout` availability. Whether those methods exist is governed purely by whether
  `authMethods` is non-empty: a non-empty `authMethods` list **requires** the agent to implement
  both `auth/login` and `auth/logout` (no more separate `logout` capability marker as in v1's
  `agentCapabilities.auth.logout`). (`initialization.mdx:78,157-161`, `migration.mdx:198`)
- **Client `auth.terminal`.** New client-side marker `capabilities.auth.terminal: {}` (object,
  not v1's top-level boolean `clientCapabilities.auth.terminal`) — the client can reproduce the
  configured agent invocation in an interactive terminal. Only if the client advertises this may
  the agent's `authMethods` include a `type: "terminal"` entry. (`initialization.mdx:119-125`)
- **`fs`/`terminal` client execution capabilities are removed entirely.** v1's
  `clientCapabilities.fs` and `clientCapabilities.terminal` (file R/W and command execution via the
  client) have no v2 equivalent; agents should get an MCP server instead. Not part of this
  topic's scope in depth (belongs to the MCP-config topic) but affects what codex-acp no longer
  needs to read from `clientCapabilities`. (`migration.mdx:191,632-635`)
- **Protocol version negotiation is unchanged in mechanism**, only the number range differs:
  client sends its latest supported version; agent echoes it if supported, else replies with its
  own latest. `protocolVersion` is a plain integer, "only bumped for breaking changes."
  (`initialization.mdx:82-96`, `migration.mdx:26`)
- **`_meta` passthrough** is present on essentially every v2 object (`InitializeRequest`,
  `InitializeResponse`, `Implementation`, `AgentCapabilities`, `SessionCapabilities`, etc.) as an
  optional `{[key: string]: unknown} | null` — this is how custom/experimental capabilities (e.g.
  codex-acp's `steering`, `goal`, JetBrains AIR extension keys) continue to be advertised in v2,
  same pattern as v1's `_meta` on `agentCapabilities`.

## 2. TCK requirement texts (from `/Users/eugene/Documents/JetBrains/projects/acp-tck/src/tck/v2/requirements.py`)

- **`ACP-INIT-001`** (MANDATORY): `initialize` must succeed with a non-error JSON-RPC result,
  regardless of negotiated `protocolVersion` — this row does not SKIP on version mismatch (unlike
  the 20x/SCHEMA rows below), since a MUST-succeed handshake applies even when the agent honestly
  negotiates down. Cites `initialization.mdx:24,47`.
- **`ACP-INIT-201`** (MANDATORY): result's `protocolVersion` is an integer; negotiated value is
  either the requested `2`, or — if unsupported — the agent's own latest supported version (never
  a different value, never blindly echoed). Cites `initialization.mdx:92-96`.
- **`ACP-INIT-003`** (MANDATORY): an unsupported-version probe (`protocolVersion: 65535`) still
  succeeds and returns at least the agent's own latest supported version, not the literal
  unsupported value.
- **`ACP-INIT-202`** (MANDATORY): a downgrade probe (`protocolVersion: 1`) still succeeds (never a
  JSON-RPC error) and returns `1` or `2`.
- **`ACP-INIT-203`** (MANDATORY, v2-only, SKIPs on version mismatch): result's `info` must be
  present, an object, with non-empty string `name` and `version` (`title` optional/nullable) — REQUIRED
  in v2 unlike v1's optional `agentInfo`.
- **`ACP-INIT-204`** (MANDATORY, v2-only, SKIPs on version mismatch): when `capabilities` is
  present, every known capability marker (`session`, `auth`, and known nested keys) must be
  absent/`null` or an object — **never a boolean**. Dedicated diagnostic id even though the same
  defect also trips `ACP-SCHEMA-001`.
- **`ACP-SCHEMA-001`** (MANDATORY, v2-only, SKIPs on version mismatch): every message emitted
  during the `initialize` exchange must validate against the vendored v2 JSON schema.
- **`ACP-AUTH-202`** (MANDATORY): no `authMethods[*]` entry with `type: "terminal"` may be
  advertised unless the client advertised `capabilities.auth.terminal: {}` in `initialize`'s
  params. New id (not a reuse of v1's `ACP-AUTH-002`) because both the capability path and its
  encoding changed (v1 top-level boolean → v2 nested object marker).
- Also relevant context (not individually requested but load-bearing): `requirements.py:15-21`
  states that **every** requirement tied to one of the 7 baseline session methods is tiered
  `CAPABILITY` / `capability="capabilities.session"`, never `MANDATORY` — i.e. the *whole* session
  surface (including `session/prompt`, `session/cancel`, `session/update`) is gated as a unit on
  whether the agent advertised `capabilities.session` at all; only `initialize` itself is
  unconditionally mandatory in v2. `ACP-SESSION-001`/`002` (session-setup basics) are the anchor
  rows for that gate (`requirements.py:141-159`).

## 3. SDK v2 TypeScript surface (`@agentclientprotocol/sdk`)

### Import path

Installed package (`v1.4.0`) `package.json` `exports` map
(`node_modules/@agentclientprotocol/sdk/package.json`, confirmed identical to
`acp-typescript-sdk` `origin/main` `package.json:28-61`):

```json
"exports": {
  ".": { "types": "./dist/acp.d.ts", "import": "./dist/acp.js" },
  "./experimental/v2": { "types": "./dist/v2/acp.d.ts", "import": "./dist/v2/acp.js" },
  "./experimental/http-client": { ... },
  "./experimental/ws-client": { ... },
  "./experimental/server": { ... },
  "./experimental/node": { ... },
  "./schema/schema.json": "./schema/schema.json",
  "./schema/v2/schema.unstable.json": "./schema/v2/schema.unstable.json"
}
```

Today, **every** codex-acp source file imports from the bare `"@agentclientprotocol/sdk"`
specifier (v1 surface, `dist/acp.d.ts`) — confirmed via `src/index.ts:3`, `src/CodexAcpServer.ts:1-2`,
`src/AcpExtensions.ts` (type-only imports), `src/ElicitationCapabilities.ts:1`. Migrating means a
new specifier, `"@agentclientprotocol/sdk/experimental/v2"`, needs to be imported wherever v2
types/builders are used (note the SDK marks this path `experimental`, and the backing schema file
is literally named `schema.unstable.json` — the v2 surface is pre-1.0/unstable upstream even
though it's already shipped in the installed `1.4.0`).

### Key v2 types (from `src/v2/schema/types.gen.ts` in the SDK repo, referenced by line in the
`origin/main` blob read via `git show`; same content ships as
`node_modules/@agentclientprotocol/sdk/dist/v2/schema/types.gen.d.ts` in the installed package)

- `InitializeRequest` (`types.gen.ts:4859-4882`): `{ protocolVersion: ProtocolVersion; info:
  Implementation; capabilities?: ClientCapabilities; _meta?: {...} | null }`
- `InitializeResponse` (`types.gen.ts:1643-1677`): `{ protocolVersion: ProtocolVersion; info:
  Implementation; capabilities?: AgentCapabilities; authMethods?: Array<AuthMethod>; _meta?:
  {...} | null }`
- `Implementation` (`types.gen.ts:1692-1720`): `{ name: string; title?: string | null; version:
  string; _meta?: {...} | null }` — replaces both `ClientInfo`/`AgentInfo` from v1.
- `AgentCapabilities` (`types.gen.ts:1730-1795`): `{ session?: SessionCapabilities | null; auth?:
  AgentAuthCapabilities | null; providers?: ProvidersCapabilities | null /* unstable */; nes?:
  NesCapabilities | null /* unstable */; positionEncoding?: ... /* unstable */; _meta?: {...} |
  null }`
- `SessionCapabilities` (`types.gen.ts:1810-1867`): `{ prompt?: PromptCapabilities | null; mcp?:
  McpCapabilities | null; delete?: SessionDeleteCapabilities | null; additionalDirectories?:
  SessionAdditionalDirectoriesCapabilities | null; fork?: SessionForkCapabilities | null
  /* unstable */; _meta?: {...} | null }`. Doc comment on this type spells out the baseline
  literally: "Supplying `{}` means the agent supports the baseline session methods: `session/new`,
  `session/list`, `session/resume`, `session/close`, `session/prompt`, `session/cancel`, and
  `session/update`."
- `ClientCapabilities` (`types.gen.ts:4892-4943`): `{ auth?: AuthCapabilities | null;
  elicitation?: ElicitationCapabilities | null; nes?: ClientNesCapabilities | null /* unstable
  */; positionEncodings?: Array<PositionEncodingKind> /* unstable */; _meta?: {...} | null }` — no
  `fs`/`terminal` execution fields at all.
- `AuthCapabilities` (client-side, `types.gen.ts:4952-4972`): `{ terminal?:
  TerminalAuthCapabilities | null; _meta?: {...} | null }`.
- `AgentAuthCapabilities` (agent-side capability, distinct type from `AuthCapabilities`) — present
  as `types.gen.ts:2147` (`export type AgentAuthCapabilities = {...}`), currently empty besides
  `_meta` (reserved for future agent-side auth extensions).
- `PROTOCOL_VERSION` constant and the `methods` map (mirroring v1's `acp.methods`) are re-exported
  from `src/v2/acp.ts:19,27-52` (`export type * from "./schema/types.gen.js"`, plus
  `PROTOCOL_VERSION` at line 52).

### Batching and extensibility: already handled by the SDK transport, at least for stdio

Checked `src/jsonrpc.ts` and `src/connection.ts` in the SDK repo (both shared by v1 and v2 —
v2 does not reimplement JSON-RPC framing, it only adds v2-typed builder sugar in `src/v2/acp.ts`).

- **stdio path (what codex-acp uses via `createJsonStream`/`ndJsonStream` + `acp.agent(...).connect(...)`).**
  The low-level `Connection` class in `jsonrpc.ts` already parses/emits JSON-RPC batch arrays
  transparently: `receiveWireMessage` (`jsonrpc.ts:1245-1258`) checks `Array.isArray(message)` and
  dispatches to `receiveBatch` when so; `sendBatch` (`jsonrpc.ts:1017-1038`) sends an array frame.
  The `allowBatches` flag that gates this **defaults to `true`** (`jsonrpc.ts:1185`:
  `this.allowBatches = options?.allowBatches ?? true;`), and codex-acp's `acp.agent(...)` call in
  `src/index.ts:139-172` passes no `allowBatches` override. **Conclusion: for codex-acp's stdio
  transport, inbound/outbound JSON-RPC batching (`ACP-BATCH-*`/`ACP-JSONRPC-*`) is already handled
  transparently by the installed SDK with no code change required.** The v2 module additionally
  exposes ergonomic typed helpers `batchRequest`/`batchNotification` (`src/v2/acp.ts:190-330`) for
  callers who want to *originate* batches, which codex-acp doesn't currently need to do (it's
  reactive to the client's batches, not proactively batching its own outbound calls) — this
  is a nice-to-have, not a requirement.
- **Caveat found, not requested but relevant:** a *separate* `ConnectionState` class in
  `connection.ts` (used only by the HTTP/WebSocket multi-connection "AcpServer" transports —
  `server.ts`/`server-sse.ts`/`ws-server.ts`, not the stdio path) defaults `supportsBatches =
  false` (`connection.ts:130`) and requires an explicit `connection.enableBatches()` call once v2
  is negotiated (only `ws-server.ts:211` does this automatically today). This does **not** affect
  codex-acp, which is stdio-only, but is worth flagging in case codex-acp ever adds an HTTP/WS
  transport.
- **Extensibility / `_meta` passthrough (`ACP-EXT-*`/`ACP-META-*`).** Every v2 generated type
  (request, response, notification, every capability object) carries an explicit optional `_meta?:
  {[key: string]: unknown} | null` field in the generated Zod schemas
  (`src/v2/schema/zod.gen.ts`, mirrors `types.gen.ts`) and these are ordinary object fields, not
  stripped by any `.strict()` schema — the SDK does not silently drop unknown `_meta` payloads.
  Combined with codex-acp's existing pattern of `z.object({...}).passthrough()` for its own
  extension methods (`src/index.ts:21-24`), this confirms `_meta` passthrough is a first-class,
  already-supported mechanism requiring no transport-layer change.

**Answer to the scoping question:** JSON-RPC batching and `_meta`/extensibility passthrough do
**not** need their own migration topic. Batching is transparently supported by the SDK's stdio
`Connection` by default; `_meta` passthrough is a schema-level field already threaded through every
v2 type and already exercised by codex-acp's existing extension-method pattern. The only residual
action item (not a topic-worthy gap, just a line item under this topic or "config/session" topics)
is that codex-acp should decide whether it ever wants to *originate* batched outbound calls using
`batchRequest`/`batchNotification` — purely optional, no spec obligation.

## 4. Current codex-acp implementation (v1)

- **`src/index.ts:139-172`** — `acp.agent({name: packageJson.name})` builder wires
  `.onRequest(acp.methods.agent.initialize, (ctx) => getAgent().initialize(ctx.params))` plus all
  other v1 methods (`session.new`, `session.load`, `session.fork`, `session.list`,
  `session.delete`, `session.resume`, `session.close`, `session.setMode`,
  `session.setConfigOption`, `authenticate`, `logout`, `providers.list/set/disable`,
  `session.prompt`, `session.cancel` notification) plus a set of custom extension methods
  (`authentication/status`, `authentication/logout`, `LEGACY_SET_SESSION_MODEL_METHOD`,
  `SESSION_STEERING_METHOD`, `ASYNC_TASK_STOP_METHOD`, `GOAL_CONTROL_METHOD`) each with its own Zod
  params parser. All typed against the bare `acp` (v1) namespace.
- **`src/CodexAcpServer.ts:359-433`** — the `initialize` handler itself:
  - Reads `_params.clientInfo`, `_params.clientCapabilities` (v1 field names) into
    `this.clientInfo`/`this.clientCapabilities` (`:363-364`).
  - Derives internal feature flags from v1 `clientCapabilities` via helper predicates:
    `resolveTerminalOutputMode`, `clientSupportsTerminalOutputDelta`,
    `clientSupportsBooleanConfigOptions` (`:366-368`) — these read nested v1 `_meta`/boolean fields
    on `clientCapabilities`, not the standard v1 capability surface itself.
  - Builds `sessionCapabilities: SubagentAwareSessionCapabilities` as a v1-style object with
    per-method boolean-ish markers `resume: {}, list: {}, close: {}, delete: {}, fork: {}` plus
    codex-acp's own extensions `additionalDirectories: {}, subagents: {}` (`:371-379`) — type
    defined in `src/subagents/AcpSubagents.ts:35` (`SubagentAwareSessionCapabilities =
    SessionCapabilities & {...}`).
  - Returns the v1 `InitializeResponse` shape: `protocolVersion: acp.PROTOCOL_VERSION` (v1
    constant, currently `1`), `agentInfo` (not `info`), `agentCapabilities` containing `auth:
    {logout: {}}`, `providers: {}`, **`loadSession: true`** (a v1-only boolean field that v2
    removes entirely), `promptCapabilities: {embeddedContext: true, image: true}` (v1 **booleans**,
    would need to become `{}` objects nested under `capabilities.session.prompt` in v2),
    `sessionCapabilities` (as built above), `mcpCapabilities: {acp: false, http: true, sse: false}`
    (v1 booleans, mixing a codex-acp-specific `acp` transport marker with standard `http`/`sse`),
    and an agent-capabilities-level `_meta` carrying `AUTH_STATUS_META_KEY` (`:380-408`).
  - Top-level response `_meta` additionally carries codex-acp's own `steering`, `goal`, and
    JetBrains `JETBRAINS_META_KEY`/AIR extension descriptors (`:409-431`) — this pattern (top-level
    `_meta` for custom extension advertisement) carries over unchanged to v2, since v2's
    `InitializeResponse._meta` is the same kind of passthrough bag.
  - `authMethods: getCodexAuthMethods(_params.clientCapabilities)` (`:409`) — reads v1
    `clientCapabilities` to decide, e.g., whether the client supports URL elicitation
    (`clientSupportsUrlElicitation`, from `src/ElicitationCapabilities.ts:10-14`) or advertises a
    gateway `_meta` flag (`CodexAuthMethod.ts:79`). No `type: "terminal"` auth method is
    constructed anywhere today, so `ACP-AUTH-202`'s v2 terminal-gating rule is currently vacuously
    satisfied — but if a terminal auth method is ever added, it must be gated on
    `clientCapabilities.auth.terminal` (v2 nested object marker, not the v1 top-level boolean this
    code doesn't even currently read).
- **`src/AcpExtensions.ts`** — pure extension-method plumbing (goal control, session steering,
  legacy set-model, async-task-stop, plus the re-exported `AuthStatusMeta` helpers). Not part of
  standard `initialize` capability negotiation; unaffected by the v1→v2 capability *shape* change,
  though the methods it defines are advertised via the same top-level `_meta` bag in `initialize`
  and continue to work identically under v2.
- **`src/ElicitationCapabilities.ts:1-14`** — two tiny predicates,
  `clientSupportsFormElicitation`/`clientSupportsUrlElicitation`, typed against v1
  `acp.ClientCapabilities` and reading `clientCapabilities?.elicitation?.form/url != null`. The v1
  and v2 `ElicitationCapabilities` shapes are structurally identical (`form`/`url` object markers
  already, not booleans — elicitation was already object-shaped in v1), so **this file's logic is
  unchanged**; only its type import needs to move from `acp.ClientCapabilities` (v1) to the v2
  `ClientCapabilities` type once codex-acp's `initialize` handler is v2-typed. It also imports
  `InitializeCapabilities` from `./app-server` (Codex app-server's own generated types, unrelated
  to the ACP wire schema) — no change needed there.

## 5. Gap analysis — what must change for v2

0. **v1 is preserved, not replaced — see §0 above for the mechanism.** codex-acp will run
   `agentProtocolRouter().withV1(v1Agent).withV2(v2Agent)` (both from
   `@agentclientprotocol/sdk`/`@agentclientprotocol/sdk/experimental/v2` respectively) instead of
   connecting a single agent directly. All gap items below describe the **new, additional** v2
   `initializeV2` handler; the existing v1 `initialize` method (`CodexAcpServer.ts:359-433`) stays
   as-is and continues to serve v1 clients unchanged.
1. **Import surface split.** Introduce imports from `@agentclientprotocol/sdk/experimental/v2` for
   the v2-typed `initialize` request/response and capability types, alongside (not instead of, per
   `migration.mdx:772` — "keep two thin protocol surfaces behind shared application logic") the
   existing v1 imports, unless/until codex-acp decides to drop v1 support entirely.
2. **Rename fields:** `clientInfo`→`info` (request), `clientCapabilities`→`capabilities` (request);
   `agentInfo`→`info`, `agentCapabilities`→`capabilities` (response). `info` becomes required on
   both sides (already effectively true for codex-acp's outbound `agentInfo`, but the *inbound*
   client `info`/`clientInfo` handling — currently optional-safe via `?? null` at
   `CodexAcpServer.ts:363` — should be revisited since v2 clients are required to send it).
3. **Convert every boolean marker to an object marker:** `promptCapabilities.image/embeddedContext:
   true` → `capabilities.session.prompt.image/embeddedContext: {}`; `mcpCapabilities.http/sse:
   true/false` → `capabilities.session.mcp.http: {}` (omit key entirely for unsupported, rather
   than `false`); decide where codex-acp's non-standard `mcpCapabilities.acp` marker (currently
   `false`, unused/always-off) goes — it isn't part of the v2 schema's `McpCapabilities` (only
   `stdio`/`http`), so it either becomes a `_meta` entry or is dropped.
4. **Restructure nesting:** move `promptCapabilities`→`capabilities.session.prompt`,
   `mcpCapabilities`→`capabilities.session.mcp`, and fold the current top-level
   `sessionCapabilities` object into `capabilities.session`, dropping the `list`/`resume`/`close`
   markers entirely (since advertising `capabilities.session` at all now implies all 7 baseline
   methods) while keeping `delete`/`additionalDirectories` (and deciding what happens to
   codex-acp's non-standard `fork`/`subagents` extras — `fork` has a real v2 `SessionForkCapabilities`
   home now, `subagents` does not and needs a `_meta` slot or an RFD).
5. **Drop `loadSession: true`** entirely (and, in the session-lifecycle topic's scope, drop
   `session/load` support / fold it into `session/resume` with `replayFrom` — flag this for the
   session-lifecycle subagent).
6. **Remove the `auth.logout` capability marker**; instead ensure `authMethods` non-empty implies
   both `auth/login` (renamed from `authenticate` — flagged for the auth-rename topic) and
   `auth/logout` (renamed from `logout`) are implemented. `capabilities.auth` in the response
   becomes purely for auth *extensions* (today codex-acp sets `auth: {logout: {}}`, which must
   become something else or be removed since there's no v2 logout marker).
7. **Verify the 7-method baseline is actually fully implemented before advertising
   `capabilities.session` in v2** — codex-acp already implements all 7 v1 analogues
   (`newSession`, `listSessions`, `resumeSession`, `closeSession`, `prompt`, `cancel`, and v1's
   `session/update` notifications are already emitted), so this is expected to be satisfiable, but
   should be confirmed method-by-method by the session-lifecycle and prompt-lifecycle subagents.
8. **`protocolVersion`:** switch response to return `2` (or negotiate per `ACP-INIT-201`/`003`/`202`
   — echo `2` if requested `2`, else return the agent's own latest supported version, including for
   probes of `1` or out-of-range values) instead of the hardcoded v1 `acp.PROTOCOL_VERSION`. If
   codex-acp supports dual v1/v2 (recommended), this becomes real per-connection negotiation logic
   rather than a constant.
9. **`ACP-AUTH-202` compliance is a non-issue today** (no `type: "terminal"` auth method emitted)
   but must be kept in mind if terminal auth is ever added — gate it on
   `capabilities.auth.terminal` (v2 nested marker) once codex-acp reads v2 request capabilities.
10. **No transport-layer work needed** for JSON-RPC batching or `_meta` extensibility (see §3) —
    the installed SDK already handles both for the stdio transport codex-acp uses.

Files that will need changes when implementation begins: `src/index.ts` (method registration /
possibly dual-stack dispatch), `src/CodexAcpServer.ts` (`initialize` method body, and the
`clientInfo`/`clientCapabilities` fields plus every reader of them), `src/AcpExtensions.ts` (no
shape change, but its type imports may need updating if it starts being used from a v2-typed
context), `src/ElicitationCapabilities.ts` (type import swap only), `src/subagents/AcpSubagents.ts`
(`SubagentAwareSessionCapabilities` type needs a v2-shaped counterpart), `src/CodexAuthMethod.ts`
(`getCodexAuthMethods` signature currently takes v1 `ClientCapabilities`).

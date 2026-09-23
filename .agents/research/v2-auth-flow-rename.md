# v2 topic: Auth flow rename (`authenticate`→`auth/login`, `logout`→`auth/logout`, `id`→`methodId`, `type` required)

Spec checked at `agent-client-protocol` local checkout, commit `8c90bb7` (same commit the
capability-negotiation sibling topic used; `git pull --ff-only` reported "Already up to date").
SDK checked at `acp-typescript-sdk`, `origin/main` `69fda37` (same commit as sibling topic; local
checkout has diverged local branches so a plain `pull` fails — read via `git show origin/main:<path>`
instead, no working-tree edits). Installed npm package in codex-acp: `@agentclientprotocol/sdk@1.4.0`,
whose `dist/v1` types match the same shapes used below for v1.

This topic's finding, in one line: **as mechanical as it looks.** The request/response payload
shapes are already byte-for-byte compatible between v1 and v2 (v1's `AuthenticateRequest`/
`LogoutRequest` already use `methodId` and an empty-ish body); the only real change is (a) two new
method-name registrations on the v2 chain, and (b) `methodId`/`type` fixes to the four `AuthMethod`
*descriptor* literals in `getCodexAuthMethods`. No internal auth business logic changes at all.

## 1. v1 vs v2 shapes

### 1a. Method names

| v1 | v2 |
|---|---|
| `authenticate` | `auth/login` |
| `logout` | `auth/logout` |

Citation: `docs/protocol/v2/migration.mdx:39-40,193,197-198,730` ("Rename `authenticate` →
`auth/login` for method types that define protocol-driven login. If you return one or more valid
`authMethods`, implement both `auth/login` and `auth/logout`; if you omit the field or return an
empty array, Clients MUST NOT call either method. Do not add a logout support marker...").

### 1b. Request/response bodies — already identical

Installed v1 types (`node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts:4565-4686`):

```ts
export type AuthenticateRequest = {
    methodId: AuthMethodId;   // already `methodId`, not `id`, in v1!
    _meta?: {[key: string]: unknown} | null;
};
export type LogoutRequest = {
    _meta?: {[key: string]: unknown} | null;
};
```

v2 types (`acp-typescript-sdk` `src/v2/schema/types.gen.ts:5151-5171` and `:5269-5285`):

```ts
export type LoginAuthRequest = {
    methodId: AuthMethodId;
    _meta?: {[key: string]: unknown} | null;
};
export type LogoutAuthRequest = {
    _meta?: {[key: string]: unknown} | null;
};
export type LoginAuthResponse  = { _meta?: {...} | null };  // same as v1's `{}`-shaped AuthenticateResponse
export type LogoutAuthResponse = { _meta?: {...} | null };  // same as v1's `{}`-shaped void/empty result
```

**The request/response payload shapes are structurally unchanged.** Migration doc confirms this
explicitly: `docs/protocol/v2/migration.mdx:197` — "`authenticate` → `auth/login`. **The params are
unchanged** (`methodId` selecting an advertised method whose type defines a protocol-driven login
flow)." Only the wire *method name* changed, not the payload shape. `codex-acp`'s existing
`CodexAuthRequest` union (`src/CodexAuthMethod.ts:86`, keyed on `.methodId`) and its internal
`authenticate(_params, requestId)` / `logout(_params)` handler bodies
(`src/CodexAcpServer.ts:994-1041`) need **zero** change to keep working for v2 — they already read
`_params.methodId`, never `_params.id`.

### 1c. `AuthMethod` descriptor — the one real shape change

v1 (installed `dist/schema/types.gen.d.ts:2221-2290`):
```ts
export type AuthMethod = (AuthMethodTerminal & {type: "terminal"}) | AuthMethodAgent;
export type AuthMethodAgent = { id: AuthMethodId; name: string; description?: string|null; _meta?...};
// `type` defaults to "agent" when absent — no `type` field required on AuthMethodAgent at all.
```

v2 (`src/v2/schema/types.gen.ts:2516-2560, 2595-2662`):
```ts
export type AuthMethod =
  | (AuthMethodTerminal & { type: "terminal" })
  | (AuthMethodAgent & { type: "agent" })
  | { type: string; methodId: AuthMethodId; name: string; description?: string|null; _meta?...; [key:string]: unknown };
export type AuthMethodAgent = { methodId: AuthMethodId; name: string; description?: string|null; _meta?...};
export type AuthMethodTerminal = { methodId: AuthMethodId; name: string; description?: string|null; args?: string[]; env?: EnvVariable[]; _meta?... };
```

So the descriptor field renames `id`→`methodId`, and every entry now must carry an explicit `type`
(`"agent"`, `"terminal"`, or a `_`-prefixed custom value — never absent, never a bare "assume
agent"). v2 also adds `args`/`env` (array of `{name,value}`) to `AuthMethodTerminal` that v1's
terminal descriptor never had (`ACP-AUTH-207`, new in v2).

**codex-acp's four `AuthMethod` literals in `src/CodexAuthMethod.ts:17-58` all use `id:` and none
set `type:`** — `ApiKeyAuthMethod` (`:17`), `ChatGptAuthMethod` (`:28`), `ChatGptDeviceCodeAuthMethod`
(`:38`), `GatewayAuthMethod` (`:48`). For v2 these four need `methodId:` instead of `id:` plus an
explicit `type: "agent"` (all four are protocol-driven agent-handled logins today; none is
`terminal` — confirmed no `type: "terminal"` entry exists anywhere in this file, matching the
capability-negotiation topic's note that `ACP-AUTH-202`/terminal gating is currently vacuous).

### 1d. Example wire messages (v2, from `docs/protocol/v2/authentication.mdx:60-82,166-190,225-242`)

```json
// initialize response (excerpt)
{"result": {"authMethods": [{"methodId": "agent-login", "name": "Agent login", "type": "agent", "description": "Sign in using the agent's login flow"}]}}

// auth/login request
{"jsonrpc": "2.0", "id": 1, "method": "auth/login", "params": {"methodId": "agent-login"}}
// auth/login response
{"jsonrpc": "2.0", "id": 1, "result": {}}

// auth/logout request
{"jsonrpc": "2.0", "id": 2, "method": "auth/logout", "params": {}}
// auth/logout response
{"jsonrpc": "2.0", "id": 2, "result": {}}
```

## 2. TCK requirement texts (`acp-tck/src/tck/v2/requirements.py`)

- **`ACP-AUTH-201`** (ADVISORY): "`authMethods[*].methodId` values are unique. Re-cites v1's
  `ACP-AUTH-001`; only the field name changed (`id` -> `methodId`)." (`:1052-1059`)
- **`ACP-AUTH-202`** — already covered by the capability-negotiation topic; not duplicated here.
  (Terminal-type gating on `capabilities.auth.terminal`; codex-acp emits no terminal methods today,
  so vacuously satisfied.)
- **`ACP-AUTH-203`** (CAPABILITY, `capability="inferred:authMethods"`): "`auth/logout` returns a
  non-error, schema-valid result. Support is inferred from a non-empty `authMethods` — v2 has no
  `agentCapabilities.auth.logout` marker at all... Replaces v1's `ACP-AUTH-004` outright. Only
  actually exercised when `--allow-logout`/`--tck-allow-logout` is given (destructive...); SKIPs
  otherwise." (`:1078-1095`)
- **`ACP-AUTH-204`** (CAPABILITY, `capability="inferred:authMethods"`): "Given `--auth-method <id>`
  naming a non-`terminal`, advertised `methodId`, `auth/login` does not answer `-32601` (Method not
  found), and a subsequent `session/new` does not fail with `-32000`. Mirrors v1's `ACP-AUTH-003`
  exactly, method renamed `authenticate` -> `auth/login`. SKIPs when `--auth-method` was not given,
  or the agent advertises no `authMethods`." (`:1096-1111`)
- **`ACP-AUTH-205`** (ADVISORY): "`session/new` does not fail with `-32000`
  (AUTHENTICATION_REQUIRED) when `authMethods` is empty or absent. Re-cites v1's
  `ACP-AUTH-005`/AUTH-A1; not promoted." (`:1112-1122`)
- **`ACP-AUTH-206`** (MANDATORY): "Every `authMethods[*].type` is one of the schema's defined
  discriminator values (`\"agent\"`, `\"terminal\"`) or begins with `_`... New in v2: v1's `type`
  could default to \"agent\" when absent and had no enum-closure rule at all." (`:1123-1137`)
- **`ACP-AUTH-207`** (MANDATORY, conditional on ≥1 terminal entry appearing, else SKIPs): "every
  `type: \"terminal\"` entry's `args` (if present) is an array of strings, `env` (if present) is an
  array of well-formed `EnvVariable` objects... New in v2 -- v1's terminal auth descriptor had no
  `args`/`env` fields." (`:1138-1153`)

Net effect for codex-acp today: `ACP-AUTH-206` is the only one requiring a code change (add
`type: "agent"` to all four descriptors — currently absent, which is fine under v1's default-to-agent
rule but fails v2's closed-enum requirement since `type` is simply missing, not `"agent"` literally).
`ACP-AUTH-207`/`ACP-AUTH-202` stay vacuous (no terminal method emitted). `ACP-AUTH-201`/`204`/`205`
just require the mechanical `methodId` rename to already be correct.

## 3. Current codex-acp implementation (v1)

- **`src/index.ts:159-160`** — v1 registration:
  ```ts
  .onRequest(acp.methods.agent.authenticate, (ctx) => getAgent().authenticate(ctx.params, ctx.requestId))
  .onRequest(acp.methods.agent.logout, (ctx) => getAgent().logout(ctx.params))
  ```
- **`src/index.ts:166-167`** — codex-acp's own custom extension methods, unrelated to the standard
  rename, registered as raw JSON-RPC method strings with their own Zod parser:
  ```ts
  .onRequest("authentication/status", emptyExtensionParamsParser, (ctx) => getAgent().extMethod("authentication/status", ctx.params))
  .onRequest("authentication/logout", emptyExtensionParamsParser, (ctx) => getAgent().extMethod("authentication/logout", ctx.params))
  ```
- **`src/CodexAcpServer.ts:994-1008`** — `authenticate(_params: acp.AuthenticateRequest, requestId?: acp.JsonRpcId)`:
  creates a `UrlElicitationRequester` from `requestId` (`:1010-1033`, used only for the
  `chat-gpt-device-code` flow's `client.elicitation.create`/`complete` calls), calls
  `this.codexAcpClient.authenticate(_params, elicitationRequester)`, then
  `refreshAuthState(getAuthProviderForAuthenticateRequest(_params))` (`:800`, reads `_params` type
  narrowing only, no method-name dependency).
- **`src/CodexAcpServer.ts:1035-1041`** — `logout(_params: acp.LogoutRequest)`: calls
  `this.codexAcpClient.logout()`, then `refreshAuthState(null)`. No use of `_params` at all beyond
  the type signature (its body is `{}`-shaped in both v1 and v2).
- **`src/CodexAcpServer.ts:441-446`** — the custom `authentication/logout` extension method's
  handler just calls `this.logout({})` internally — i.e. it's a thin alias over the same standard
  `logout` method, already decoupled from the standard method's wire name.
- **`src/CodexAcpServer.ts:387-390,409`** — `initialize`'s v1 response sets
  `agentCapabilities.auth: {logout: {}}` (the v1 logout-support marker, removed entirely in v2 per
  the capability-negotiation topic) and `authMethods: getCodexAuthMethods(_params.clientCapabilities)`.
- **`src/CodexAuthMethod.ts:17-90`** — `getCodexAuthMethods()` builds the `AuthMethod[]` array from
  four literals (`ApiKeyAuthMethod`, `ChatGptAuthMethod`, `ChatGptDeviceCodeAuthMethod`,
  `GatewayAuthMethod`), all keyed by `id:`, none with `type:`. The four matching `*AuthRequest`
  interfaces (`ApiKeyAuthRequest`, `ChatGPTAuthRequest`, `ChatGPTDeviceCodeAuthRequest`,
  `GatewayAuthRequest`, all `extends AuthenticateRequest`) are keyed by `methodId:` — already
  v2-shaped on the request side, confirming §1b's "params unchanged" claim empirically in this
  codebase, not just per spec text.
- **`src/AuthStatusMeta.ts`** — the `_auth/status_update` push extension (connection-scoped identity
  reporting) is completely orthogonal to the standard `authenticate`/`logout` rename: it's a
  separate custom notification (`AUTH_STATUS_UPDATE_METHOD = "_auth/status_update"`) pushed after
  `initialize`, after every `authenticate`/`logout` completion (`CodexAcpServer.ts` calls
  `refreshAuthState` after both), and on `account/updated`. Nothing in its shape (`AuthStatus`,
  `AuthStatusKind`, etc.) references the ACP method names or the `AuthMethod` descriptor shape, so
  it needs **no change** for this topic — it keeps firing identically regardless of whether the
  triggering request arrived as v1 `authenticate`/`logout` or v2 `auth/login`/`auth/logout`, as long
  as both v1 and v2 handlers call the same `refreshAuthState(...)` after their respective
  `codexAcpClient.authenticate`/`.logout()` calls.
- **`src/login.ts`** — the standalone `codex-acp login` CLI subcommand talks directly to the Codex
  app-server (`CodexAppServerClient.accountLogin`/`accountRead`), entirely bypassing the ACP
  `authenticate`/`auth/login` surface. Confirmed unrelated to this topic; no v1/v2 ACP shape
  appears anywhere in this file.
- **`src/__tests__/CodexACPAgent/new-session-logout.test.ts`** — exercises `codexAcpClient.logout()`
  (the *internal* Codex-app-server-facing logout, called from `CodexAcpServer.handleError`, e.g. on
  a "please log out and sign in again" app-server error) — this is one layer *below* the ACP-facing
  `authenticate`/`logout` methods and has no dependency on the ACP method name or `AuthMethod` shape
  at all. It will keep passing unmodified for both v1 and v2 connections, since it never goes
  through the ACP-layer method dispatch under test.
- **Test-infra note (not application code, flagged for awareness):**
  `src/__tests__/CodexACPAgent/e2e/acp-e2e-test-utils.ts:54,79` reads `method.id === "api-key"` /
  `method.id === "gateway"` against the *v1* `authMethods` array returned by a live e2e connection.
  If/when a v2-native e2e harness variant is added, its equivalent helper will need
  `method.methodId === ...` instead — mechanical, but a reminder that test helpers, not just
  application code, read the renamed field.

## 4. Dual-version lens — cost/risk assessment

**Genuinely as mechanical as it looks. No hidden complication found.**

- **Wire method names differ** (`authenticate`/`logout` vs `auth/login`/`auth/logout`) but the SDK's
  `AgentProtocolRouter` (per the capability-negotiation topic's §0) already routes the entire
  connection to one full handler chain per negotiated version, so this is simply two separate
  `.onRequest(...)` registration lines — one on `v1Agent` (unchanged), one new on `v2Agent` — not a
  runtime branch inside shared code.
- **Request/response payload shapes are already identical** between v1's `AuthenticateRequest`/
  `LogoutRequest` and v2's `LoginAuthRequest`/`LogoutAuthRequest` (§1b) — confirmed both from the
  spec text ("params are unchanged") and from codex-acp's own existing `methodId`-keyed
  `CodexAuthRequest` types. **This means `CodexAcpServer.authenticate`/`.logout()` need zero
  signature or body changes**; the v2 handler on `v2Agent` can call the *exact same* method,
  passing the v2 params object straight through (structurally compatible; a same-shape type cast or
  a trivial identity adapter is the only "adapter" needed, and even that may be unnecessary if the
  method signature is loosened to accept the structural shape rather than the nominal v1 type).
- **`ctx.requestId` is available identically in the v2 handler context.** Verified in
  `acp-typescript-sdk` `src/v2/acp.ts:930-957` (`AcpContext.requestId` getter, `AgentContext extends
  AcpContext`) — same `JsonRpcId | undefined` shape as v1's `ctx.requestId` used today
  (`src/index.ts:159`). So the `chat-gpt-device-code` URL-elicitation correlation path in
  `createUrlElicitationRequester` (`CodexAcpServer.ts:1010-1033`) carries over to a v2 `auth/login`
  handler without modification — it only needs `requestId`, and the v2 SDK exposes it the same way.
  `methods.client.elicitation.create`/`.complete` are also unchanged method names in v2
  (`acp-typescript-sdk` `src/v2/acp.ts:790-792`), so the elicitation call inside that requester
  needs no v2-specific branch either — only the *type* it's imported from (`acp` vs `acpV2`
  namespace) changes, per the capability-negotiation topic's general import-surface-split guidance.
- **The one real code change is in `src/CodexAuthMethod.ts`**: `getCodexAuthMethods()` needs a
  v2-shaped counterpart (or the existing function extended/parameterized) that emits `methodId:`
  instead of `id:` and adds `type: "agent"` to all four literals. Since the function's *logic*
  (which methods to include, based on `clientSupportsUrlElicitation`/gateway `_meta` flag) is
  identical between versions, this is naturally a single shared "recipe" (id/name/description/meta
  per method) fed through two thin builder functions — one emitting `{id, name, ...}` (v1) and one
  emitting `{methodId, type: "agent", name, ...}` (v2) — rather than a duplicated decision tree. The
  client-capability *input* type also differs (v1 `ClientCapabilities` vs v2 `ClientCapabilities`,
  different shapes) but `clientSupportsUrlElicitation`'s underlying elicitation shape is unchanged
  between versions (confirmed by the capability-negotiation topic's §4 on `ElicitationCapabilities.ts`),
  so only the type import needs updating per version, not the logic.
- **codex-acp's custom `authentication/status`/`authentication/logout` extension methods are a
  non-issue, not a hidden complication.** They are raw custom JSON-RPC method names (not part of
  the standard ACP method set gated by protocol version at all), so they simply get registered
  identically on both `v1Agent` and `v2Agent` chains with the same Zod parser and the same
  `getAgent().extMethod(...)` dispatch — two near-identical registration lines, zero shape
  divergence, since `extMethod`'s internal switch dispatches on the method string, not on any
  version-specific type.
- **`_auth/status_update` push extension (`AuthStatusMeta.ts`) requires no change** — it is a
  separate notification fired by internal `refreshAuthState(...)` calls after either version's
  login/logout completes; it doesn't read or emit any `authenticate`/`auth/login` shape itself.

**Estimated work:** two new `.onRequest` registrations in the v2 chain (`src/index.ts`), a
`methodId`/`type` variant of the four `AuthMethod` literals in `src/CodexAuthMethod.ts` (or a tiny
parameterized builder shared between the v1 and v2 variants), duplicating the two custom
`authentication/*` extension registrations onto the v2 chain, and updating `getCodexAuthMethods`'s
call site in `initializeV2` (the capability-negotiation topic's new handler) to use the v2 variant.
No new state, no new error-handling paths, no divergent business logic. This is one of the smallest
topics in the migration.

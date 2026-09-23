# v2 topic: MCP config shape changes & client fs/terminal execution surface removal

Spec checked at `agent-client-protocol` local checkout (`.repo` →
`/Users/eugene/Documents/JetBrains/projects/agent-client-protocol`), refreshed via
`git pull --ff-only` → "Already up to date" (tip unchanged from what the sibling
capability-negotiation topic checked). TS SDK checked at `acp-typescript-sdk` local checkout
(`/Users/eugene/Documents/JetBrains/projects/acp-typescript-sdk`); `git pull --ff-only` failed
("local changes to package-lock.json would be overwritten") — same pre-existing dirty file the
sibling subagent flagged, unrelated to source files. Left un-merged, at `f1c0141`; all v2 type
reads below are from that commit's `src/v2/schema/types.gen.ts`, which is the same content the
sibling topic already verified matches the installed `@agentclientprotocol/sdk@1.4.0` package
(`origin/main` was `69fda37`, source-file-identical to what's installed).

## 1. v1 vs v2 MCP server config shapes

### v1 (installed SDK: `node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts`)

```ts
// types.gen.d.ts:4728-4734
export type McpServer = (McpServerHttp & { type: "http" })
  | (McpServerSse & { type: "sse" })
  | (McpServerAcp & { type: "acp" })   // @experimental, unstable
  | McpServerStdio;                     // <-- NO "type" field at all
```

- `McpServerStdio` (`:4850-4877`): `{ name: string; command: string; args: Array<string>;
  env: Array<EnvVariable>; _meta?... }` — **`args`/`env` are required arrays** (empty array, not
  omission, represents "none"). No `type` discriminator — it's the untagged fallback member of
  the union.
- `McpServerHttp` (`:4761-4784`) / `McpServerSse` (`:4788-4811`): both `{ name, url, headers:
  Array<HttpHeader> }` — **`headers` required**, `type: "http"`/`"sse"` tag added by the union
  intersection.
- `McpCapabilities` (`:1629-1650`): `{ http?: boolean; sse?: boolean; acp?: boolean /*
  unstable */ }` — **no `stdio` marker at all**; stdio is baseline/implicit in v1 (there's no way
  to opt out of it).

### v2 (`acp-typescript-sdk` `src/v2/schema/types.gen.ts`)

```ts
// types.gen.ts:5245-5265
export type McpServer =
  | (McpServerHttp & { type: "http" })
  | (McpServerAcp & { type: "acp" })    // still @experimental/unstable
  | (McpServerStdio & { type: "stdio" })
  | { type: string; [key: string]: unknown };  // open extension fallback, _-prefixed = custom
```

- `McpServerStdio` (`:5358-5385`): `{ name; command: AbsolutePath; args?: Array<string>; env?:
  Array<EnvVariable>; _meta?... }` — **`args`/`env` now optional** (v2 doc, `migration.mdx:646`:
  "Empty arrays are no longer required ... optional in v2 (v1 required `args` and `env` even
  when empty)").
- `McpServerHttp` (`:5294-5317`): `{ name; url; headers?: Array<HttpHeader>; _meta?... }` —
  **`headers` now optional**.
- **`McpServerSse` / `"type": "sse"` does not exist in v2 at all** — the deprecated HTTP+SSE
  transport is removed outright (`migration.mdx:644`).
- `capabilities.session.mcp` (`McpCapabilities`, doc example at `session-setup.mdx:448-455`):
  `{ stdio?: {}; http?: {} }` — **`stdio` is now an explicit, opt-out-able capability marker**
  (`migration.mdx:645`), unlike v1 where it was implicit baseline.
- `NewSessionRequest`/`ResumeSessionRequest`/`ForkSessionRequest.mcpServers` are all `Array<McpServer>`, **optional**, same as v1
  (`types.gen.ts:5224`, `:5467`, `:5507`).

### v2 spec example (`docs/protocol/v2/migration.mdx:648-664`)

```json
{
  "mcpServers": [
    { "type": "stdio", "name": "filesystem", "command": "/usr/local/bin/mcp-fs", "args": ["--root", "/home/user/project"] },
    { "type": "http", "name": "linear", "url": "https://mcp.linear.app/mcp" }
  ]
}
```

The three normative deltas, straight from `migration.mdx:641-646` ("MCP server configuration"):
1. Every server config **MUST** carry a `type` discriminator — v1 stdio had none, v2 requires
   `"type": "stdio"`.
2. `"type": "sse"` is **removed**.
3. `stdio` becomes an explicit, advertisable/opt-out-able capability (`session.mcp.stdio`)
   alongside `session.mcp.http`.

## 2. TCK requirement texts (`acp-tck/src/tck/v2/requirements.py`)

- **`ACP-MCP-201`** (`:948-963`, INFORMATIONAL, `capability=None` despite gating on
  `capabilities.session.mcp.stdio`): "records whether `session/new` accepts a well-formed stdio
  MCP server entry when the marker is advertised. A connect failure against a harmless,
  possibly-nonexistent command is the agent's own business ... and is not provably
  non-conformant, so this never asserts on the outcome." Cites `session-setup.mdx:336-386,440,465`
  and `schema/v2/schema.json:6176-6214`.
- **`ACP-MCP-202`** (`:964-974`, INFORMATIONAL): same reasoning, for the http transport gated on
  `capabilities.session.mcp.http`. Cites `session-setup.mdx:388-436`, `schema.json:6147-6175`.
  Both rows are deliberately non-asserting/observational — there is no MANDATORY/CAPABILITY row
  that fails a v2 agent for rejecting a well-formed MCP config; the TCK only records behavior.
- **`ACP-CLIENTCAP-202`** (`:350-365`, CAPABILITY, `capability="capabilities.session"`): "Every
  agent->client request/notification method observed during a prompt turn is a member of
  `CLIENT_METHODS` or `PROTOCOL_METHODS` ... `fs/*`/`terminal/*` do not exist as v2 methods at
  all, so calling either FAILs here as an undefined method (the v2 collapse of v1's separate
  `ACP-CLIENTCAP-001/002` rows)." Cites `schema/v2/meta.json:16-21`, `migration.mdx:53-54,628-637`,
  `extensibility.mdx:43,52`. This is a negative/absence check — it would only ever fail codex-acp
  if codex-acp's v2 handler *called* `fs/*` or `terminal/*` on the client, which (see §4) it
  never does even in v1.

## 3. Current codex-acp implementation (v1) — file:line references

- **`src/CodexAcpClient.ts:903-922`**, `createMcpSeverConfig(mcpServer: McpServer): JsonObject`
  — the actual v1→Codex-app-server-config converter, called from `createSessionConfig`
  (`:807-855`), which is invoked from `newSession`/`resumeSession`/`forkSession` (`:591, :631,
  :672`) and from `SessionFork.forkSession` (`src/SessionFork.ts:31-37`, via the injected
  `createSessionConfig` dependency at `SessionFork.ts:13-17`). Logic:
  ```ts
  private createMcpSeverConfig(mcpServer: McpServer): JsonObject {
      if ("type" in mcpServer) {
          switch (mcpServer.type) {
              case "acp": throw RequestError.invalidRequest("Codex doesn't support MCP ACP transport protocol")
              case "sse": throw RequestError.invalidRequest("Codex doesn't support MCP SSE transport protocol")
              case "http": return { "url": mcpServer.url, "http_headers": Object.fromEntries(mcpServer.headers.map(h => [h.name, h.value])) }
          }
      }
      return { "command": mcpServer.command, "args": mcpServer.args, "env": Object.fromEntries(mcpServer.env.map(env => [env.name, env.value])) }
  }
  ```
  This relies on v1's **untagged stdio** shape: `"type" in mcpServer` is `false` only for stdio,
  which is how the function distinguishes stdio from http/sse/acp. **This is a genuine
  shape-dependent hazard for v2 reuse** — see §5.
- **`src/CodexAcpServer.ts:643, 690, 711, 1920, 1977`** — `requestedMcpServers = request.mcpServers
  ?? []` read from `acp.NewSessionRequest | acp.ResumeSessionRequest | acp.ForkSessionRequest`
  (typed at `:635`), threaded through session state (`sessionState.mcpServers`, `:711`) and used
  later for recovery/re-auth bookkeeping (`resolveSessionMcpServers` at `:2448-2463`,
  `authenticateMcpServer` at `:2545`).
- **`src/CodexAcpServer.ts:3514-3516`**, `getRequestedMcpServerNames(mcpServers)` — maps
  `sanitizeMcpServerName(server.name)`; only touches `.name`, shape-agnostic across v1/v2.
- **`src/McpServerName.ts:1-5`** — `sanitizeMcpServerName` (whitespace → `_`); pure string
  utility, no protocol-shape dependency at all.
- **`src/permissions/mcp.ts`** — this file is **not** about MCP *server config*; it's about MCP
  tool-call/elicitation **approval requests** (turning an app-server `McpServerElicitationRequestParams`
  into an ACP `RequestPermissionRequest`/`ToolCallContent`). Untouched by the config-shape change;
  it operates purely on already-connected MCP servers' runtime elicitation flow, typed against
  `app-server/v2` types, not `acp.McpServer`.
- **`src/CodexAcpServer.ts:398-405`** (v1 `initialize` response): `mcpCapabilities: {acp: false,
  http: true, sse: false}` — no `stdio` field (matches v1 schema, which has none). Already flagged
  by the capability-negotiation topic (its gap item 3) as needing conversion to
  `capabilities.session.mcp: {stdio: {}, http: {}}` in the new `initializeV2` handler, with the
  non-standard `acp: false` marker dropped or moved to `_meta`. Not re-litigated here; this
  topic's finding is specifically about the *session/new-time* config-shape converter, not the
  initialize-time capability advertisement (that's topic 1's scope).

## 4. Does codex-acp rely on client-side `fs`/`terminal` capabilities today? — **No.**

Exhaustive grep of every `clientCapabilities`/`acp.ClientCapabilities` read in `src/` (excluding
tests):

```
src/TerminalOutputMode.ts       — clientCapabilities?._meta?.["terminal_output_delta"]  (custom _meta key, NOT clientCapabilities.terminal)
src/ElicitationCapabilities.ts  — clientCapabilities?.elicitation?.form / .url
src/CodexElicitationHandler.ts  — reads the two ElicitationCapabilities predicates
src/CodexAuthMethod.ts          — clientCapabilities?.auth?._meta?.["gateway"]
src/PlanCapabilities.ts         — clientCapabilities?.plan
src/CodexAcpServer.ts           — resolveTerminalOutputMode / clientSupportsTerminalOutputDelta /
                                   clientSupportsBooleanConfigOptions / clientSupportsSubagents /
                                   clientSupportsAirCapability / clientSupportsCompaction /
                                   clientSupportsPlanUpdates / clientSupportsTypedSessionFailures /
                                   clientSupportsNotices / clientSupportsAgentFileChangeReports
src/FastModeConfig.ts           — clientCapabilities?.session?.configOptions?.boolean
```

**Not one** of these reads `clientCapabilities.fs` or `clientCapabilities.terminal` (the
top-level v1 boolean/object markers that gate `fs/read_text_file`/`fs/write_text_file` and
`terminal/create`/`terminal/output`/`terminal/release`/`terminal/wait_for_exit`/`terminal/kill`).
A separate repo-wide grep for `fs/read_text_file`, `fs/write_text_file`, `terminal/create`,
`terminal/output`, `terminal/release`, `terminal/wait_for_exit`, `terminal/kill` as outbound
method names (i.e. codex-acp *calling* the client) also found nothing in `src/` — codex-acp never
issues any of the six client-execution methods v2 removes. `TerminalOutputMode`/
`terminalOutputDeltaSupported` is unrelated: it's about the **Agent-owned terminal display**
surface (`terminal/output_chunk`/session-update terminal content, i.e. codex-acp streaming its
own subprocess output *to* the client for display), which v2 explicitly keeps ("Agent-owned
terminal output is a separate display-only v2 surface", `migration.mdx:14`) — not the v1 client
execution surface being removed.

This matches the architectural expectation stated in this topic's brief: **Codex's app-server
does all sandboxed file I/O and command execution itself** (that's the entire reason
`CodexAppServerClient`/`CodexAcpClient` exist — they proxy to Codex's own sandboxed exec/apply-patch
machinery, never to ACP's `fs/*`/`terminal/*`). codex-acp was never a client-fs/terminal consumer
in the first place, so v2's removal of that surface is a **structural non-event** for codex-acp:
no code path calls it, no capability check gates behavior on it, and there is nothing to replace
with an MCP server on codex-acp's side (codex-acp is the *Agent*, not a client needing file/exec
tools from its own client — the MCP-replacement guidance in `migration.mdx:635` is aimed at
Clients that *were* offering `fs`/`terminal` to Agents, a role codex-acp never depended on).

One indirect, cosmetic consequence: v1's `authMethods`/other logic never constructs a `type:
"terminal"` auth method (confirmed by the capability-negotiation topic), so there is also no
existing dependency on the *client's* `clientCapabilities.auth.terminal` marker (a different,
unrelated "terminal" — v2's interactive-terminal-for-auth capability, not file/exec execution).
Nothing here needs to change.

## 5. Dual-version lens: can MCP config be one code path with a shape-conversion boundary?

**Mostly yes, with one concrete runtime hazard to fix, not a structural blocker.**

MCP config is established once, at `session/new`/`session/resume`/`session/fork` time, exactly as
the brief assumes. codex-acp's session-lifecycle code (`CodexAcpServer.tryCreateSession`,
`:634-672`) already treats `request.mcpServers` as an opaque `Array<McpServer>` passed straight
through to `createSessionConfig`/`createMcpSeverConfig` — there is no separate "v1 MCP subsystem"
to duplicate; it's a single converter function.

**The hazard:** `createMcpSeverConfig` (`CodexAcpClient.ts:903-922`) hardcodes two v1-only
assumptions that break at runtime (not just typecheck) if fed a v2-shaped `McpServer` unchanged:

1. **Stdio detection via `"type" in mcpServer"`.** v2 stdio entries carry `"type": "stdio"`, so
   the `if ("type" in mcpServer)` guard would be `true` for v2 stdio too, entering the `switch`
   where there is no `"stdio"` case. Because the `switch` has no `default`, this doesn't throw —
   it silently falls through to the same final `return {command, args, env}` stdio-shaped object,
   which happens to be correct output. But this only works by accident of "no default case
   throws/no-ops"; it is fragile and the `if`/`switch` structure needs an explicit `"stdio"` case
   (or restructuring to switch on `mcpServer.type ?? "stdio"`) to be correct-by-construction for
   v2, and to reject v2's new open extension variant (`{type: string, ...}` for unknown/custom
   transports) explicitly rather than falling through into stdio's `.command`/`.args`/`.env`
   accesses (which would be `undefined` and produce a garbled Codex config instead of a clear
   error).
2. **`args`/`env`/`headers` assumed always-present arrays.** v1's schema guarantees these are
   arrays (possibly empty); v2 makes them optional (`args?`, `env?`, `headers?`). Unchanged, `mcpServer.env.map(...)` / `mcpServer.headers.map(...)` will throw a `TypeError: Cannot
   read properties of undefined` on a well-formed, spec-legal v2 request that simply omits `env`
   or `headers` (a config a v2 client is now allowed and likely to send, per
   `migration.mdx:646`'s explicit callout that this was a deliberate v1 ergonomics fix). This
   needs `?? []` defensiveness (or equivalent) wherever the v2 path calls this converter — a small,
   local, mechanical fix, not a design change.
3. **`"type": "sse"` no longer reachable from a v2 client** (the type isn't in the v2 schema's
   union), so that `throw` branch becomes dead code on the v2 side — harmless to leave in place
   defensively (a legacy/pathological client could still literally send `{"type": "sse", ...}` on
   the wire since JSON-RPC doesn't runtime-enforce the schema), but no longer a spec-mandated
   rejection path for v2.

**No state divergence needed.** Everything downstream of the per-entry config conversion
(`getRequestedMcpServerNames`, `resolveSessionMcpServers`, `sessionState.mcpServers`,
`authenticateMcpServer`, MCP startup/auth recovery) operates on `.name` or on the already-built
Codex JSON config, never on the v1/v2 `McpServer` union shape itself — so once the converter is
fixed to handle both shapes, the rest of the session/MCP machinery needs zero forking between v1
and v2 call sites. The two realistic implementation options are (a) one converter function
overloaded/parameterized to accept either `v1.McpServer | v2.McpServer` with the fixes above, or
(b) a thin per-version adapter that normalizes both into one internal shape (`{name, kind:
"stdio"|"http", command?, args, env, url?, headers}` with defaults already applied) before a
single shared builder — both are cheap; (b) is slightly cleaner given v1's stdio being untagged
is itself an oddity worth normalizing away early rather than re-deriving via `"type" in x"` at
every call site.

**Verdict for this topic: small, mechanical effort.** No divergent internal logic or session
state is required for v1 vs v2 MCP configs — only a corrected/defensive per-entry shape
converter (one file, `CodexAcpClient.ts:903-922`) plus the already-tracked `initializeV2`
capability-advertisement update (topic 1's scope: add `stdio: {}` under
`capabilities.session.mcp`, drop the non-standard `acp` marker or move to `_meta`). The
client-fs/terminal removal is a **complete non-event**: zero code paths reference
`clientCapabilities.fs`/`.terminal` or call any `fs/*`/`terminal/*` method today, so there is
nothing to migrate, no MCP-based replacement to design, and `ACP-CLIENTCAP-202` is trivially
satisfied by omission.

# TCK-U2: omitted `params` on v2 `session/list` gets -32602. Is that allowed, where does it come from, and where should the fix go?

**Sources checked:**
- agent-client-protocol (spec) @ `5b45096` (2026-09-24, `main`, pulled). Latest schema tags: `schema-v2.0.0-alpha.5`, `schema-v1.23.0`.
- acp-typescript-sdk @ `69fda37` (2026-09-23, `main` = `origin/main`, pulled). Latest tag is `v1.5.0` (`f1ba3a9`). codex-acp has `@agentclientprotocol/sdk` 1.5.0 installed (`node_modules/@agentclientprotocol/sdk/package.json:3`).
- JSON-RPC 2.0 specification, https://www.jsonrpc.org/specification (§4, §4.2).
- acp-tck @ `5418887` (2026-09-23).
- Supporting only: acp-rust-sdk @ `28688b2` (2026-09-21).
- Live probe of `dist/index.js` (built 2026-09-24 12:34) over stdio, with v1 and v2 initialize.

**Confidence:** high. The failing code path was read in both the SDK source and the installed dist, and a live probe reproduced it on v1 and on v2.

## Answer

1. **An omitted `params` is valid.** JSON-RPC 2.0 says `params` "MAY be omitted". The ACP v2 envelope schema has `params` as optional (`required: ["id","method"]`) and allows `null`. `ListSessionsRequest` has no required fields. The Rust schema model now explicitly decodes an absent or `null` payload for such requests to the default value. So a spec-conforming agent should treat an omitted `params` on `session/list` as `{}`. The same applies to every v2 request with no required fields: **`session/list` and `auth/logout`** in the stable v2 schema, plus the unstable `providers/list` and `nes/start`. codex-acp registers neither unstable method on v2.
2. **The rejection happens in the SDK, not in our code.** The v2 `AgentApp` registers the built-in `session/list` spec with the generated `zListSessionsRequest = z.object({...})`. The JSON-RPC layer calls `parse(message.params)` with `undefined`, zod throws, and `errorToResult` turns the ZodError into `-32602 Invalid params` with `data: error.format()` (the `_errors` payload). `AcpAgentRouter.ts` provides no parser for built-in methods. On v2 it *cannot*: the SDK throws `TypeError` if you pass a parser for a built-in v2 method name.
3. **v1 has the same bug. It passes only because the v1 TCK never sends an omitted `params`.** v1 uses an identical `parseParams`/`z.object` path. The live probe shows v1 `session/list`, `logout` and `providers/list` without `params` all return the same -32602. The v1 TCK always sends `session/list` with `{}`. The only request the v2 TCK sends without `params` is in `test_batch.py`, and that test is also the evidence for JSONRPC-001, BATCH-204 and BATCH-205.
4. **Where to fix it.** There is no fix in SDK `origin/main`, and no related open issue or PR. Locally, the smallest v2-only change that leaves v1 alone is to wrap the v2 connector passed to `withV2(...)` with a stream transform. The transform adds `params: {}` to incoming requests for `session/list` and `auth/logout` when `params` is missing (optionally also when it is `null`), including entries inside batch arrays. A registration-layer fix like the existing `emptyExtensionParamsParser` is **not possible** for built-in v2 methods. I recommend the local workaround now plus an upstream SDK issue, because the SDK disagrees with the Rust model and the envelope schema.

## Requirements

| # | Requirement | Tier | Citation |
|---|-------------|------|----------|
| R1 | A request's `params` member "MAY be omitted" | JSON-RPC 2.0 (MAY for the sender, so the receiver must accept it at the envelope level) | jsonrpc.org/specification §4 |
| R2 | If `params` is present it "MUST be provided as a Structured value" (Array or Object). `null` is not a structured value in JSON-RPC 2.0 | JSON-RPC 2.0 MUST (sender) | jsonrpc.org/specification §4.2 |
| R3 | ACP follows JSON-RPC 2.0. The envelope fields `jsonrpc`, `id`, `method`, `params`, `result`, `error` follow JSON-RPC 2.0 | MUST (normative framing) | agent-client-protocol `docs/protocol/v2/draft/overview.mdx:10`, `:199` |
| R4 | v2 `ClientRequest` envelope: `required: ["id","method"]`. `params` is `anyOf [<ClientRequestParams>, null]` | Schema (normative wire shape) | agent-client-protocol `schema/v2/schema.json:5669-5800` (params at `:5685`, `null` branch at `:5793`, required at `:5798`) |
| R5 | `session/list`: "All parameters are optional. A request with an empty `params` object returns the first page of sessions." | MUST for the agent to answer (`:73`). Omission itself is not spelled out in the docs | agent-client-protocol `docs/protocol/v2/draft/session-list.mdx:61`, `:73` |
| R6 | `ListSessionsRequest` has no required fields (`cwd`, `cursor`, `_meta` are all nullable/optional) | Schema | agent-client-protocol `schema/v2/schema.json:6215` |
| R7 | `LogoutAuthRequest` (`auth/logout`) has no required fields | Schema | agent-client-protocol `schema/v2/schema.json:5997`; Rust model `agent-client-protocol-schema/src/v2/agent.rs:367-394` |
| R8 | Defaultable request payloads (v2 `ListSessionsRequest`, `LogoutAuthRequest`; unstable `ListProvidersRequest`, `StartNesRequest`) deserialize `null` to `Default`. At the envelope level, an absent `params` or `params: null` decodes to `None` | Rust model representation (added 2026-09-18, #2178, `fix(rust)`). This is not a JSON-schema change | agent-client-protocol `agent-client-protocol-schema/src/serde_util.rs:41-89` (macro), `:148`, `:152` (v2 inventory), `:174-188` (null and `{}` both give default), `:377-388` (omitted params equals null equals None); `agent-client-protocol-schema/src/rpc.rs:55-56` |
| R9 | Batch: the receiver SHOULD reply with an array of Response objects. A Response SHOULD exist for each Request. The sender SHOULD match by `id` | SHOULD | agent-client-protocol `docs/protocol/v2/draft/transports.mdx:45-72` |

Tier note: no ACP document says "an agent MUST accept an omitted `params` for all-optional methods." The obligation comes from JSON-RPC 2.0 §4 (omission is a legal request shape), the envelope schema (R4), and the method schema having no required fields (R6/R7). Together these mean an omitted `params` is a valid `session/list` request, so the `-32602` is non-conforming. The Rust model (R8) confirms that the maintainers treat absent, `null` and `{}` as equivalent for these payloads.

## Details

### Which v2 methods are affected

These are the v2 request types with an empty `required` list, taken from `ClientRequest.params` in the schema:

| Schema | Method | Required fields | Registered in `src/AcpAgentRouter.ts` (v2)? |
|---|---|---|---|
| `schema/v2/schema.json` | `session/list` | none | yes, `:99` |
| `schema/v2/schema.json` | `auth/logout` | none | yes, `:107` |
| `schema/v2/schema.unstable.json` | `providers/list` | none | no (v1 only, `:82`) |
| `schema/v2/schema.unstable.json` | `nes/start` | none | no |
| (both) | `ExtRequest` | n/a | our custom methods are v1-only |

Every other v2 method we register has required fields, so an omitted `params` there is correctly `-32602`:
- `initialize`: `protocolVersion`, `info`
- `auth/login`: `methodId`
- `session/new`: `cwd`
- `session/delete`: `sessionId`
- `session/resume`: `sessionId`, `cwd`
- `session/close`: `sessionId`
- `session/set_config_option`: `sessionId`, `configId`
- `session/prompt`: `sessionId`, `prompt`

The fix should cover exactly **`session/list`** and **`auth/logout`**.

### Why the request is rejected (TS SDK @ `69fda37`; the same code ships in 1.5.0)

1. The transport builds the incoming request object with `params: message.params` unchanged, so `undefined` when absent (`src/jsonrpc.ts:1471-1474`).
2. The typed handler calls `parse(message.params)` (`src/jsonrpc.ts:1614`; installed dist `dist/jsonrpc.js:933`).
3. The v2 `registerAppRequest` supplies `(params) => parseParams(spec.params, params)` (`src/v2/acp.ts:2210-2212`). `parseParams` calls `parser.parse(params)` with no defaulting (`src/v2/acp.ts:2148-2160`).
4. The `listSessions` spec uses `validate.zListSessionsRequest` (`src/v2/acp.ts:2329-2336`), which is a plain `z.object({...})` (`src/v2/schema/zod.gen.ts:3726-3733`). `zLogoutAuthRequest` has the same shape (`src/v2/schema/zod.gen.ts:3597-3602`). A zod object rejects `undefined` and `null` ("expected object, received undefined").
5. `errorToResult` maps any ZodError to `RequestError.invalidParams(error.format())` (`src/jsonrpc.ts:595-614`). That produces `{"code":-32602,"message":"Invalid params","data":{"_errors":[...]}}`, which matches the TCK transcript exactly.
6. The protocol router does not touch post-initialize messages ("every later wire item is forwarded unchanged", `src/protocol-router.ts:40-50`).

v1 follows the same path: `parseParams` at `src/acp.ts:1075-1088`, `registerAppRequest` at `:1127-1129`, `listSessions` spec at `:1192-1195`, and `zListSessionsRequest = z.object` at `src/schema/zod.gen.ts:3505-3512`.

### Why the registration layer cannot fix it on v2

`AgentApp.onRequest(method, parser, handler)` calls `assertUnrecognizedV2Method(method, "request")` whenever a parser is passed (`src/v2/acp.ts:3072-3078`). That function throws `TypeError("Cannot replace the built-in ACP v2 request parser for 'session/list'")` for any method in `knownProtocolMethods` (`src/v2/acp.ts:339-343`, `:365-374`). The two-argument form always uses the built-in spec (`:3081-3099`). There is also no public middleware hook on `AgentApp`, because the builder is private (`:2968`). The `emptyExtensionParamsParser` preprocess pattern (`src/AcpAgentRouter.ts:13-16`) therefore only works for extension methods.

### Live probe (codex-acp `dist/index.js`, 2026-09-24)

| Request | v1 | v2 |
|---|---|---|
| `session/list`, no `params` | -32602 "expected object, received undefined" | same |
| `session/list`, `"params": null` | -32602 "received null" | same |
| `session/list`, `"params": {}` | result `{sessions:[...]}` | result |
| `logout` (v1) / `auth/logout` (v2), no `params` | -32602 | -32602 |
| `providers/list` (v1), no `params` | -32602 | n/a |

### Why v1 "passes"

The v1 TCK has no batch tests, and its `session/list` probes always send `{}` (acp-tck `src/tck/v1/conformance/test_session_capabilities.py:188`, `:211`). Its JSONRPC-001 test only uses `initialize` and `session/new`. On v2, JSONRPC-001 is also marked on `test_batch_of_requests_replies_with_matching_responses` (acp-tck `src/tck/v2/conformance/test_batch.py:150`), which sends two `session/list` requests without `params` (`:170-178`) and requires `"result"` in each (`:187-194`). The harness leaves out `params` when it is `None` (acp-tck `src/tck/common/harness/process.py:204-206`). The batch framing and id echo were already correct. Only the per-entry result fails.

The `test_invalid_batch_entries_get_per_entry_invalid_request` follow-up (`test_batch.py:141`) also sends `session/list` without `params`, but it accepts either `result` or `error`, so it passes today.

### Recommended local fix (v2 only, v1 unchanged)

Add the fix in `src/AcpAgentRouter.ts` at `withV2(...)`. `withV2` takes any `AgentConnector`, meaning anything with `connect(stream, options?)` (acp-typescript-sdk `src/connection.ts:20-25`). The router calls `agent.connect(routedStream, {deferConnectHandlers: true})` and attaches the returned lifecycle (`src/protocol-router.ts:246-251`). Wrap `v2Agent` like this:

- `connect(stream, options)` returns `v2Agent.connect({readable: stream.readable.pipeThrough(normalizer), writable: stream.writable}, options)`. The returned `AgentConnection` (with `closed` and `startConnectHandlers`) is passed back unchanged.
- The normalizer is a `TransformStream` over wire items. A wire item is either one message or an array (batch). For each element that is a request (has `id` and `method`) whose `method` is `session/list` or `auth/logout`, and whose `params` is `undefined`, it produces `{...msg, params: {}}`. Everything else passes through untouched, including the initialize item the router prepends and malformed batch entries, so the SDK still produces its own -32600 for those.
- Optional: also map `params: null` to `{}` for those two methods. The Rust model accepts null (R8) and the envelope schema allows it (R4), but JSON-RPC 2.0 §4.2 forbids it (R2). This is a leniency choice, not a requirement. The TCK does not probe `null`.
- Keep the method list explicit rather than derived from the schema. It must stay in sync with R6/R7, and adding a method later means checking that the v2 schema has no required fields for it.

Other places the fix could go, and why they are worse:
- Normalizing in `createJsonStream` or `index.ts` would also change v1 behaviour. That is arguably correct (v1 has the same defect), but it is out of scope for "keep v1 unchanged".
- Patching the SDK (`patch-package`) is fragile against the `~1.5.0` range.

**Upstream:** worth filing against acp-typescript-sdk. Either `parseParams` or the generator should treat `undefined` (and `null`, for payloads the Rust model marks default-on-null) as `{}` for request types with no required fields. Both v1 and v2 need this. Nothing in `origin/main` (`69fda37`, only a transport size-limit change since 1.5.0) addresses it, and `gh` searches found no matching issue or PR. The local wrapper is appropriate until then and can be removed once the SDK fixes it.

## Testability notes

- **Unit (Vitest, event-driven):** connect the router, or just the wrapped v2 connector, to an in-memory stream pair. Send a v2 `initialize`, then:
  - `{"jsonrpc":"2.0","id":1,"method":"session/list"}` must get `result.sessions` (array), not `error.code === -32602`.
  - The same for `auth/logout`, with a stubbed agent that has auth methods.
  - A batch `[{id:"a",method:"session/list"},{id:"b",method:"session/list"}]` must get one array reply containing results for ids `a` and `b`.
  - Snapshot with `toMatchFileSnapshot()`, using the placeholder convention for session payloads.
- **Negative controls:**
  - v2 `session/new` with no `params` must still be -32602. This proves the list is not over-broad.
  - v1 `session/list` with no `params` should still be -32602 until someone decides to fix v1. Pinning this documents the "v1 unchanged" choice.
- **TCK:** `-k test_batch --protocol-version 2` covers JSONRPC-001 (batch half), BATCH-204 and BATCH-205. The full v1 suite should be unchanged.
- **Unobservable:** whether the agent treats an omitted `params` "as" `{}` internally. Only the response is observable, and "first page of sessions" is the same output either way.

## Discrepancies

1. **TS SDK vs. the spec and Rust model.** The envelope schema allows an absent or `null` `params` (R4), the method schema has no required fields (R6/R7), and the Rust model decodes absent or `null` to default (R8). The TS SDK (v1 and v2, 1.5.0 through `origin/main`) rejects both with -32602. The Rust SDK passes an absent `params` as `Value::Null` to the payload deserializer (acp-rust-sdk `src/agent-client-protocol/src/jsonrpc.rs:422-424`), which works with R8. I did not run it end to end, so treat that as supporting evidence rather than verified behaviour.
2. **JSON-RPC 2.0 vs. the ACP envelope schema on `params: null`.** JSON-RPC 2.0 §4.2 requires a structured value when `params` is present, so `null` is invalid. The ACP schema and Rust model accept `null` (R4, R8). This affects only the optional `null` normalization, not the TCK failure.
3. **Documentation gap.** `session-list.mdx:61` and `authentication.mdx:225-231` only show `params: {}`. No ACP doc says what an omitted `params` means. The wire schema and Rust model settle it; the prose does not.

## Open questions

- **v1 has the same defect.** v1 `session/list`, `logout` and `providers/list` without `params` return -32602 (live probe). Should codex-acp fix v1 too, which is trivial if the wrapper is applied to both connectors, or leave it for the upstream SDK fix? This is a product decision for the orchestrator.
- **Should `params: null` be normalized** (Discrepancy 2)? It is a policy choice.
- **Upstream SDK issue.** Someone with GitHub access should file it against agentclientprotocol/typescript-sdk (parse `undefined`/`null` as `{}` for defaultable request payloads, matching spec PR #2178).

# ACP SDK 2.2 compatibility review

## Scope and baseline

This reviews `codex-acp`'s upgrade from `@agentclientprotocol/sdk ~2.1.0` to
`~2.2.0`. It does not change the SDK or specification repositories.

- Adapter baseline: `597a037`, the previous SDK/schema integration.
- SDK baseline: `v2.1.0`, using schema `v1.27.0` and `v2.0.0-alpha.10`.
- SDK target: `e23cc6406014ddc7747b9688d888b6c602402e4f` (`2.2.0`), using
  schema `v1.28.0` and `v2.0.0-alpha.11`.
- Specification reviewed through
  `d5e9949c3e6a9cd072adebaa44e6f63289590c17`, including documentation
  clarifications after the schema release.
- SSH pulls failed. HTTPS `git ls-remote` confirmed that both reference
  worktrees matched their upstream HEADs at review time.

The comparison includes all four stable/unstable JSON schemas, schema
descriptions, stable and draft protocol pages, and the v2 migration guide.
Structural schema changes were compared separately from descriptions.
The final plain-language pass was separated from the earlier behavioral
clarifications. RFD proposals are not treated as implemented protocol requirements.

Upstream comparisons:

- [Specification changes since the previous schema](https://github.com/agentclientprotocol/agent-client-protocol/compare/schema-v1.27.0...d5e9949c3e6a9cd072adebaa44e6f63289590c17)
- [SDK changes since 2.1.0](https://github.com/agentclientprotocol/typescript-sdk/compare/v2.1.0...e23cc6406014ddc7747b9688d888b6c602402e4f)

## Implemented in this change

1. **Upgrade the SDK and lockfile.** Adopt the released schemas and runtime
   fixes. Keep the adapter's package version release-managed.
2. **Remove JSON-RPC batching.** Replace removed wire types with `Stream` and
   `AnyMessage`. Release setup publication after each response write. Replace
   batch tests with concurrent individual requests and verify that unrelated
   pending requests do not hold up publication. Test rejection of arrays on
   both protocol versions without losing the connection.
   Owners: [response delivery](../src/AcpResponseDelivery.ts#L1) and
   [router](../src/AcpAgentRouter.ts#L70).
3. **Support repeated initialization.** Handshake with Codex only once.
   Commit the adapter's capability state only after initialization succeeds,
   so a failed repeat retains the previous state.
   Owners: [Codex initialization](../src/CodexAcpClient.ts#L204) and
   [ACP initialization](../src/CodexAcpServer.ts#L773).
4. **Validate workspace paths on the protocol boundary.** Reject relative
   `cwd` on new/load/resume/fork/list and relative `additionalDirectories`
   on setup, with `-32602`, before dispatching the operation. Accept native
   POSIX and fully qualified Windows syntax. Do not interpret unrelated
   unknown request fields as workspace settings. Use the same absolute-path
   rule for additional-root normalization.
   Owners: [path syntax](../src/PathUtils.ts#L4) and
   [router validation](../src/AcpAgentRouter.ts#L95).
5. **Reject duplicate MCP server names.** Validate before configured-server
   filtering. Also reject distinct names that collide after the adapter's
   existing whitespace sanitization instead of silently overwriting one.
   Keep last-entry-wins behavior for repeated stdio environment variables,
   which the protocol explicitly permits.
   Owner: [MCP normalization](../src/McpServerConfig.ts#L38).
6. **Match config value types to advertised options.** A v2 `"id"` value
   must not toggle a boolean option just because the shared v1 handler
   understands `"on"`. Reject unknown/unadvertised IDs and mismatched
   types before changing configuration.
   Owner: [v2 config requests](../src/CodexAcpServer.ts#L2699).
7. **Use native absolute paths in v2 Git patches.** Match `changes` in
   every header, including rename lines, with no `a/` or `b/` prefixes.
   Preserve Windows separators and Git quoting. Keep the existing v1/AIR
   relative-path format.
   Owners: [patch builders](../src/GitPatch.ts#L18) and
   [v2 file changes](../src/tool-calls/reporters/FileChangeReporter.ts#L149).
8. **Consume the widened v2 elicitation content.** Preserve arbitrary JSON
   values when forwarding accepted MCP forms instead of rejecting the whole
   response through the v1 guard. For built-in text questions, ignore an
   invalid property's value without discarding valid neighboring answers or
   stringifying objects into answers. Preserve v1's narrower wire contract.
   Owners: [version bridge](../src/AcpV2Elicitation.ts#L4) and
   [elicitation consumers](../src/CodexElicitationHandler.ts#L90).

## SDK-owned changes and existing adapter behavior

These do not require another implementation in the adapter. Existing test
coverage is evidence for the named flows, not a claim of complete protocol
conformance.

| Area | Disposition |
| --- | --- |
| Null error-response IDs and typed `-32002` / `-32022` data | SDK 2.2 owns envelope validation and version negotiation. The adapter already reports `data.sessionId` for unknown sessions. Existing unknown-session tests exercise both versions. |
| Requests/notifications before initialization, failed initialization retry, late initialize rejection, unknown methods | SDK router/runtime owns admission and method dispatch. The adapter uses that router rather than implementing another JSON-RPC state machine. Repeated Codex handshakes needed the additional adapter fix above. |
| Independent request IDs in each direction, unknown/already-answered cancels, unanswered requests on disconnect | SDK runtime owns these rules and has regression tests. No adapter request-ID allocator is added. |
| Nonempty v2 prompt arrays | The new SDK request schema rejects empty arrays. The adapter's existing content check rejects unsupported/custom content before insertion. Baseline text/resource links and advertised image/embedded resources remain supported. |
| Required elicitation `requestedSchema.type` and `properties` | SDK schema now requires both. The adapter's normal forms already supply them. General validation of arbitrary MCP schemas is a separate concern, not a reason to synthesize a permissive schema for malformed input. |
| Nonempty select options and groups | SDK schema encodes the lower bounds. Existing model/effort builders omit unavailable selectors or include the selected model, and child selectors are singletons. SDK parsing does not itself prove uniqueness or current-value membership for every future builder. |
| `SessionInfo.additionalDirectories: null` input | SDK deserialization defaults it to `[]`. Senders still omit it or send an array, not `null`. |
| `annotations.lastModified` and cost currency | SDK accepts an arbitrary string timestamp and units such as `credits`. The adapter does not introduce an ISO-only validator or manufacture cost data. |
| Usage cost patches and end-turn usage | Omitted/null/value cost semantics belong to clients maintaining usage state. The adapter's existing end-turn usage reports completed-work deltas rather than lifetime totals. |
| Held prompts, insertion responses, request cancellation | Existing v2 FIFO reservations, queued cancellers, and insertion IDs cover these flows. `cancel-v2` and `prompt-v2` tests distinguish held, started-but-not-inserted, and inserted requests. See follow-up A for cancellation crossing a new prompt and active-session resume. |
| Replay primers and entity IDs | Existing replay starts chunked messages with empty whole-message updates. Retained user messages use their insertion IDs. Tools, terminals, plans and compactions use their normal delivery paths. Historical notices are excluded. See follow-up B for full resynchronization. |
| Setup config options and commands | Existing v2 setup responses include complete current lists and omit empty lists rather than sending `null`. SDK `ActiveSession` tracks config notifications and responses in receive order. |
| Config changes and plan approval | Existing responses contain the whole list. Automatic plan-to-implementation switching follows the existing permission flow. Broadcasting every config change is still follow-up B. |
| Permission dismissal, unknown outcomes and option IDs | Existing permission conversion treats unrecognized/absent approval as denial. Existing tests cover rejected and cancelled requests and terminal statuses. `cancelled` is not automatically a session-completion signal. |
| Close/delete client normalization | SDK 2.2 treats `-32002` from either method as success. Adapter deletion already closes a locally active session before archiving. Agent-side teardown still needs follow-up A. |
| Stdio shutdown | Existing entry point observes stdin closure and shuts down the Codex supervisor without restarting it. No HTTP/WebSocket transport is added to the adapter. |
| Auth advertisement and method errors | Existing v2 descriptors gate terminal flows on client support. Login/logout are registered; unknown or unadvertised login methods get `-32602`, and failed login gets `-32000`. Request cancellation needs follow-up D. |
| MCP transport negotiation | Existing normalization rejects SSE, ACP, and unknown transports with `-32602` before conflict filtering. The adapter advertises stdio and HTTP only. |
| Unknown fields and closed unions | SDK handles parsing. Known malformed variants must not become unknown variants. The adapter must still reject unsupported operations after parsing. Path-validation tests explicitly preserve unknown-field tolerance. |
| Client rendering rules | Plan replacement for unknown plan types, generic diff operations, invalid base64 snapshots, annotations/audience, icon fetch restrictions and terminal size hints primarily govern ACP UI clients. This agent does not implement an icon fetcher or terminal UI. Prompt/resource handling still needs the security review below. |
| Prose-only v1 changes | Do not import v2 lifecycle requirements into stable v1. Shared bug fixes above retain the separate protocol response shapes. |

## Proposed follow-ups for discussion

These are not completed by this dependency upgrade. A passing test suite does
not waive the requirements below. Recommend A and B as the next compatibility
PRs, followed by C/D/E as separately reviewable changes.

### A. Active-session lifecycle and teardown

Sources: [session lifecycle and close](https://github.com/agentclientprotocol/agent-client-protocol/blob/d5e9949c3e6a9cd072adebaa44e6f63289590c17/docs/protocol/v2/session-setup.mdx#L45)
and [cancellation](https://github.com/agentclientprotocol/agent-client-protocol/blob/d5e9949c3e6a9cd072adebaa44e6f63289590c17/docs/protocol/v2/prompt-lifecycle.mdx#L981).

- Resuming an already-active session must resynchronize without stopping its
  work. Verify Codex's loaded-thread resume behavior when roots or MCP config
  change. The adapter reinstalls session state, so this needs more than
  asserting that another resume RPC succeeds.
- Verify that omitted/empty roots and MCP servers replace the previous
  Client-provided set, including on an already-loaded Codex thread.
  Independently configured MCP servers must survive. Requests currently
  rebuild config, but runtime replacement is not established by that alone.
- `session/cancel` covers only prompts received before it. Add a race test
  that sends the next prompt while interrupt completion is pending.
- Closing must stop background processes, not merely forget them:
  [current close](../src/CodexAcpServer.ts#L1996) calls
  [task clear](../src/async-tasks/CodexBackgroundTerminalTasks.ts#L213),
  which clears bookkeeping without terminating processes.
- Cancel every session-scoped elicitation, including idle/background ones,
  before close responds. Current turn and async-question cancellation do not
  establish a session-wide guarantee. Reuse a request-lifetime owner rather
  than adding cancellation to each caller separately.
- Fence all subsequent session messages after close, finalize foreground
  tools before idle, and test delete through the same teardown path.
  Repeated/unknown closes should succeed even if Codex has no loaded thread.

### B. Resume snapshots, setup delivery and configuration publication

Sources: [setup and synchronization](https://github.com/agentclientprotocol/agent-client-protocol/blob/d5e9949c3e6a9cd072adebaa44e6f63289590c17/docs/protocol/v2/session-setup.mdx#L96)
and [configuration](https://github.com/agentclientprotocol/agent-client-protocol/blob/d5e9949c3e6a9cd072adebaa44e6f63289590c17/docs/protocol/v2/session-config-options.mdx#L220).

- Send current `session_info_update` after replay and before every resume
  response, including no-replay resume. The adapter currently publishes
  replay titles, but does not perform this complete current-info step.
- Explicitly remove stale entity metadata during resynchronization. A
  replacement content snapshot does not clear `_meta`; `{}` is not a clear.
- Audit reconstructed tool/terminal/plan/compaction snapshots, their final
  statuses and metadata. Full replay is authoritative for all entities,
  not only messages. Do not replay historical state as current activity.
- Reestablish or safely resolve pending permission/elicitation waits after
  reconnect; current-state replay does not replay old interaction requests.
- Extend the existing response-delivery mechanism to defer session-scoped
  startup interactions until the `session/new` response has been written.
  Current MCP startup can request sign-in before that response.
  Use a write boundary for initial auth-status publication too, rather
  than assuming a scheduled callback runs after a backpressured initialize response.
- Publish complete `config_option_update` lists for accepted config changes
  as well as agent-originated changes, ordered before the requesting response
  where applicable. Keep response and notification ordering in one owner.
- Reconcile AIR's linked-worktree session-list extension with v2's exact
  directory filter. Standard requests must not match subdirectories or
  additional roots. Preserve empty-string cursors as opaque valid tokens.

### C. Subagent directory and message reporting

Sources: [draft subagent schema](https://github.com/agentclientprotocol/agent-client-protocol/blob/d5e9949c3e6a9cd072adebaa44e6f63289590c17/docs/protocol/v2/draft/schema.mdx)
and the [subagent RFD](https://github.com/agentclientprotocol/agent-client-protocol/blob/d5e9949c3e6a9cd072adebaa44e6f63289590c17/docs/rfds/subagents.mdx).

- The new optional `subagent_update.cwd` and `additionalDirectories` are
  available in the SDK but not populated by the adapter.
- Their absence inherits the immediate parent's effective value. Report
  verified child placement when different, including worktree children.
  `null` restores inheritance; `[]` reports explicitly no additional roots.
  Do not copy parent roots or infer them from an unverified provider ID.
- Extend the existing trusted child readback/announcement path for live and
  replay updates in both protocol versions. Do not create another roster.
- Session-directed message views and cross-view IDs are not new structural
  schema changes in this range. Their existing unimplemented portions remain
  separate work rather than being implicitly claimed by this upgrade.

### D. Authentication and MCP delegation

Sources: [authentication](https://github.com/agentclientprotocol/agent-client-protocol/blob/d5e9949c3e6a9cd072adebaa44e6f63289590c17/docs/protocol/v2/authentication.mdx#L176)
and [elicitation](https://github.com/agentclientprotocol/agent-client-protocol/blob/d5e9949c3e6a9cd072adebaa44e6f63289590c17/docs/protocol/v2/elicitation.mdx#L24).

- Router auth handlers pass the request ID but not `ctx.signal`. Propagate
  request cancellation through Codex login and request-scoped URL
  elicitations, dismissing them before the login response.
- Verify explicit ACP form/URL capability translation into Codex's MCP
  connections. ACP `{}` means no modes, unlike MCP's legacy form default.
  Codex owns those MCP connections, so changing only ACP-side gating does
  not prove the MCP advertisement is correct.
- Verify stdio server cwd, inherited environment, and transport-owned HTTP
  header precedence against real Codex. The adapter passes env/header config
  through; actual launch and transport behavior is delegated to Codex.
- Keep provider credentials out of ACP context and bind URL completion to
  the originating connection/flow. Multi-user ownership requires a separate
  deployment design if this local stdio agent is exposed remotely.

### E. Extension names, command lists and security

Sources: [extensibility](https://github.com/agentclientprotocol/agent-client-protocol/blob/d5e9949c3e6a9cd072adebaa44e6f63289590c17/docs/protocol/v2/extensibility.mdx#L91),
[commands](https://github.com/agentclientprotocol/agent-client-protocol/blob/d5e9949c3e6a9cd072adebaa44e6f63289590c17/docs/protocol/v2/slash-commands.mdx#L89),
and [security](https://github.com/agentclientprotocol/agent-client-protocol/blob/d5e9949c3e6a9cd072adebaa44e6f63289590c17/docs/protocol/v2/security.mdx#L29).

- Migrate legacy unprefixed metadata and private non-namespaced discriminators
  through a negotiated compatibility plan. Other unprefixed keys and ACP/MCP
  namespaces are reserved. Do not silently rename AIR contracts in the bump.
- Reject/filter whitespace-bearing command names and deduplicate built-ins
  versus skills and repeated skills. Ensure unadvertised names remain normal
  prompts and command parsing has an exact name boundary. The current parser
  examines `prompt[0]`, not the first text block anywhere in the prompt.
- Review resource URI reads, root containment/symlinks, MCP content forwarding,
  and credential-bearing metadata. UI icon and terminal sanitization rules
  should be documented for clients, not implemented as agent-side fetching.
- HTTP/WebSocket transport and background-work/session-archive RFD additions
  remain proposals or separate features. They do not authorize new transports,
  methods or feature advertisements in this adapter.

## Validation

- `npm run typecheck`: passed, including examples.
- `npm test`: passed. 2,263 tests passed, 39 skipped. 146 files passed,
  7 skipped. This command excludes the integration suite.
- `npm run build`: passed.
- `git diff --check`: passed.
- `npm ls @agentclientprotocol/sdk`: resolved `2.2.0`.
- The separate integration suite and opt-in E2E suite were not run.

The real Codex smoke command was also run successfully after the implementation changes:

```sh
npm run codex-test -- -p "Reply with exactly OK. Do not use tools or modify any files." -o summary
```

It completed with `end_turn`. It exercises the real Codex adapter, not full
dual-version wire/lifecycle conformance. The wire regression tests exercise
both ACP versions where behavior is shared. Live integration/E2E coverage
for the proposed follow-ups is still required before claiming those items done.

# ACP SDK upgrade review

## Revisions and scope

- Adapter baseline: `e059ab7`, using SDK `2.2.0`. The last SDK/schema upgrade
  was `6f96fbe` (#710), based on `schema-v1.28.0` and
  `schema-v2.0.0-alpha.11` (ACP commit `ac765763`).
- Specification reviewed: `0fc18323`, tagged `schema-v1.29.1` and
  `schema-v2.0.0-alpha.13`.
- SDK target: `2.4.0` (`8d95327`). This includes the schema update released
  in `2.3.0` and the `stopWaitingOnCancel` fix from #332, released by #333.
- Compared all four JSON schemas and method metadata files, the stable and
  draft v1/v2 protocol pages (including generated schema descriptions), and
  the changed RFDs. JSON-schema shape comparison ignored descriptions, but
  descriptions and protocol prose were reviewed separately.

Upstream diffs:

- [ACP schema and docs](https://github.com/agentclientprotocol/agent-client-protocol/compare/schema-v1.28.0...0fc18323)
- [TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk/compare/v2.2.0...v2.4.0)

This is an upgrade review, not a claim of complete v2 conformance. Optional SDK
types do not advertise adapter support. Proposed deferrals below still need
review before deciding the follow-up scope. Existing AIR API contracts are
preserved.

## Changes in this worktree

### 1. Update the SDK dependency

Use `~2.4.0` in the manifest and lockfile. No generated Codex app-server types
need changing. The ACP SDK supplies the updated schemas and runtime bindings.

The stable v1 schema has no structural changes in this range. Its changed
descriptions do not introduce new adapter behavior. Unstable v1 adds the
optional methods listed below. Stable v2 adds background-work and per-entity
cancellation types. Unstable v2 adds those and the new optional methods.
No definitions were removed from any of the four schemas.

### 2. Stop waiting for cancelled interactions

Sources: `docs/protocol/v2/cancellation.mdx`, `prompt-lifecycle.mdx`,
`session-setup.mdx`, and `tool-calls.mdx`, plus their draft copies.

- On foreground cancellation, the Agent must stop waiting for that work's
  permission requests and treat them as not approved. It should send an
  individual `$/cancel_request` for each.
- Closing must withdraw every session-scoped permission request and
  elicitation before the close response, including idle/background requests.
- A late response must not restart cancelled work.
- This replaces the former v2 instruction that Clients automatically answer
  every pending session permission on `session/cancel`. v1's Client-side rule
  has not changed.

The adapter already scopes foreground abort signals and withdraws interactions
on close. Use SDK `stopWaitingOnCancel: true` for permissions in
`AcpClientDelivery` and the v2 permission send path, instead of adding
a separate Promise race. Do not apply this to incoming `session/prompt`:
an inserted v2 prompt must still return its `messageId`.
Keep late-answer handling for async elicitations: the adapter warns when an
answer cannot be delivered to its original turn. Stopping those waits would
silently remove that documented behavior.

Regression coverage now withholds Client responses through cancellation and
close/delete, and delivers late approvals only after local work has ended.
Existing prompt-insertion, queued-prompt and interrupt-race coverage remains.

### 3. Support standard client-set titles on both versions

Sources: `SetSessionTitleRequest`/`SetSessionTitleResponse` and
`SessionCapabilities.title` in both unstable schemas,
`docs/rfds/session-set-title.mdx`, and draft initialization pages.

Advertise the title capability and register `session/set_title` on both
routers. Reuse `SessionIndexTitles` and its existing write queue, normalization,
error mapping, loaded-session updates, and automatic-title suppression. Return
the persisted normalized title. Keep AIR `_session/rename` and its capability
gate and empty response unchanged.

Coverage includes non-AIR clients, active/saved sessions, persistence ordering,
normalization, invalid input, unknown sessions, storage errors, list visibility,
and in-flight automatic-title races. See [the wire contract](session-title.md).

### 3a. Reject empty system-prompt content before lifecycle changes

Sources: both draft session-setup pages and
`docs/rfds/client-system-prompt.mdx`. This documentation-only change is not
encoded as a new schema constraint: Clients must not send an empty `content`
array, and Agents may reject it with `-32602`. The RFD explicitly excludes using
it to remove an existing prompt.

The adapter previously treated `content: []` as clearing the client addition.
Reject it in the shared system-prompt validator, before new/load/resume/fork
side effects, on both protocol versions. Preserve existing client and AIR
instructions after rejection. Extend the existing lifecycle validation tests
rather than add a second validation path. Omitted and `null` prompts retain
their existing behavior.

## Proposed follow-ups

### 4. Standard archive/unarchive and list filtering

Sources: `ArchiveSessionRequest`, `UnarchiveSessionRequest`,
`SessionArchiveFilter`, `SessionInfo.archived`, `SessionCapabilities.archive`,
draft session-list pages, and `docs/rfds/session-archive.mdx`.

**Recommendation: a separate, focused compatibility PR.** AIR already has
archive/unarchive and archive-aware pagination, but registering two method
aliases would advertise an incomplete standard contract:

- Advertise `archive` only with both methods and the complete list contract.
- Map `exclude`/`include`/`only` to the existing archive-aware reader. Omitted
  and `null` mean `exclude`. Reject unsupported filter values with `-32602`.
- Filter by archive state and `cwd` before pagination, bind the cursor to both,
  and include a boolean `archived` on every returned row.
- Reuse the existing close fence, write queue and idempotent mutations.
  Archiving stops open work. Unarchiving must not load/resume the session.
- Test persistence across restarts, unknown sessions, already-archived and
  already-unarchived sessions, delete exclusion, and interleaved title writes.
- Preserve AIR's existing `_meta` filter names and list behavior. Decide how
  standard and AIR filters interact before exposing both on the same request.

Until then, do not advertise standard `archive` or serve its methods. Existing
AIR support is unchanged.

### 5. Standard authentication status

Sources: `AuthState`, `AuthAccount`, `AuthStatusResponse`,
`AuthStatusUpdateNotification`, `AgentAuthCapabilities.status`,
`docs/rfds/get-auth-state.mdx`, and draft authentication/initialization pages.

**Recommendation: a separate migration PR.** Reuse the existing auth owner,
account reads, provider configuration, change detection and post-initialize
publication boundary. Do not infer the actionable `state` from the legacy
display-only `kind`:

- `none` does not distinguish "login required" from "authentication not needed".
- A gateway display label does not prove credentials exist or are valid.
- Client-configured providers and the agent-owned login are distinct today.
- Distinguish `authenticated`, `unauthenticated`, `not_required` and `unknown`
  using the same requirement/configuration evidence as session authorization.
- Return `unknown`, not `auth_required`, if status cannot be determined.
  `auth/status` itself must remain callable while logged out.
- Return and notify full account snapshots. Never include credentials.
- Decide the transition period for `_auth/status_update` and its advertised
  legacy metadata before removing it. Do not break existing Clients.
- Test all state values, provider switches, external account updates, failed
  reads, initial-response ordering and duplicate suppression on v1 and v2.

The standard capability remains absent, and its method returns `-32601`.
Legacy auth status continues unchanged.

### 6. Side-effect-free session status

Sources: `SessionStatusRequest`/`Response`, `SessionStatus`,
`SessionCapabilities.status`, and `docs/rfds/session-status.mdx`.

**Recommendation: a small follow-up after agreeing its recovery semantics.**
Reuse lifecycle ownership rather than add a second session registry.

- Distinguish `open` (in memory) from `saved` (known but not in memory).
  Neither attaches the requesting connection.
- Avoid load/resume/create/close side effects.
- On v2, return the same foreground snapshot as resume, not a boolean
  approximation that loses `requires_action` or an unknown recovery state.
- Cover exposed children, a dead/restarting app-server, concurrent close,
  archive and deleted/unknown IDs (`-32002` with `data.sessionId`).
- The RFD permits returning `saved` without a storage lookup when that lookup
  is expensive, but this is a deliberate policy choice, not proof of existence.

The capability remains absent, and its method returns `-32601`.

### 7. Background-work snapshots

Sources: stable and unstable v2 `BackgroundWork`, the state-update definitions,
`docs/protocol/v2/prompt-lifecycle.mdx`, `session-setup.mdx`, `tool-calls.mdx`,
their draft copies, and `docs/rfds/v2/background-work.mdx`.

**Recommendation: a dedicated lifecycle PR, the highest-priority feature
follow-up.** Despite the upstream commit's `unstable-v2` label, terminal and
tool-call background reporting is in the stable v2 schema. Child-session
background entries and `unknown` state are in unstable v2.

- Add reporting to the existing foreground-state owner, backed by the actual
  background terminal/task and subagent owners. Do not make an independent
  guessed list in the router.
- Once enabled for a session, include the list on every state snapshot,
  including repeated states, user-action transitions and resume snapshots.
- Omitted/`null` means unknown. `[]` asserts no background work. Never emit
  `[]` simply because the adapter has not enumerated the work.
- Announce entities before listing them. Finalize before removal. Do not list
  both a process terminal and its owning tool call for the same work.
- Publish list changes without inventing foreground completions. Coordinate
  background removal with any new foreground continuation.
- Resume without history must still supply current updates for listed entities.
- Forked history is not live work. The draft setup page says fork snapshots
  report `background: []`. This is stronger than the general optional-reporting
  rule and needs explicit treatment when adding background reporting. This
  upgrade does not claim to satisfy that fork-specific wording.
- Listed work and its permissions survive `session/cancel` and unrelated
  foreground failures. Close stops everything. Keep that distinction through
  recovery and subagent cancellation.

For this upgrade, leave `background` unreported on every state update. This is
allowed and avoids misleading Clients into treating live work as abandoned.
No v1 background contract is changed.

### 8. Tool-call/terminal cancellation and paused status

Sources: stable v2 `ToolCallStatus`, `ToolCallCapabilities`,
`TerminalCapabilities`, `CancelToolCallRequest`, `CancelTerminalRequest`, and
`docs/protocol/v2/tool-calls.mdx` (also draft).

**Recommendation: implement alongside or immediately after background
snapshots.** Reuse the existing targeted task-stop and terminal owners where
the Codex runtime really supports stopping that individual entity.

- `paused` is live, not final. Statuses do not go back to `pending`.
- Advertise per-entity `capabilities.cancel` only when supported. It is a
  nullable replacement patch, not a key-level metadata merge.
- Accept cancellation with an empty response, then confirm the eventual final
  tool status or terminal exit. Acceptance is not completion.
- Reject unknown/final/non-cancellable entities with `-32602` once the method
  is implemented. Do not cancel an entire foreground turn as a substitute.
- Clear controls when work finishes. Stopping a terminal keeps its transcript
  and does not by itself finish its tool call or change foreground state.
- Test ownership/session isolation, completion races, replay/resume controls,
  and late updates.

No controls are advertised in this upgrade. The SDK's default entity-cancel
handlers return `-32602` for unknown/non-cancellable entities without adapter
handlers. This is different from the capability-gated optional methods above,
which return `-32601`. The adapter does not synthesize `paused` without runtime evidence.

### 9. Proxy methods

Sources: both unstable schemas and metadata (`proxy/initialize`,
`proxy/successor`) and `docs/rfds/proxy-chains.mdx`.

**Recommendation: no implementation in this adapter.** These are a proxy and
conductor role, not new initialization requirements for a leaf Agent. The SDK
exposes the bindings independently. Keep the adapter usable behind an external
proxy; do not make it a conductor or advertise proxy support.

## Documentation clarifications with no new implementation in this range

The large prose pass is mostly sentence/heading cleanup. The following groups
were reviewed separately so that wording churn did not hide behavior changes:

| Area | Finding and disposition |
| --- | --- |
| Initialization and auth methods | Naming a group of methods explicitly does not change the non-empty `authMethods` requirement for v2 login/logout. Both handlers already exist. Repeated initialization and post-response notifications retain the existing boundaries. |
| Prompt insertion and local commands | `messageId`, logical insertion, rejection before insertion, retained replay IDs and local-command reporting are unchanged. Existing v2 prompt/cancellation tests cover these paths. |
| Session lifecycle, setup and replay | Existing resume state/metadata synchronization and response config/command lists remain required. The new background-entity synchronization is item 7, not a reason to replay historical state transitions. |
| Cancellation and close | The real permission-responsibility change is item 2. Foreground/background exclusion and close behavior for listed entities belong to item 7. The rewritten cancellation sentence still excludes prompts received after cancel. |
| Content, annotations and elicitation | Changes in this range are prose cleanup. Existing capability gates, arbitrary accepted JSON content, unknown-action denial and selective elicitation cancellation remain. No new content type or elicitation schema shape was added. |
| Config options | Unknown option handling, complete replacement lists, current-value semantics, unique values and required type discriminators are unchanged. No option conversion change is needed. |
| Plans and commands | Whole-plan replacement, stable plan IDs, tagged command/input variants and complete command-list replacement are unchanged. |
| Tool calls, terminals and diffs | Existing patch, terminal byte/snapshot and absolute-path rules remain. New controls and background semantics are items 7–8. |
| Session lists and delete | Opaque cursors, exact `cwd` matching and close-before-delete semantics are unchanged. Archive filtering is item 4. |
| MCP configuration | Full replacement of Client-provided servers/roots on resume, transport gates, unique names, env precedence and duplicate-env handling are unchanged. No new MCP transport was added here. |
| Extensibility and metadata | Unknown values, namespaced keys, nullable fields and key-level metadata patches retain their prior meaning. Keep the recent replay-clear and sibling-namespace fixes. Existing legacy namespace issues are not newly imposed by this release. |
| Security and transports | Rendering, URI/credential guidance, no batches, request IDs, transport ordering and error rules are unchanged. SDK runtime validation remains the wire parser. No remote server is added by this upgrade. |
| Client system prompt RFD | Moved to preview. Clients must not send empty `content`; Agents may reject it. No schema shape changed. Fix the old clear-via-empty behavior in item 3a while retaining append-only support. |
| Subagents, updates and remote transport RFDs | The changed RFD prose does not itself add schema requirements beyond background subagent entries above. Remote transport and proxy role work remain separate from this stdio leaf Agent. |

Existing follow-ups from #710 are not silently declared complete by this review.
In particular, authentication/MCP delegation and broader extension/security work
still need their own scope and review.

## Validation

- Installed the published npm SDK `2.4.0`, verified with `npm ls
  @agentclientprotocol/sdk`. No local SDK build was substituted.
- `npm run typecheck`: passed, including examples.
- `npm test`: passed. 2,418 tests passed and 39 were skipped.
- `npm run build`: passed.
- `git diff --check`: passed.
- Real Codex prompt smoke: `npm run codex-test -- -p "Reply with exactly OK.
  Do not use tools or modify any files." -o summary` completed with `end_turn`.
- Real wire smoke against the built executable: both ACP v1 and v2 advertised
  title support, renamed the saved session created by the prompt smoke, returned
  the normalized title, and reported that title through `session/list`.
- Regenerated 33 AIR scenario snapshots. A JSON comparison verified that their
  only change was `sessionCapabilities.title: {}` in initialization. The frozen
  pre-feature baselines were not regenerated.
- The separate integration suite, opt-in E2E suite, and cross-platform binary
  bundles were not run.
- `npm audit` reports four existing dependency issues (one moderate, three high).
  The lockfile changes only the ACP SDK; no unrelated audit fixes were applied.

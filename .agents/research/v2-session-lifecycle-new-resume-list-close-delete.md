# v2 topic: Session lifecycle — `new`/`resume`/`list`/`close`/`delete`/additional-directories

Builds on `.agents/research/v2-capability-negotiation-and-initialize.md` (dual-version mechanism:
`agentProtocolRouter().withV1(v1Agent).withV2(v2Agent)`, one version per connection, shared
`CodexAcpServer`/`CodexAcpClient` business logic behind two thin wire-shape chains). Spec checked
at `agent-client-protocol` local checkout, commit `8c90bb7`. TCK checked at
`/Users/eugene/Documents/JetBrains/projects/acp-tck/src/tck/v2/requirements.py`. SDK types checked
at `/Users/eugene/Documents/JetBrains/projects/acp-typescript-sdk/src/v2/schema/types.gen.ts`
(installed `@agentclientprotocol/sdk@1.4.0` ships the same shapes under `dist/v2/`).

## 1. Spec: exact v1 → v2 shapes

### `session/new` — mostly unchanged, one required→optional relaxation

v2 `NewSessionRequest` (`types.gen.ts:5208-5238`): `{ cwd: AbsolutePath; additionalDirectories?:
AbsolutePath[]; mcpServers?: McpServer[]; _meta? }`. v2 `NewSessionResponse` (`:2912-2931`): `{
sessionId: SessionId; configOptions?: SessionConfigOption[]; _meta? }` — no `models`/`modes` fields
at all (those move to `configOptions`, out of this topic's scope — see §6).

Key behavior change (`migration.mdx:598`, TCK `ACP-SESSION-203`): `mcpServers` was **required, even
if empty**, in v1's `session/new`; in v2 it's **optional**, and omitting it vs. sending `[]` are
explicitly equivalent. `ACP-SESSION-203` (capability-gated) asserts exactly this — `session/new`
must succeed whether `mcpServers` is omitted or `[]`.

### `session/resume` — absorbs `session/load`, gains `replayFrom`

This is the substantive change. v1 had two methods:
- `session/load` (gated by `agentCapabilities.loadSession: true`): reattach + full history replay.
- `session/resume` (gated by `sessionCapabilities.resume: {}`): reattach only, no replay.

v2 keeps **only** `session/resume`, with an optional `replayFrom` cursor
(`docs/protocol/v2/session-setup.mdx:81-233`, `migration.mdx:574-594`):

```json
{
  "method": "session/resume",
  "params": {
    "sessionId": "sess_789xyz",
    "cwd": "/home/user/project",
    "mcpServers": [...],
    "replayFrom": { "type": "start" }
  }
}
```

- `replayFrom` omitted or `null` → v1 `resume` behavior: **MUST NOT** emit history
  `session/update`s; just restore context, reconnect MCP, respond.
- `replayFrom: { "type": "start" }` → v1 `load` behavior: **MUST** replay the *entire* retained
  conversation as ordinary `session/update` notifications (same shapes as live traffic — `
  user_message`, `agent_message`, `agent_thought`, chunks) before responding to `session/resume`.
- `ReplayFrom` (`types.gen.ts:5533-5568`) is a **tagged union** left open for future point-cursor
  variants (`type: string` catch-all + `_meta`); `"start"` is the only defined variant today.
  Replay is defined as **inclusive** of the cursor position.
- v2 `ResumeSessionResponse` (`types.gen.ts:3219-3238`): `{ configOptions?: SessionConfigOption[];
  _meta? }` — no `models`/`modes`, same reduction as `NewSessionResponse`.
- New replay-specific rules not present in v1's history streaming at all: every replayed
  `user_message`/`agent_message`/`agent_thought` **MUST** carry a `messageId`
  (`docs/protocol/v2/session-setup.mdx:198-202`); a message replayed via chunks **MUST** first send
  a whole-message update with `content: []` before the chunks (`:208-212`); a user message that was
  originally inserted via `session/prompt` **MUST** replay (if it replays at all) with the exact
  `messageId` that prompt's response returned (`:199-201`, TCK `ACP-RESUME-204`). Absence of any
  given message from replay is explicitly conforming (agents aren't required to retain
  everything) — this is a deliberate escape hatch, not a bug surface.
- `session/resume`, unlike v1, is now **baseline-mandatory** the moment an agent advertises
  `capabilities.session` at all (no more separate `resume` marker) — `migration.mdx:604`.

### `session/list` — nearly identical to v1, additive fields only

v2 `ListSessionsRequest`/`ListSessionsResponse` (`types.gen.ts:5390-5410`, `:2920-2984`) match v1's
shape closely: `{ cwd?, cursor? }` in, `{ sessions: SessionInfo[], nextCursor? }` out, cursor-based
pagination (opaque token, `nextCursor` absent = last page). The only *new* field is
`SessionInfo.additionalDirectories?: AbsolutePath[]` (`:3128-3160`), gated on the agent advertising
`session.additionalDirectories` — report the complete ordered list, not a merge/diff. `session/list`
is explicitly **discovery-only**: it does not restore or mutate anything
(`session-list.mdx:199-206`). v2 additionally defines a `session_info_update` push notification
(title/`_meta` changes without polling) — informational for this topic, not in the requested TCK
id set, and it's a `session/update` variant so belongs with the tool-calls/messages topic's wire
format, not this topic's lifecycle-method scope.

### `session/close` — unchanged in shape and semantics

v2 `CloseSessionRequest`/`CloseSessionResponse` (`types.gen.ts:3164-3183` region /
`session-setup.mdx:235-270`): `{sessionId}` in, `{}` out. Same "cancel foreground work as if
`session/cancel`, then free resources" contract as v1. No shape delta at all — this is the
cheapest method in the topic.

### `session/delete` — unchanged in shape; still capability-gated, now under `session.delete`

v2 `DeleteSessionRequest`/`DeleteSessionResponse` (`types.gen.ts:3173-3178`, `:5416-5432`):
`{sessionId}` in, `{}` out — identical to v1. Same semantics: removes from future `session/list`
results; delete of an already-deleted/never-existed id SHOULD succeed silently; behavior of
`session/resume` on a deleted session and of deleting an *active* session are both
implementation-defined (`session-delete.mdx:88-94`).

### Additional directories — request/response shape now fully consistent across methods

`migration.mdx:596-600`: `session/new` and `session/resume` now take the *same* shape of
environment params (`cwd` required, `additionalDirectories`/`mcpServers` optional). Rule specific
to resume (TCK `ACP-ADDDIRS-202`, new in v2 — v1 had no resume/load analogue at all): clients must
resend the **full** intended additional-root list on every `session/resume`; omitting/`[]` means
*no* additional roots, never "keep whatever was there before" — no implicit restore.

## 2. TCK requirement texts (verbatim, `acp-tck/src/tck/v2/requirements.py`)

All rows below are `Tier.CAPABILITY`, `capability="capabilities.session"` unless noted — i.e. the
*whole* session-lifecycle surface is gated as a unit on advertising `capabilities.session`, only
`initialize` itself is unconditionally mandatory in v2.

- **`ACP-SESSION-001`** (:141): `session/new` with absolute `cwd`, no `mcpServers`, succeeds with a
  non-empty string `sessionId`; response validates against v2 schema.
- **`ACP-SESSION-002`** (:154): two `session/new` calls on one connection return distinct
  `sessionId`s.
- **`ACP-SESSION-203`** (:745): `session/new` accepted whether `mcpServers` is omitted or `[]` —
  the two are equivalent in v2, unlike v1 where the field was required-even-if-empty.
- **`ACP-RESUME-201`** (:758): `session/resume` (no `replayFrom`) succeeds with a schema-valid
  object result; `-32601` FAILs (baseline-mandatory), other errors from all three harness routes
  SKIP.
- **`ACP-RESUME-202`** (:773): with `replayFrom: {"type":"start"}`, every `session/update` for the
  resumed session arrives *before* the `session/resume` response, none after (quiet-period check).
  Zero replayed updates is conforming (retention escape hatch), recorded not FAILed.
- **`ACP-RESUME-203`** (:785): with `replayFrom` omitted/`null`, no history `session/update`
  arrives before the response. Vacuous-pass for an agent that retains no history.
- **`ACP-RESUME-204`** (:796): a retained user message inserted by `session/prompt`, if it replays
  at all, replays with the same `messageId` that prompt's response returned. SKIPs (not FAILs) if
  it's absent from replay.
- **`ACP-RESUME-205`** (:811): a `*_chunk` replay update for a `messageId` is preceded, in the same
  replay window, by the matching whole-message update with `content: []`. Vacuous for
  whole-message-only replay implementations.
- **`ACP-LIST-201`** (:823): `session/list` with `params: {}` succeeds; `sessions` is present as an
  array; response validates.
- **`ACP-LIST-202`** (:835): `session/list` filtered by a `cwd` no session plausibly uses returns
  `sessions: []` — never `null`, never an error.
- **`ACP-LIST-203`** (:845): filtered by a real `cwd`, every returned `SessionInfo.cwd` equals the
  requested `cwd` (per-entry only; not asserting a fresh session must appear).
- **`ACP-LIST-204`** (:857): every returned `SessionInfo.cwd` is an absolute path.
- **`ACP-CLOSE-201`** (:866): `session/close` of a live, idle session succeeds with a schema-valid
  empty-object result.
- **`ACP-CLOSE-202`** (:880): `session/close` on a session with foreground work in flight cancels
  it as if `session/cancel` had been sent (reuses `ACP-CANCEL-208`'s evidence).
- **`ACP-DELETE-201`** (:897, `capability="capabilities.session.delete"`): `session/delete` of an
  existing session succeeds with `{}`.
- **`ACP-DELETE-202`** (:904, same capability): after successful delete, session no longer appears
  in `session/list`. SKIPs if the session was never observed in `session/list` to begin with.
- **`ACP-DELETE-203`** (:915, `Tier.ADVISORY`, no capability): deleting an already-deleted/
  never-created id SHOULD succeed silently.
- **`ACP-ADDDIRS-201`** (:926, `capability="capabilities.session.additionalDirectories"`):
  `session/new` with an absolute `additionalDirectories` entry is accepted.
- **`ACP-ADDDIRS-202`** (:934, same capability): `session/resume` with an absolute
  `additionalDirectories` entry (matching the session's `cwd`) is accepted — new in v2, v1 had no
  analogue.

## 3. Current codex-acp implementation (v1) — file:line map

All in `src/CodexAcpServer.ts` unless noted.

- **`newSession`** (`:971-992`) → `getOrCreateSession` (`:543-551`) → `tryCreateSession`
  (`:634-757`, `operation: "new"`) → `codexAcpClient.newSession()` (`CodexAcpClient.ts:667-691`),
  which calls Codex app-server's `threadStart`. Returns `LegacyNewSessionResponse` = `{sessionId,
  models, modes, ...configOptions}`.
- **`resumeSession`** (`:841-858`) → `getOrCreateSession` → `tryCreateSession`
  (`operation: "resume"`) → `codexAcpClient.resumeSession()` (`CodexAcpClient.ts:585-608`), which
  calls `resumeThread({excludeTurns: true, ...})`. **No thread/turns fetch, no history replay at
  all.** Returns `LegacyResumeSessionResponse` = `{models, modes, ...configOptions}` (no
  `sessionId` — the id is already known from the request).
- **`loadSession`** (`:807-839`, v1-only, no v2 analogue as a *method* — folds into v2's
  `resumeSession`+`replayFrom`) → `getOrCreateSessionWithHistory` (`:1910-2022`) →
  `codexAcpClient.loadSession()` (`CodexAcpClient.ts:625-661`), which calls the **exact same**
  `resumeThread({excludeTurns: true, ...})` as `resumeSession`, then additionally fetches turns
  (`threadReadHistory` for paginated history, or `threadReadWithHistory` otherwise,
  `CodexAcpClient.ts:639-648`) and returns `SessionMetadataWithThread` (adds a `thread` field).
  Back in `CodexAcpServer.loadSession`, `streamThreadHistory(sessionId, thread)` (`:823`, defined
  `:2024-2057`) is called before responding — this is the replay step.
- **`streamThreadHistory`** (`:2024-2057`): branches on `clientSupportsSubagents` — if so, calls
  `streamNativeThreadHistory` (`:2059-`, walks `thread.turns[].items[]`, emits per-item updates via
  `createHistoryUpdates` (`:2271`), plus subagent-spawn/state bookkeeping); if not, additionally
  merges in `createResponseItemHistoryFallbackUpdates` (from `ResponseItemHistoryFallback.ts`) —
  a **parallel, file-based reconstruction path** that re-parses Codex's raw `.jsonl` rollout file
  (`thread.path`) line-by-line into the same `UpdateSessionEvent[]` shape, deduplicated against the
  native-thread-derived updates via `mergeHistoryUpdates` (`:3425`). This fallback exists because
  older/legacy rollouts may lack full structured `ThreadItem` data that the native path needs.
- **`listSessions`** (`:880-897`) → `codexAcpClient.listSessions()` (`CodexAcpClient.ts:1124-1177`)
  → Codex's `threadList` with cursor pagination, mapped 1:1 to `{sessionId, cwd, title, updatedAt}`
  — **already structurally identical to v2's `SessionInfo`/`ListSessionsResponse`** except v2 adds
  `additionalDirectories` (already patched in by the *caller*, `CodexAcpServer.listSessions`
  `:886-894`, from live in-memory `SessionState.additionalDirectories`, not from
  `codexAcpClient.listSessions()` itself).
- **`closeSession`** (`:899-934`): cancels in-flight turn (`interruptSessionTurn`), closes active
  prompt, calls `codexAcpClient.closeSession` (`threadUnsubscribe` + handler cleanup), clears
  session-scoped maps. No v1/v2 shape delta at all.
- **`deleteSession`** (`:936-956`): closes the local session first if live, then
  `codexAcpClient.deleteSession()` (`CodexAcpClient.ts:702-`) → `threadArchive`, idempotent on
  already-archived/never-existed ids. No v1/v2 shape delta.
- **`SessionFork.ts`** (132 lines) and `forkSession` (`CodexAcpServer.ts:860-878`): codex-acp's own
  v1 extension (`session/fork`, not a standard v1 or v2 baseline method). v2 has an **unstable/
  experimental** `SessionForkCapabilities`/`ForkSessionRequest`/`ForkSessionResponse` in the SDK
  (`types.gen.ts` — same file, `ForkSessionResponse` at `:3188-3216`) that maps closely to
  codex-acp's existing shape (`sessionId`, `configOptions`). Out of this topic's TCK-requested
  scope (no `ACP-FORK-*` ids were requested), but worth flagging: if codex-acp keeps `fork` in v2,
  it's a straight lift onto the unstable SDK type, sharing the same `tryCreateSession(..., "fork")`
  path as everything else.
- **`SessionMetadata.ts`** (17 lines): plain data type (`SessionMetadata`/`SessionMetadataWithThread`)
  shared by `newSession`/`resumeSession`/`forkSession`/`loadSession` in `CodexAcpClient.ts` — no
  protocol-shape coupling, reused as-is.
- **`CodexSessionCompactions.ts`** (92 lines): purely **in-memory, per-live-turn** runtime state
  (compaction start/complete/finish bookkeeping for `compaction_update` session-updates during
  active prompting) — not persisted, not part of the history-replay data path. Irrelevant to
  `replayFrom`; a `CodexSessionCompactions` instance is simply constructed fresh in every session
  state (`tryCreateSession:726`, `getOrCreateSessionWithHistory:1992`) whether the session is new,
  resumed, or loaded.
- **Concrete small gap found (not fixed — research only):** `CodexAcpClient.newSession()`
  (`CodexAcpClient.ts:672`) passes `request.mcpServers` **directly** (no `?? []` fallback) into
  `createSessionConfig`, unlike every other call site (`resumeSession:591`, `loadSession:631` both
  use `request.mcpServers ?? []`). Under v1 this was safe because `mcpServers` was
  required-even-if-empty in the v1 schema. Under v2's `NewSessionRequest`, `mcpServers` is
  optional — a v2 client sending `session/new` with the field omitted (exactly what `ACP-SESSION-203`
  tests) would flow `undefined` into `createSessionConfig` if the v2 handler reuses this same
  `CodexAcpClient.newSession()` method unchanged. This is the one concrete code-level landmine this
  topic's research surfaced; flagged for the implementation phase, not fixed here.

## 4. The crux: does `ResponseItemHistoryFallback.ts` already have the right shape for `replayFrom`?

**Yes — v1's `session/load` already *is* v1's `session/resume` plus exactly the replay step v2
needs; no restructuring of the replay data source is required.**

The evidence: `CodexAcpClient.resumeSession()` and `CodexAcpClient.loadSession()` both call the
identical underlying app-server RPC, `resumeThread({excludeTurns: true, config, cwd,
modelProvider, threadId})` (`CodexAcpClient.ts:589-595` vs. `:629-635` — same call shape, same
`excludeTurns: true`). `loadSession` is *strictly additive* on top of that: it fetches
`thread.turns` afterward (`:639-648`) and, back in `CodexAcpServer`, calls `streamThreadHistory`
before responding (`:823`). `resumeSession` simply skips both of those additive steps. There is no
divergent code path, no separate storage, no different query — `session/load`'s "does it have
history" data need is already served by the exact same `resumeThread` call `session/resume` makes;
only the *decision to also fetch turns and replay them* differs.

`ResponseItemHistoryFallback.ts` is not itself the primary replay data source — it's a
**secondary, file-based reconstruction fallback** for cases where the native `Thread.turns[].items[]`
structure (fetched via `threadReadHistory`/`threadReadWithHistory`) is insufficient (e.g. older
rollouts, or clients that don't support the native subagent-aware event stream — gated on
`!clientSupportsSubagents`). It re-derives the same `UpdateSessionEvent[]` shape from raw `.jsonl`
lines and is merged with (deduplicated against) the native-derived updates via
`mergeHistoryUpdates`. Either way, **the output is the same `UpdateSessionEvent[]` v1-shaped
session-update list that `streamThreadHistory` already knows how to emit over the wire** — which is
exactly the payload v2's `session/resume`+`replayFrom:{"type":"start"}` must emit, just via v2's
different wire *serialization* for each update (see §5/§6 below), not different *data*.

One real, if narrow, gap for v2 compliance: v1's chunk updates carry `messageId` as **optional**
(`acp-typescript-sdk` v1 `types.gen.ts:3772`, `messageId?: MessageId | null`), and
`ResponseItemHistoryFallback.ts`'s dedup key (`historyFallbackUpdateKey`, `:27-40`) tolerates a
missing `messageId` (`update.messageId ?? ""`). v2 makes `messageId` **required** on every
`user_message`/`agent_message`/`agent_thought`/chunk (`types.gen.ts:3780-3915`), and `ACP-RESUME-204`
specifically requires that a replayed user message matches the `messageId` its original
`session/prompt` response returned. Today's `createHistoryUpdates`/`createResponseItemHistoryFallbackUpdates`
already assign a `messageId` from Codex's own item ids (`item.id`) in the vast majority of cases
(`CodexAcpServer.ts:2285,2329,2341`), so this is expected to already satisfy `ACP-RESUME-204` in
practice — but it hasn't been schema-enforced as non-optional before, so the v2 serialization layer
must verify/guarantee every emitted `user_message`/`agent_message`/`agent_thought` carries one (a
validation/assertion concern at the v2 boundary, not a data-availability concern).

## 5. Dual-version verdict

**Cheap to share, with one real fork point: method count.** v1 exposes `session/load` and
`session/resume` as two separate registered methods; v2 collapses them into one method
(`session/resume`) with an internal `replayFrom` branch. Everything below that surface is either
already shared or trivially shareable:

- **Fully shared, zero branching needed:** `session/close`, `session/delete` — identical
  request/response shapes in v1 and v2. The v2 handler chain's registrations can call
  `CodexAcpServer.closeSession`/`deleteSession` unchanged.
- **Fully shared business logic, thin response-shape branch only:** `session/new` — same
  `tryCreateSession(..., "new")` path; the only difference is the v2 handler must (a) apply the
  `mcpServers ?? []` fix noted in §3 so optional `mcpServers` doesn't reach `createSessionConfig` as
  `undefined`, and (b) build a `NewSessionResponse` with only `{sessionId, configOptions}` (drop
  `models`/`modes`, which move to config-option mapping — topic 9's concern, referenced not solved
  here).
- **Fully shared business logic, thin response-shape branch only:** `session/list` — same
  `codexAcpClient.listSessions()` call; v2's `SessionInfo` is a superset (adds
  `additionalDirectories`, which the v1 handler already patches in from live `SessionState` at
  `:886-894` — that patch step is version-agnostic and can be reused verbatim).
- **The one genuine dispatch decision, not a divergent implementation:** v2's single
  `session/resume` handler must branch on `replayFrom`:
  - absent/`null` → call the same code `resumeSession` (v1) already calls:
    `getOrCreateSession`/`tryCreateSession(..., "resume")`, then build a `ResumeSessionResponse`
    with only `{configOptions}`.
  - `{"type":"start"}` → call the same code `loadSession` (v1) already calls:
    `getOrCreateSessionWithHistory` + `streamThreadHistory`, then build the same reduced
    `{configOptions}` response — the history itself already streams as ordinary
    `session/update` notifications over whichever wire-serialization chain (v1 or v2) is active,
    since `ACPSessionConnection.update()` writes through the connection the router already picked;
    no extra plumbing needed to get replay traffic onto the v2 wire once the v2 handler chain's
    `session/update` notification builder exists (that builder is the tool-calls/messages topic's
    concern).
  - any other `replayFrom.type` (custom/future/unrecognized) → no existing precedent; codex-acp
    will need to decide to either reject with an error or treat as a no-op-with-warning. Not
    resolved here since no TCK requirement in this topic's set mandates a specific behavior for
    unknown cursor types (the union is deliberately open per spec `session-setup.mdx:126-127`,
    "future ACP variants").
  This is exactly "a thin serialization/dispatch-layer branch, not divergent internal logic" per
  the framing this research was asked to test — the fetch-thread-and-replay code that `loadSession`
  already runs does not need to be rewritten, restructured, or duplicated for v2; it needs to be
  called from a different entry point based on a request-shape check.
- **Preserving v1's two methods is not a complicating constraint.** Because v1's `session/load` and
  `session/resume` keep their own registrations in the v1 handler chain (untouched, per the
  dual-version router design), and v2's single `session/resume` registration in the v2 chain is a
  *new, additional* entry point that calls into the same two shared helper functions
  (`getOrCreateSession` / `getOrCreateSessionWithHistory`+`streamThreadHistory`), there is no
  conflict between "must keep `session/load` working for v1" and "must implement `replayFrom` for
  v2" — they call the identical underlying methods, just from two different top-level dispatchers.
- **Response-shape reduction (`models`/`modes` dropped from `NewSessionResponse`/
  `ResumeSessionResponse`) is a real but bounded serialization cost**, and is the same
  session-modes-become-config-options migration that topic 9 (`v2-config-options-modes-and-plans`)
  owns — this topic's v2 handlers will need topic 9's config-option mapping to be available before
  they can build a fully spec-compliant v2 response, but that's a sequencing dependency to flag for
  the orchestrator, not extra work inside this topic.

**Net:** small-to-medium effort, dominated by wiring (one new v2 method registration dispatching to
two already-correct code paths) rather than by any need to restructure history storage or replay
logic. The single biggest risk is not logic, it's the cross-topic dependency on topic 9's
config-option representation of models/modes before `NewSessionResponse`/`ResumeSessionResponse`
can be fully built for v2.

# TCK-U1: v2 `_auth/status_update` push right after `initialize` fails BATCH-202 / JSONRPC-003 / EXT-201

**Sources checked:**
- ACP spec `agent-client-protocol` @ `5b45096e` (2026-09-24). The TCK cites `8f76d6c8`; `git diff 8f76d6c8 HEAD` shows no change to `docs/protocol/v2/{transports,extensibility,overview,initialization}.mdx`.
- ACP TypeScript SDK `acp-typescript-sdk` @ `69fda370` (2026-09-23).
- TCK `acp-tck` @ `5418887d` (2026-09-23; origin `EugeneTheDev/acp-tck`).
- codex-acp @ `d1cd4d3f` (branch `eugenethedev/acp-v2`).
- Raw TCK reports `/tmp/acp-tck-reports/6d-v2.{txt,json}` and `6d-v1.{txt,json}`.
- JSON-RPC 2.0 spec (jsonrpc.org), cited by section from the published text. It is not a checkout.

**Confidence:** high. The TCK source, the wire transcripts, the spec text and the SDK reference all point the same way. The only judgment call is the recommendation.

## Answer

- **What the tests accept.** BATCH-202 (with JSONRPC-003 on the same test) and EXT-201 send a notification and then call raw `read_line` for `quiet_period` = 2 s. They accept only total silence on stdout. Any line fails them: an agent notification, an agent request, anything. So the failure is not limited to lines that look like responses.
- **TCK bug.** By ACP v2 and JSON-RPC 2.0 this is a TCK false positive. An agent notification carries no `id`, so it is a Request object, not a reply. ACP v2 forbids only *replies* to notifications. Nothing restricts agent-initiated custom notifications after `initialize`. The TCK itself tolerates spontaneous notifications in BATCH-201 and in the single-message JSONRPC-003 probe.
- **v1.** v1 pushes `_auth/status_update` too, with identical timing (a `setImmediate` after the `initialize` response). The v1 rows pass because the v1 suite has no batch or EXT-201 probe. v1 JSONRPC-003 filters for response-shaped lines only, and it runs after `session/new`, by which point the push has already gone out.
- **Purpose.** The push is the extension's only channel for "which identity does this agent pay with". On v2 the legacy `authentication/status` pull is deliberately not registered. Its contract is an unconditional first push after `initialize`, so clients can show identity before any session exists.
- **Recommendation.** Option (c): keep the push, and fix BATCH-202 and EXT-201 in the TCK to ignore `method`-bearing lines. Until then, record the rows as a known TCK false positive. Topic 10 has no timing decision yet; it only names the mechanism.

## Requirements

| # | Requirement | Tier | Citation |
|---|-------------|------|----------|
| R1 | Receiver MUST NOT reply to a Notification, including one inside a batch | MUST | spec `docs/protocol/v2/transports.mdx:66-67`; JSON-RPC 2.0 §4.1, §6 |
| R2 | For an all-notification batch, receiver MUST NOT return an empty array and "should return nothing" (scoped to the batch's Response array) | MUST (no empty array) / SHOULD (nothing) | spec `transports.mdx:70-72`; JSON-RPC 2.0 §6 ("should return nothing at all", said of the Response array) |
| R3 | Notifications never receive responses (success or error) | MUST (stated as a fact of the JSON-RPC base) | spec `docs/protocol/v2/overview.mdx:185` |
| R4 | A Notification is a Request object without an `id`; either side may send notifications | normative definition | spec `transports.mdx:23-24,47-51`; JSON-RPC 2.0 §4.1 |
| R5 | Implementations SHOULD ignore unrecognized custom (`_`) notifications | SHOULD | spec `docs/protocol/v2/extensibility.mdx:109` |
| R6 | Custom notifications are regular JSON-RPC notifications with a `_` prefix | MAY (a custom method is optional) | spec `extensibility.mdx:95-107` |
| R7 | Extensions SHOULD be advertised via `_meta` in capability objects (codex-acp: `capabilities.auth._meta.authStatus`) | SHOULD | spec `extensibility.mdx:93,126`; codex-acp `src/CodexAcpServer.ts:483-491` |
| R8 | Clients MUST call `initialize` before a session can be created. No rule forbids agent→client messages between `initialize` and the first session request | MUST (client) / none for this window | spec `docs/protocol/v2/initialization.mdx:24` |

TCK tiers (from `src/tck/v2/requirements.py`): ACP-JSONRPC-003 MANDATORY (`:587-598`), ACP-BATCH-202 MANDATORY (`:637-646`), ACP-EXT-201 ADVISORY (`:1334-1345`).

## Details

### 1. What each check sends and accepts (TCK `acp-tck` @ 5418887d)

**Common setup.** `v2_only_agent` (`src/tck/v2/conformance/_helpers.py:468-498`) and `connected_agent` (`_helpers.py:42-72`) do the following:
- send `initialize`;
- wait for its response;
- call `login_if_needed`, which is a no-op without `--auth-method` (`_helpers.py:103-128`, early return at `current_auth_method_id() is None`).

The probe therefore goes out immediately after the `initialize` response. That is exactly the window where codex-acp's `setImmediate` push lands.

`quiet_period(90) = max(0.5, min(2.0, 9.0)) = 2.0 s` (`_helpers.py:603-610`).

| Row | Test | Sends | Accepts | Predicate |
|-----|------|-------|---------|-----------|
| ACP-BATCH-202 + ACP-JSONRPC-003 | `test_batch.py:66-78` `test_notification_only_batch_produces_no_output` | raw line `[{"jsonrpc":"2.0","method":"_tck/notify_only"}]` | `AgentTimeout` from `agent.read_line(timeout=2.0)` | **none**: any line fails |
| ACP-EXT-201 | `test_extensibility.py:117-135` `test_unrecognized_custom_notification_produces_no_response` | `{"jsonrpc":"2.0","method":"_tck/ping","params":{"hello":"world"}}` | `AgentTimeout` from `agent.read_line(timeout=2.0)` | **none**: any line fails ("agent responded …: {entry.text}") |
| ACP-JSONRPC-003 (single-message half) | `test_jsonrpc.py:74-90` | `session/new`, then a `session/cancel` notification | `AgentTimeout` from `wait_for_message(_is_a_response)` | only a message **without `method`** counts (`iter_messages`, `_helpers.py:501-520`) |

- **How JSONRPC-003 fails.** The single-message test passed in 6d-v2 (`test_jsonrpc.py .....`, `6d-v2.txt:15`). JSONRPC-003 fails only because the batch test carries the second marker `@pytest.mark.requirement("ACP-BATCH-202", "ACP-JSONRPC-003")` (`test_batch.py:66`).
- **Observed wire** (`6d-v2.txt`, BATCH-202 at ~l.52-56, EXT-201 at ~l.37312-37315): `--> [{"jsonrpc": "2.0", "method": "_tck/notify_only"}]`, then `<-- {"jsonrpc":"2.0","method":"_auth/status_update","params":{"authStatus":{"kind":"gateway","label":"Custom model gateway","detail":"wire"}}}`. EXT-201 shows the same line after `_tck/ping`. The line has no `id`, so it is plainly a notification.
- **Any agent notification fails these two tests.** The push is not special. A `session/update`, an agent→client request, or any other line in the 2 s window would fail them too.
- **The TCK's own positions contradict these two tests:**
  - BATCH-201 (`test_batch.py:37-63`) explicitly skips "bare notifications only" because "a single spontaneous notification arriving first … must not fail this MANDATORY row".
  - JSONRPC-003's single-message probe filters to response-shaped lines.
  - The TCK ships a *conforming* fixture that sends an unsolicited notification (`tests/fixtures/agents/v2/idle_before_running.py:2-5`).
  - The ACP-EXT-203 informational probe (`test_extensibility.py` after `:166`) uses the same raw read. In 6d-v2 it recorded `behaviour: "replied: '{…_auth/status_update…}'"` (`6d-v2.json`, ACP-EXT-203). This is harmless there, because informational rows never assert.
- **Requirement text over-reads the spec.** `requirements.py:643-644` says "A notification-only batch produces no output at all". The spec says "the receiver MUST NOT return an empty array and should return nothing" (`transports.mdx:70-72`). JSON-RPC 2.0 §6 says the same about "the Response array". Both are about responses, not about all stdout.

**Is it a TCK bug by the spec's standard?** Yes.
- R1/R3 prohibit *replies*.
- By R4 / JSON-RPC 2.0 §4.1, an `id`-less message with `method` is a Request (Notification), never a Response. A reply must carry the request's `id` (JSON-RPC 2.0 §5), and a notification has none to echo.
- ACP is bidirectional over one stdio pair (`transports.mdx:21-24`). No v2 text restricts when the agent may send its own notifications after `initialize` (R8).
- The TypeScript SDK reference behaves the same way:
  - `AgentContext.notify` only waits for initialization before sending (`src/v2/acp.ts:1077-1087`, `waitUntilInitialized` `:525-533`).
  - Its own test sends a custom `_vendor/acme/event` notification from `onConnect` right after `connection.initialized`, with no session (`src/v2/acp.test.ts:1473-1480`, asserted at `:1510`). That is exactly codex-acp's pattern.
  - The SDK's receiving side drops unhandled notifications silently; only requests get `-32601` (`src/jsonrpc.ts:1408-1414`). A spec-following client never answers `_auth/status_update` either.

### 2. v1: same push, same timing, different checks

- **Same push on v1.** v1 `initialize` calls `this.publishFirstAuthStatusAfterResponse()` (`src/CodexAcpServer.ts:407-418`), exactly as `initializeV2` does (`:460-478`). Both schedule `setImmediate(() => void this.publishAuthStatusRead())` (`:1352-1365`). The first push is never suppressed, because `currentAuthStatus` starts `null` (`:393`, `setAuthStatus` `:1479-1490`). So v1 pushes after every `initialize`, unconditionally.
- **Why the v1 rows pass:**
  - v1 has no batching and no batch tests; the BATCH-* rows are new in v2 (`test_batch.py:1-4`).
  - v1 has no EXT-201. Its extensibility row ACP-EXT-001 is about custom *requests* getting some response (`src/tck/v1/requirements.py:651-664`).
  - v1 JSONRPC-003 (`src/tck/v1/conformance/test_jsonrpc.py:93-113`) runs `new_session` first, so the push has already been emitted. It also only counts lines where `"method" not in entry.parsed`.
  - The v1 informational raw-read probes (`src/tck/v1/conformance/test_informational.py:45-110`) never assert. In 6d-v1 they recorded the `-32700`/`-32600` replies, which beat the push because the push waits on app-server reads.
- **Codex-side cost of the push.** It is at most two app-server reads: model provider config, and `account/read` via `getAccount` (`src/CodexAcpServer.ts:1392-1404`). These are request/response calls to Codex's app-server. No `codex/event/*` surface is involved.

### 3. What `_auth/status_update` is for, and whether the client needs it before its first session request

- **Design contract** (`src/AuthStatusMeta.ts:6-33`; commit `fe696b0`, PR #467):
  - An interim, push-only, connection-scoped extension that reports the identity the agent pays with (`kind` / `label` / `detail` / `account`).
  - "The agent pushes once after `initialize`, as soon as it knows its identity, including `none`. That first push is unconditional" (`:13-15`).
  - After that, it pushes only on change: `authenticate`/`logout`, each session create/fork/load, and `account/updated` (`:17-21`).
  - The client sends nothing, and there is no pull method (`:10-11`).
  - The payload is meant to move to first-class fields "once the upstream auth-identity RFD lands" (`:31-32`).
- **Who consumes it.**
  - It is advertised as `capabilities.auth._meta.authStatus` on v2 (`src/CodexAcpServer.ts:483-491`) and `agentCapabilities._meta.authStatus` on v1 (`:450-455`).
  - No consumer is documented in-repo: `readme-dev.md`, `README.md` and `docs/` never mention it; only `CHANGELOG.md:75` does.
  - The JetBrains client (AIR) is the presumed consumer, but that is a **hypothesis**. It rests on the PR's origin and the `_meta.jetbrains` / AIR context in `.agents/research/v2-extension-capabilities-placement.md`.
- **Pre-session need.**
  - **On v2 the push is the only source.** `AcpAgentRouter.ts:105` states "The v1-only `authentication/status|logout` extensions are not registered on v2". That follows the placement research decision (`v2-extension-capabilities-placement.md:146`, "Do not register"). On v1 a client can still pull via `authentication/status` (`AcpAgentRouter.ts:87`).
  - Without the initialize-time push, a v2 client learns nothing until its first session create or an auth event.
  - The design explicitly targets showing identity before a session. The upstream Draft RFD `docs/rfds/get-auth-state.mdx` (a **proposal**, Draft per `docs/rfds/updates.mdx:106`) motivates the same need: "showing a 'Sign in' prompt before any session is created" (`:40`, and `:12,37-39`). The RFD proposes a *pull* `auth/status` request instead of a push (`:49-70,114-138`).
  - Whether AIR actually blocks on, or renders, the pushed status before its first session request cannot be established from these sources.
- **Existing test pinning the current behavior.** `src/__tests__/CodexACPAgent/initialize-v2.test.ts:72-93` asserts one `_auth/status_update` arrives after a bare v2 `initialize`, with no further request.

### 4. Options

The session-open path already pushes *before* the `session/new|resume|fork` response: `getAuthStateForProvider` is awaited at `src/CodexAcpServer.ts:781-790`, and it calls `publishAuthStatus` → `setAuthStatus` → awaited `connection.notify` (`:867-880,1410-1432,1479-1490`). Dropping or deferring the initialize-time push therefore never adds a *post-response* line on session requests.

| Option | TCK effect | Client effect | Cost / risk |
|--------|-----------|---------------|-------------|
| **(a) Defer the first push until the first session open** (`session/new/resume/fork`). Effectively: do not schedule it in `initializeV2`, because session open already pushes. | BATCH-202, EXT-201 and JSONRPC-003 pass: no session in those probes, and the push precedes the `session/new` response elsewhere. | v2 clients have no identity until a session opens. There is no v2 pull to fall back on. `session/list` / `auth/login` / `providers/*`-first clients see nothing, except that `auth/login` pushes via `refreshAuthState` (`:1137`). Breaks the documented "once after initialize" contract (`AuthStatusMeta.ts:13-15`) for v2 only, so v1 and v2 diverge. | Small code change. Must update `initialize-v2.test.ts:91-92` and the `AuthStatusMeta.ts` doc. |
| **(a′) Push before the response to the first inbound request of any kind** (read identity, notify, then answer) | Passes: the TCK probes are notifications, not requests. | Keeps early identity for any client that makes any request. A client that idles after `initialize`, waiting for the push, gets nothing. | Adds an app-server account read to the first request's latency. It needs a per-connection "first request" hook that the v2 router does not have today; this is a **hypothesis** from `AcpAgentRouter.ts:94-112`. More moving parts. |
| **(b) Push only on an actual status change** | Same as (a): the first push is by definition a change from "unknown", so in practice it becomes "no initialize-time push". | Same loss as (a), with less predictable timing. | No real advantage over (a). |
| **(c) Keep the push; treat the rows as a TCK false positive; fix the TCK** | Needs a TCK change: BATCH-202 and EXT-201 should use the response-only predicate that JSONRPC-003 and BATCH-201 already use (`wait_for_message(lambda e: any("method" not in m for m in iter_messages(e)))`). Until then, record the rows as known in `.agents/tck/`. | No behavior change; the contract is intact for v1 and v2. | The TCK lives in the user's own repo (`EugeneTheDev/acp-tck`), so the fix is cheap and self-owned. The upstream spec needs no change. |

**Recommendation: (c).**
- The push is spec-conforming (R1/R3/R4/R6/R7). The reference SDK demonstrates the exact pattern (`acp.test.ts:1473-1480`), and the TCK already accepts spontaneous notifications elsewhere.
- Changing product behavior to satisfy two inconsistent probes would remove the only pre-session identity signal on v2, where the pull method was deliberately not registered.
- If a green TCK is needed before the TCK fix lands, (a′) is the least-lossy product-side workaround. (a)/(b) are simpler but drop pre-session identity on v2. Either would need a user decision, because it changes the extension's documented contract.

**Does topic 10 already constrain this?**
- There is no timing decision. `.agents/state.md:366` (topic 10, "Not started") lists only the mechanism: "outbound `_auth/status_update` via `client.notify`".
- Prior decisions lean toward keeping the push as-is:
  - `v2-extension-capabilities-placement.md:149` ("Keep") and `:215` ("spec-mandated (MAY, conforming)"; "the SDK sends it only after initialize");
  - `.agents/plan.md:346` and `.agents/architecture.md:480` ("no change" to the push extension; topic 8 context);
  - the router decision not to expose the legacy pull on v2 (`AcpAgentRouter.ts:105`).
- None of them considered the TCK silence probes.

## Testability notes

- **Current contract (keep under (c)).** `initialize-v2.test.ts:72-93` already asserts the post-initialize push through a real `acpV2.client()`.
  - A conforming extra assertion: the first message the client sees after the `initialize` response is a notification with `method: "_auth/status_update"` and no `id`.
  - Non-conforming would be an `id`-bearing message, or anything sent before the `initialize` response.
  - The SDK guarantees the ordering (`acp.ts:1077-1087`).
- **R1 (no reply to a notification) in Vitest.** Send an unknown `_x/ping` notification (and, if the router supports it, a notification-only batch) through the raw stream. Collect outbound lines for a short window and assert that none of them lacks `method`. Do not assert total silence; that is the TCK's mistake.
- **If (a)/(a′) were chosen:**
  - (a): assert no `_auth/status_update` after a bare `initialize` (bounded wait), and exactly one before the `session/new` response.
  - (a′): assert one push before the first request's response, and none after a notification alone.
  - "No push arrives" is only provable with a bounded wait (a heuristic). A snapshot of message order is the robust form.
- **Unobservable:** whether a real client needs the value before its first session request. That is client behavior outside this repo.

## Discrepancies

- **TCK vs spec.** BATCH-202 and EXT-201 assert total stdout silence. The spec (`transports.mdx:66-72`, `extensibility.mdx:109`, `overview.mdx:185`) and JSON-RPC 2.0 §4.1/§6 prohibit only replies / Response objects. The TCK requirement text "produces no output at all" (`requirements.py:643-644`) over-reads "should return nothing".
- **TCK vs itself.** BATCH-201 (`test_batch.py:37-63`) and JSONRPC-003's single-message probe (`test_jsonrpc.py:74-90`) ignore spontaneous notifications. BATCH-202 and EXT-201 do not.
- **Spec direction vs codex-acp.** The upstream Draft RFD `get-auth-state` proposes a *pull* `auth/status` request (`docs/rfds/get-auth-state.mdx:49-138`). codex-acp's interim extension is push-only and has no pull on v2. This is not a conformance issue (RFD = proposal), but it is relevant to how long the push stays.
- **SDK vs spec.** None found; the SDK permits agent notifications as soon as the connection is initialized.

## Open questions

- Should v2 expose a pull for auth identity, as a `_`-prefixed request, or by tracking the `auth/status` RFD? That would make options (a)/(b) lossless. This belongs to topic 10 or a user decision.
- Does the JetBrains client (AIR) rely on the initialize-time push before its first request on v2? This needs the client team; it is not answerable from upstream sources.
- Other v2 TCK failures in 6d-v2 (ACP-CANCEL-201/203-207, ACP-INFO-CANCEL-202, ACP-RESUME-202, ACP-EXT-202 `providers`, ACP-BATCH-204 omitted `params`) have transcripts that contain the push, but their failure causes are unrelated: cancel stopReason, timeouts, `replayFrom`, `-32602`. TCK-U2 already owns the omitted-params one.

# v2: post-insertion prompt failures (Q1) and what the idle `state_update` carries (Q2)

**Sources checked:**
- ACP spec `agent-client-protocol` @ `616b74f` (2026-09-24): `docs/protocol/v2/`, `docs/protocol/v2/draft/`, `schema/v2/schema{,.unstable}.json`, `schema/v1/schema.unstable.json`, RFDs
- ACP TypeScript SDK `acp-typescript-sdk` @ `69fda37` (2026-09-23)
- ACP TCK `acp-tck` @ `5418887` (2026-09-23)
- codex-acp @ `035c843` (branch `eugenethedev/acp-v2`); installed `@agentclientprotocol/sdk` 1.5.0

No Codex app-server source was needed. The Codex evidence here comes from codex-acp's own mapping and from earlier research.

**Confidence:** high on what the spec, SDK and TCK say and do not say. The spec says it has not settled post-insertion failure reporting, so the choice of carrier is a judgment call. The two recommendations below are my best reading, not requirements.

## Answer

**Q1.** Once a prompt is inserted, the v2 client can no longer get a JSON-RPC error for it. The spec has not defined a failure channel for this case. The v2 prompt RFD lists "post-insertion failure reporting" as an open follow-up. What the spec does require is an `idle` `state_update` as soon as the agent can take a new prompt, and codex-acp can take one right after `prompt()` throws. So today's "`running` and never `idle`" breaks a MUST, fails TCK `ACP-STATE-202`, and leaves SDK `ActiveSession` clients waiting forever.

Recommendation: send the error as agent-message text, then `idle` with `stopReason: "end_turn"`, plus the usual `_meta` and `usage` (see Q2).
- `notice` is not an option. The draft spec forbids using a notice for fatal-error reporting.
- `refusal` has the wrong meaning.
- A `_`-prefixed custom stop reason is allowed, but generic clients can only show "stopped". I suggest it at most as an optional extra.

Two things need a **user decision**:
- Whether to also add a machine-readable error on idle `_meta`, for example to replace the v1 `-32000 auth_required` signal.
- Whether a custom stop reason is wanted.

**Q2.** Yes. The idle `state_update` is v2's turn-completion signal. The migration guide moves `stopReason` there, and the end-turn-usage RFD moves `usage` there. `IdleStateUpdate` defines `_meta`, and the unstable schema (which the installed SDK 1.5.0 types) also defines `usage`. Today 2(b) copies only `stopReason`. As a result, **v2 clients that negotiated AIR `sessionFailure` see nothing about a turn's terminal failure**: no text, no session update, only `idle/end_turn`. This is because the typed path records the failure only for `PromptResponse._meta`.

Recommendation (option A): put v1's `PromptResponse._meta` (the `quota` object plus `jetbrains.air.sessionFailure`) and `usage` on the idle update unchanged. This keeps the "report the terminal failure once" rule. It changes the AIR contract, because the AIR client has to read idle `_meta` on v2, so it **needs user sign-off**.

## Requirements

| # | Requirement | Tier | Citation |
|---|---|---|---|
| R1 | The agent MUST respond to `session/prompt` once the message is inserted. Requests rejected *before* insertion get a JSON-RPC error. | MUST | spec `docs/protocol/v2/prompt-lifecycle.mdx:139` |
| R2 | A successful prompt response is not an `idle` signal. Work continues on its own after it. | stated behavior | `prompt-lifecycle.mdx:184` |
| R3 | When foreground work starts, the agent MUST send `state_update running`. | MUST (under `capabilities.session`) | `prompt-lifecycle.mdx:188` |
| R4 | When the agent is ready for a new prompt it MUST report `idle`, and MUST include a `StopReason` when that ends foreground work. | MUST | `prompt-lifecycle.mdx:377`; migration `docs/protocol/v2/migration.mdx:282` |
| R4' | The schema says the same thing more weakly: `stopReason` is optional, and "Agents SHOULD include this when the idle transition ends foreground work". | SHOULD (schema) | `schema/v2/schema.json:4904` (`IdleStateUpdate.stopReason`) |
| R5 | The agent MAY stop foreground work at any point with an idle update and a stop reason. | MAY | `prompt-lifecycle.mdx:394` |
| R6 | Stop reasons are `end_turn`, `max_tokens`, `max_turn_requests`, `refusal` and `cancelled`. Custom ones "can be used when Clients can display a generic stopped state" and MUST start with `_`. | MUST (for the `_` prefix) | `prompt-lifecycle.mdx:489-510`; `schema.json` `StopReason` |
| R7 | `refusal` means "the user prompt and everything that comes after it won't be included in the next prompt". | definition | `schema.json` `StopReason` (refusal branch) |
| R8 | On cancellation, updates go out *before* the idle update, and the idle carries `cancelled`. Errors caused by the abort MUST be reported as `cancelled`. | MUST | `prompt-lifecycle.mdx:548-559` |
| R9 | `notice` (draft only, unstable) "must not carry information required for … task completion, or fatal-error reporting". Even `error` severity "does not … stop foreground work, change session state, or imply a prompt stop reason". | MUST NOT (draft) | `docs/protocol/v2/draft/prompt-lifecycle.mdx:352-395` (esp. `:384-392`); RFD `docs/rfds/session-notices.mdx:88-90,102-106` |
| R10 | Fatal errors "belong in the relevant request, permission, elicitation, message, tool, or lifecycle primitive". | RFD guidance | RFD `session-notices.mdx:103-105` |
| R11 | Post-insertion failure reporting is explicitly **not defined**: "Broader v2 lifecycle follow-ups include post-insertion failure reporting…". | not specified | RFD `docs/rfds/v2/prompt.mdx:279` |
| R12 | `IdleStateUpdate` (also `Running`/`RequiresAction`) has an optional, nullable `_meta`. | MAY | `schema/v2/schema.json:4904`; extensibility `docs/protocol/v2/extensibility.mdx:8-10,39` |
| R13 | `IdleStateUpdate.usage` (type `Usage`: `totalTokens`, `inputTokens`, `outputTokens` required; `thought`/`cachedRead`/`cachedWrite` optional) is **unstable** and exists only in `schema.unstable.json`. | MAY (unstable) | `schema/v2/schema.unstable.json:6491` (`IdleStateUpdate`), `:6439` (`Usage`) |
| R14 | End-turn usage RFD (Draft): in v2 the same `usage` object that v1 put on `PromptResponse` goes on the idle update that ends foreground work. The RFD says the shape "is not ready for Preview". | RFD proposal | RFD `docs/rfds/end-turn-token-usage.mdx:35,55-80` |
| R15 | Migration guide: the v1 stop reason on the prompt response becomes the idle `state_update` `stopReason`. | stated mapping | `migration.mdx:12,236-237,313` |
| R16 | v2 `auth_required` exists only as a request error. Nothing maps it for work that has already been accepted. | not specified | `docs/protocol/v2/authentication.mdx:192-193,249-255` |
| T1 | TCK `ACP-STATE-202`: after `running` is seen, an idle update MUST arrive within the turn timeout. | TCK CAPABILITY (`capabilities.session`) | `acp-tck/src/tck/v2/requirements.py:228-240` |
| T2 | TCK `ACP-STATE-203`: the idle that ends an observed `running` carries a `stopReason` that is one of the five constants or starts with `_`. | TCK CAPABILITY | `requirements.py:242-258` |
| T3 | TCK `ACP-STATE-201`: an idle with a stop reason must have a `running` before it in the same turn. | TCK CAPABILITY | `requirements.py:210-226` |
| T4 | TCK `ACP-PROMPT-205`: every update validates against the vendored **stable** v2 schema. That schema has no `additionalProperties: false` anywhere. | TCK CAPABILITY | `requirements.py:160-180`; `src/tck/v2/validation.py:339-346`; `src/tck/v2/schema/VENDORED.md:22` |
| T5 | TCK `ACP-SCHEMA-002` (ADVISORY): no unknown root keys, checked only at the *root* of `params`/`result`. | ADVISORY | `requirements.py:1391-1403`; `conformance/test_extensibility.py:229-245` |

## Details

### Where codex-acp is today

- **`promptV2`** (`src/CodexAcpServer.ts:2965-3045`).
  - When `prompt()` succeeds, it sends `idle` with only `stopReason: response.stopReason` (`:3033`). The v1 `usage`/`_meta` are dropped.
  - When `prompt()` throws after insertion (`running !== null`), it only logs (`:3036-3039`). It clears `v2PromptsInFlight` (`:3036`), so the session accepts the next prompt without ever having sent `idle`.
- **v1 failure paths inside `prompt()`:**
  - **Clients without typed failures.** `createErrorEvent` sends the error text as an agent message chunk *and* stores a `RequestError` in `this.failure`, but only for `usageLimitExceeded` (→ `internalError(data)`) and auth errors (→ `authRequired` / `-32000` when auth is not configured, else `internalError`) (`src/CodexEventHandler.ts:1231-1240`). `prompt()` then throws it (`CodexAcpServer.ts:3219-3223, 3335-3338, 3438-3441`). Every other non-retried error becomes text plus `end_turn` on v1.
  - **Clients with typed failures** (`clientSupportsTypedSessionFailures`, `CodexAcpServer.ts:268-270`). The probe checks `clientCapabilities._meta.jetbrains.air.{version>=1, capabilities ∋ "sessionFailure"}` (`src/AirExtension.ts:47-61`). On v2 the AIR `_meta` is passed through unchanged (`src/AcpV2ClientCapabilities.ts:33-35`).
    - A `willRetry:false` error for the current turn is only *recorded*. It produces no session update: "the terminal failure is returned once on PromptResponse._meta rather than duplicated as a session update" (`CodexEventHandler.ts:1221-1225`).
    - `handleFailedTurn` records failed turns that have no error (`:366-386`).
    - `terminalFailurePromptResponse` returns `{stopReason:"end_turn", usage, _meta:{quota, jetbrains:{air:{version:1, sessionFailure:{id,revision,category,severity,title,actions}}}}}` (`CodexAcpServer.ts:3596-3614`; meta builder `CodexEventHandler.ts:1343-1354`).
    - Process exit and unexpected (non-`RequestError`) failures become a *synthetic* typed failure (`transport_lost` / `internal_error`) returned the same way instead of being thrown (`CodexAcpServer.ts:3481-3505`). Typed clients therefore only see a throw for other `RequestError`s.
  - **Every normal, cancelled or failed response** carries `usage: buildPromptUsage(lastTokenUsage)` and `_meta: {quota: {token_count, model_usage}}` (`:3476-3480`, `:3587-3593`, `:3616-3640`). `quota` sits at the root of `_meta`, not under the AIR namespace, and does not depend on any capability.
  - Retry warnings, and terminal failures that arrive after the prompt handler is disposed, *are* sent live as `session_info_update` with the AIR `_meta` (`CodexEventHandler.ts:302-327, 1356-1363`). They reach v2 unchanged (`src/AcpV2SessionUpdate.ts:23`).
- **So what v2 clients see today:**
  - *Clients without typed failures, on usage-limit or auth errors:* the text chunk exists, but v2 currently rejects `agent_message_chunk` (`AcpV2SessionUpdate.ts:66-78`, topic 6(a)). The error is logged and dropped. The client sees `running` and then nothing: no text and no `idle`.
  - *Typed-failure clients, on a terminal failure:* `idle{end_turn}` and nothing else. The failure record is lost.
  - *Codex process exit:* clients without typed failures get no `idle`. Typed clients get `idle{end_turn}` with no failure record.
- Post-insertion errors are real on the Codex side. A failing turn is observed as `turn/started` → userMessage item (inserted) → `error` ×N → `turn/completed failed` (`.agents/research/v2-codex-prompt-insertion-signal.md:126`). Usage-limit and auth errors arrive through the same `error` notification path (`CodexEventHandler.ts:1186-1240`). *Hypothesis, not live-verified:* they also arrive after the userMessage item.

### What the reference SDK does

- **Agent side** (`src/examples/dual-version-agent.ts`). The only v2 reference agent handles a non-abort error in the turn by rethrowing it (`:255-258`). The turn promise's `.catch` logs `"v2 example turn failed"` (`:139-141`), and `.finally` clears `session.turn` (`:142-146`). **No `idle` is sent.** An abort sends `idle/cancelled` (`:260-267`). This is the same thing codex-acp does today, and it conflicts with R4 (see Discrepancies). It has no error-text message, no custom stop reason and no notice.
- **Client side** (`src/v2/acp.ts:1680-1720, 2830-2850`). `ActiveSession` finishes a prompt turn only when it sees an idle `state_update`, and then queues a `stop` message carrying `notification`, `update` and `stopReason`. Without an idle, `nextUpdate()` never yields `stop`. The whole idle `update` object, including `_meta` and `usage`, reaches the client application.
- The SDK v2 types have `IdleStateUpdate.usage?: Usage | null` (marked `@experimental`) and `_meta` (`src/v2/schema/types.gen.ts:3968-3998`). The installed codex-acp copy is identical (`node_modules/@agentclientprotocol/sdk/dist/v2/schema/types.gen.d.ts:3670-3691`).

### Q1 options

| Option | Spec status | TCK | Client experience | Notes |
|---|---|---|---|---|
| (0) today: no `idle` | **violates R4 (MUST)** | fails `STATE-202` whenever it happens | SDK clients hang. The UI stays "running" while the agent takes new prompts. | Matches the SDK example agent, which is not normative. |
| **(a) error text as an agent message, then `idle/end_turn`** | allowed. Uses the "message + lifecycle primitive" from R10. | passes `STATE-201/202/203` | Any client shows the error text and a normal end of turn. | Same as v1 codex-acp for *every other* Codex error (text plus `end_turn`), and same as what v1 typed clients already get (`end_turn`). The error chunk needs a v2 `messageId`: mint a fresh one, since it is its own agent message. It depends on topic 6(a) making agent chunks render on v2. For process exit and local-command failures there is no chunk today, so one has to be built from the thrown error's message. |
| (b) `_`-prefixed stop reason (e.g. `_error`, `_codex_usage_limit`) | allowed (R6). The spec says only "when Clients can display a generic stopped state". | passes `STATE-203` | Generic clients show only "stopped". The *reason* text is lost unless (a) is also done. | Only useful when paired with (a), and only if some client will switch on it. That would be a new, unnamespaced extension contract. |
| (c1) `notice` | **forbidden as the carrier** (R9) | n/a (and `notice` is not in the stable schema, so it would be checked against the `other` branch) | may be ignored | Could be an *extra* toast next to (a), but the draft says it must not be relied on. |
| (c2) `refusal` | wrong meaning (R7). Codex keeps the user message in history. | passes | The client may drop the prompt from its view. | Not recommended. |
| (c3) some spec-defined error update | **none exists** (R11) | — | — | `error.mdx` is "Documentation coming soon" (`docs/protocol/v2/error.mdx:6`). |

**Recommended Q1 sequence** (my judgment within R4/R6/R8):
1. The error text is shown as an agent message. For usage-limit and auth errors it already exists, because `createErrorEvent` sends it before the throw. For process exit and local-command failures, send `agent_message_chunk{messageId:<new>, content:{type:"text", text: err.message}}`.
2. Then send `state_update {state:"idle", stopReason:"end_turn", usage?, _meta:{quota, …}}`. It must go after every other update for the turn, which R8 implies by analogy.
3. If the prompt was aborted or its session closed, `prompt()` already returns `cancelled` (`CodexAcpServer.ts:3483-3485`). That stays `idle/cancelled` (R8), not an error.
4. **User decision (optional):** mirror the v1 JSON-RPC error on idle `_meta` under a codex-acp namespace, e.g. `_meta.codex.promptError: {code, message, data}`, where `data` holds `codexErrorInfo`/`additionalDetails` from `createTurnErrorData`, `CodexEventHandler.ts:1392-1410`. This keeps the `-32000 auth_required` signal that a v1 client could act on (R16), which is otherwise lost on v2. The key name and namespace are a new contract. Option (b) could carry the same thing as a stop reason, but less expressively.

### Q2: idle carriers

On success, cancellation or typed failure, the v2 idle update should be exactly v1's `PromptResponse` without its outer frame:

```ts
{ state: "idle", stopReason: r.stopReason,
  ...(r.usage != null ? { usage: r.usage } : {}),   // unstable IdleStateUpdate.usage; same Usage shape as v1
  ...(r._meta != null ? { _meta: r._meta } : {}) }  // { quota, jetbrains?.air.sessionFailure }
```

The v1 and v2 `Usage` shapes are identical: `totalTokens`, `inputTokens`, `outputTokens` required; `thoughtTokens`, `cachedReadTokens`, `cachedWriteTokens` optional (`schema/v1/schema.unstable.json` `Usage`; v2 `schema.unstable.json:6439`).

Where the AIR typed terminal failure should go on v2:

| Option | Pros | Cons |
|---|---|---|
| **A. idle `_meta.jetbrains.air.sessionFailure`** (recommended) | 1:1 counterpart of v1 `PromptResponse._meta` (R15). Same "once" rule as `CodexEventHandler.ts:1221-1225`. No duplicate records. `_meta` is allowed on idle (R12). The SDK hands it to clients (`acp.ts:2835-2845`). Shape is already in the stable schema. | The AIR client must read `_meta` from the idle update on v2 (it already has to switch to idle to get `stopReason`). AIR contract change → user/AIR owner sign-off. |
| B. `session_info_update{_meta: AIR sessionFailure}` before `idle` | AIR clients already use this shape for retry warnings and session-scoped terminal failures (`CodexEventHandler.ts:302-327, 1356-1363`). Works without the client reading idle `_meta`. | Blurs "turn-terminal" versus "session-scoped" failures. `session_info_update` is meant for session metadata. Still needs an AIR decision on how the client ties it to the turn. |
| C. both A and B | Most robust for clients | Sends the same failure twice. `v2-codex-insertion-followups.md:112` (B2) already treats that duplication as a bug. |

`usage`: copy it. It is unstable on both v1 and v2, codex-acp already sends it on v1, and the RFD names idle as its v2 home (R14). It does not affect the TCK: the stable vendored schema has no `additionalProperties:false` (T4), and SCHEMA-002 checks only the root of `params` (T5).

`quota` (`_meta.quota`): copy it too. It is an unnamespaced root key in `_meta` in v1. Keep it for parity. Moving it under a namespace would be a separate decision.

## Testability notes

- **Q1, usage limit, client without typed failures** (Vitest, fake app-server, v2 connection).
  - Emit the userMessage item with the client id → `error{codexErrorInfo:"usageLimitExceeded", willRetry:false}` → `turn/completed{failed}`.
  - Snapshot the v2 transcript: `{messageId}` response, user chunks, `running`, agent message text with a `messageId` (after 6(a)), then `idle{stopReason:"end_turn"}`.
  - Also send a second prompt and assert it is accepted.
  - Non-conforming: the transcript ends at `running`.
  - The same shape works for the auth error with `authConfigured=false`, and for the optional `_meta` error mirror if that is chosen.
- **Q1, process exit:** make the fake app-server exit mid-turn. Assert an agent message containing "Codex process has exited" is followed by `idle`. For typed clients, assert `idle{end_turn}` with `_meta.jetbrains.air.sessionFailure.category` matching `transport_lost`'s policy.
- **Q1, local command failure:** make a local command handler throw. Assert text followed by `idle`.
- **Q2:** initialize v2 with `capabilities._meta.jetbrains.air = {version:1, capabilities:["sessionFailure"]}` and drive a terminal `error`. Assert:
  - idle `_meta.jetbrains.air.sessionFailure` is present, and so is `_meta.quota`;
  - `usage` is present when a `thread/tokenUsage/updated` event was sent;
  - there is **no** `session_info_update` carrying the same failure id (the once rule).
- Use `toMatchFileSnapshot()` and a placeholder for token counts.
- **TCK:** it cannot cause usage-limit or auth failures, so R4 on the failure path cannot be checked there. The TCK only checks the general invariants: `STATE-201/202/203` on the happy path and PROMPT-205 schema validity. Real behavior can be checked with `/run-codex`, e.g. a bad model for a failed turn (already observed in the insertion-signal research). Hitting a real usage limit may not be possible to reproduce on demand.

## Discrepancies

1. **Spec vs. SDK reference agent.** The spec says the agent MUST report `idle` when ready for a new prompt (`prompt-lifecycle.mdx:377`). The SDK's `dual-version-agent.ts:139-146, 255-258` logs a non-abort failure, frees the session for new prompts, and never sends `idle`. The SDK's own client helper (`acp.ts:2835-2845`) would then hang. The SDK agent is an example, not normative. codex-acp's current behavior matches the example and breaks the spec.
2. **Spec doc vs. schema on `stopReason`.** The doc says "MUST include the corresponding StopReason" (`prompt-lifecycle.mdx:377`). The schema says it is optional and "Agents SHOULD include this" (`schema.json:4904`). The TCK follows the MUST, limited to the idle that ends a `running` turn (`STATE-203`).
3. **`notice` capability.** In the v2 draft no client capability is required (`schema.unstable.json` `Notice` description). codex-acp's v1 gate `session.notices` (`src/SessionNotice.ts:3-6`) is forced on for v2 (`AcpV2ClientCapabilities.ts:17-19`). This is consistent, noted only because notices are *not* a valid Q1 carrier.
4. **`usage` stability.** `IdleStateUpdate.usage` is in the unstable schema and in SDK 1.5.0 types (marked `@experimental`), but not in the stable schema the TCK vendors. It is harmless there, since unknown properties are allowed, but it is not a stable contract.
5. **v1 `-32000 auth_required` has no v2 counterpart after insertion** (R16). The spec does not say how an already-accepted prompt should report an authentication failure.

## Open questions

- **User/AIR owner:** approve option A (AIR `sessionFailure` on idle `_meta` on v2). Decide whether an AIR version bump or a documented v2 placement note is needed (`docs/` or `readme-dev.md`).
- **User:** whether to add a machine-readable error on idle `_meta` for post-insertion failures (e.g. `_meta.codex.promptError{code,message,data}`), and/or a `_`-prefixed stop reason, especially to replace `auth_required`.
- **Topic 6(a) dependency:** the Q1 error text only reaches v2 clients once `agent_message_chunk` renders on v2 with a `messageId` (`AcpV2SessionUpdate.ts:66-78`). The error chunk from `createErrorEvent` (`CodexEventHandler.ts:1240`) is built without a `messageId` today.
- **Codex side (route elsewhere):** confirm live that `usageLimitExceeded` and auth `error`s arrive *after* the userMessage item (after insertion). If some arrive before it, those prompts could still be rejected with a JSON-RPC error on v2 (R1).
- Whether `quota` should stay an unnamespaced root key in `_meta` on v2 (extensibility only forbids custom *root fields*, not `_meta` keys; parity recommended).

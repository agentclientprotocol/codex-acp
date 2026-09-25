# P4(b): live checks against real Codex 0.156.1 (G-render, 3(b)/3(d), 10(f1), 10(f2))

**Sources checked:** codex-acp `eugenethedev/acp-v2` @ `85c21c7`. The build ran from a `git archive`
snapshot in `/tmp/p4live/snap`: `npm run build` → `dist/index.js`, with `node_modules` symlinked.
Product `src/` is identical to the working tree except two test files. Codex is `codex-cli 0.156.1`,
the repo's pinned native binary.
**Confidence:** high. Every verdict comes from real wire frames. D1 reproduced 2/2. The one-session
variant of D1 happened to win its race, by about 2 ms.

## Setup (no user config touched)
- **Isolated Codex home.** `CODEX_HOME=/tmp/p4live/codexhome` contains a minimal `config.toml` with the
  user's local `wire` provider (a local proxy, no secrets), `hooks`/`memories` off, and no MCP servers.
  Nothing under `~/.codex` was read-modified or written, so there was nothing to restore.
- **Codex tap.** `CODEX_PATH=/tmp/p4live/codex-tap.mjs` is a transparent tee around the real binary. It
  logs each app-server generation's JSON-RPC to `tap.jsonl`.
- **ACP client.** `/tmp/p4live/drive.mjs` is a raw newline-JSON-RPC client that spawns `dist/index.js`
  and logs every ACP frame to `acp.jsonl`. `merge.mjs` builds the timelines. Logs are in
  `/tmp/p4live/logs/<check>/`.
- **Mode and cleanup.** `INITIAL_AGENT_MODE=read-only` (on-request approvals, user reviewer). Every goal
  was cleared at the end. The approval target `~/.p4live-approval-probe` was never created.
- **Provider restart.** Check 3 used `providers/disable {providerId:"openai"}` with no override
  active. This forces a restart with the same effective config and is in-memory only
  (`CodexAcpClient.ts:472-495`).

## Verdicts
| # | Check | v2 | v1 |
|---|---|---|---|
| 1 | Auto goal turn after `session/new` | **PASS** | **PASS** |
| 2 | Cancel during a real command approval | **PASS** (plus a known intermediate `running`) | **PASS** |
| 3 | Provider restart with an active goal | **FAIL (D1: race)**, plus D2; adjacent pre-existing D3 | renders: **PASS**; D2 also applies |
| 4 | Resume with an active goal, fresh process | **PASS** (resume, and resume with `replayFrom:start`) | load: **PASS** |

### 1. G-render: auto goal turn after `session/new`
- **v2, `_session/goal set`** (`logs/c1-v2-goal`):
  - `thread/goal/set` → `turn/started` (+3 ms) → `state_update running`, then `agent_message_chunk`s
    and `turn/completed`.
  - The `_session/goal` response `{}` is sent 1 ms **before** `state_update idle end_turn`.
  - Exactly one `running` and one `idle`. There is no `user_message_chunk`; the update types seen were
    `session_info_update`, `usage_update`, `state_update`, and `agent_message_chunk`.
- **v2, `/goal …` as a prompt** (`logs/c1-v2-goalprompt`):
  - `user_message_chunk` echoes the prompt text itself. This is the client's own prompt, not a
    synthesized goal message.
  - The prompt response `{messageId}` comes back, then `running`, then goal content, then one
    `idle end_turn`.
- **v1** (`logs/c1-v1-goal`): the content renders (`GOALOK` chunks), and there are 0 `state_update`
  frames.
- **Observation (not a defect):** the ext-method response comes before `idle`. The spec says nothing
  about the order of an ext-method response relative to `state_update`.

### 2. 3(b)/3(d): cancel during a real approval
The prompt asked for an escalated `mkdir` outside the workspace. Codex sent
`item/commandExecution/requestApproval`.

- **v2, client waits for the agent's withdrawal** (`logs/c2-v2-withdraw`):
  ```
  4262 A>C state_update requires_action ; A>C req#0 session/request_permission
  5095 C>A session/cancel
  5096 A>C $/cancel_request {"requestId":0}          ; C>A resp#0 error -32800
  5096 A>C state_update running                       <- see note
  5096 Codex > turn/interrupt ; 5097 Codex > approval answer {"decision":"cancel"}
  5100 A>C tool_call_update failed ; Codex < turn/completed interrupted
  5101 A>C state_update idle stopReason:cancelled      (nothing after, 6 s watched)
  ```
- **v2, conforming client** that answers `cancelled` right after `session/cancel`
  (`logs/c2-v2-client`): the same sequence. The agent still sends `$/cancel_request` about 4 ms after
  the client's answer, which is benign. The flow ends with one `idle cancelled` and no later
  `running`. (The probe also answered the `$/cancel_request` a second time; that is a probe artifact.)
- **v1, both variants** (`logs/c2-v1-withdraw`, `logs/c2-v1-client`): `$/cancel_request` goes out,
  `turn/interrupt` is sent, and the prompt result has `stopReason:"cancelled"`.
- **Note:** on v2 the sequence is `requires_action` → `running` → `idle cancelled`. That `running`
  comes from the permission bracket closing. It is already known and pinned
  (`src/__tests__/CodexACPAgent/cancel-v2.test.ts:358-366`: "scoping that transition is a separate
  concern"). Live shows only one `running` here, not the two the mock test pins, because Codex
  answers the interrupt quickly.

### 3. 10(f2): provider restart with an active goal
Goal: three turns, each running `sleep 12` and then replying `STEP n`. `providers/disable` was sent
about 4 s into the second, unowned goal turn.

- **One session** (`logs/c3-v2-restart`): the intended sequence happened:
  - `running` (turn 2);
  - restart;
  - `idle cancelled`, at +2 ms after the new `thread/resume` response;
  - `running` (the new turn, +2 ms later);
  - content;
  - `idle end_turn`.

  It won by about 2 ms.
- **Two sessions: D1 reproduced.** Session A is the goal session. Session B is a second session,
  primed with one prompt so it has a rollout (`logs/c3c-v2-restart-2sessions-primed`; also seen in
  `logs/c3b-…`).
- **v1** (`logs/c3e-v1-restart`): the post-restart goal turn renders on the new app-server, and no
  `state_update` is sent.

#### D1 (v2, MUST-level state correctness): the close-out pass cancels the *new* goal turn instead of the cut-off one
Frames from `c3c` (ms from start; `cx0` is the old app-server, `cx1` the new one):
```
19808 A>C state_update running                       (unowned goal turn 2 on cx0)
23815 C>A providers/disable {"providerId":"openai"}
23861 cx0 exit 0
23935 cx1 > thread/resume A ; 23950 cx1 < resp thread/resume A
23953 cx1 < turn/started A turn 07d649 ; A>C state_update running      <- new turn, old never closed
23957 cx1 > thread/resume B ; 23966 cx1 < resp ; 23967 > model/list
23968 A>C state_update idle stopReason:cancelled                        <- lands on the NEW turn
23968 A>C resp providers/disable {}
25625.. cx1 turn 07d649 items; A>C agent_message_chunk / tool_call_update (content while "idle")
41395 A>C state_update idle stopReason:end_turn                         <- second idle for one running
```
Session A's full state stream was:

`running`, `idle end_turn` (turn 1), `running` (turn 2), **`running`** (new turn), **`idle cancelled`**, [content], **`idle end_turn`**.

The expected stream was:

… `running` (turn 2), `idle cancelled`, `running` (new turn), `idle end_turn`.

- **Cause.**
  - The tracker is registered before `replacement.resumeSession` (`src/CodexAcpServer.ts:1557`).
    Codex starts A's continuation turn about 3 ms after `thread/resume` returns.
    `trackCodexTurnStart` then overwrites `codexReportedRunningTurnId` with the new turn id and
    sends `running` (`:1096-1097`).
  - The close-out pass runs only after **every** session has been resumed (`:1583-1589`). It sees a
    non-null id and nulls it, then sends `idle cancelled`. At that point the id belongs to the live
    new turn. The same thing happens in the one-session case whenever `model/list` takes longer than
    Codex's roughly 3 ms continuation delay.
- **Side effects.**
  - During the new turn `codexReportedRunningTurnId` is `null`, so `isSessionBusy` is wrong. Approvals
    in that turn get no `requires_action`/`running` bracket (`:474-475`), and M2 steer adoption misses.
  - The turn's `turn/completed` still sends `idle` (`:1106-1117`), which produces the double `idle`.
- **Minimal repro.**
  1. On v2, `session/new` A, then `session/new` B, then one prompt on B.
  2. `_session/goal set` on A with a multi-turn objective.
  3. Once A's second turn sends `running`, send `providers/disable {providerId:"openai"}`.
- **Suspected location:** `src/CodexAcpServer.ts:1536-1589` (`enqueueProviderUpdate`, the
  resume loop followed by the close-out loop).
- **Fix sketch (not applied):** do the per-session drain and close-out **before** that session's
  tracker and `resumeSession`.
  - This is safe because `restartCodexClient` awaits the old process's exit (`:1643`), so
    `previousClient.waitForSessionNotifications` can run there.
  - The alternative is to snapshot the old `codexReportedRunningTurnId` before the resume and close
    out only if it is unchanged. That alone leaves the client seeing `running`, `running`, so the
    ordering fix is better.
- **Mock test.** Emit `turn/started` for the new client from the `thread/resume` or `model/list`
  override in `provider-restart-turn-tracking.test.ts` style. Assert
  `[running, idle cancelled, running, idle end_turn]`.

#### D2 (v1 + v2, lower severity): the cut-off turn's in-flight tool call is never finished
The cut-off turn's `sleep 12` tool call gets `tool_call_update in_progress` and no terminal status
afterwards. Examples: `exec-cf26bb1a…` in `c3`, `exec-24c515f5…` in `c3c`, `exec-f1a506fa…` in the v1
run `c3e`. Its `terminal_update` stream is also left open. This is because the old process's EOF drops
`item/completed`, and the close-out at `:1583-1589` only sends `idle`. Clients keep a spinner forever.
- **Suspected location:** the same close-out block. It could fail the leftover in-progress tool calls
  of the cut-off turn, the way an interrupted turn's items get `failed`. The state that tracks them
  lives in the old `CodexEventHandler` or subscription.

#### D3 (pre-existing on `main`, v1 + v2; adjacent, not 10(f2)): a never-prompted session breaks on provider restart
Repro (`logs/c3d-v2-restart-fresh`, `logs/c3d-v1-restart-fresh`): `session/new`, then
`providers/disable {providerId:"openai"}`, then `session/prompt` on the same session.

What happens:
- the new app-server answers `thread/resume` with `-32600 "no rollout found for thread id …"`;
- the fallback `thread/read` fails with "thread not loaded";
- `providers/disable` returns `-32603 {"details":"Failed to resume 1 session(s) after provider restart"}`;
- the next prompt fails with `-32603 "thread not found: <id>"`.

The session is dead. Codex persists a thread only after its first turn. The same resume loop is on
`main` (`git show main:src/CodexAcpServer.ts`, restart block around lines 1092-1107). Suspected
location: `src/CodexAcpServer.ts:1546-1574`. The likely scenario is that a client opens a session and
then configures a gateway before its first prompt.

### 4. 10(f1): resume with an active goal in a fresh process
Prep (`logs/c4-prep`): set a goal, then SIGKILL the app-server and the agent during the first goal turn.

- **v2 `session/resume`** (`logs/c4-v2-resume`):
  - `thread/resume` response at 136 ms, `turn/started` at 139 ms, then **`running` at 140 ms**, before
    any content;
  - content starts at +2.7 s;
  - `idle end_turn` at 17.2 s;
  - the next goal turn's `running` follows at once.

  There is no lone `idle`.
- **v2 `session/resume` with `replayFrom:{type:"start"}`** (`logs/c4-v2-replay`): all replayed history
  comes before the response. After the response come `running`, the live content, and `idle end_turn`.
- **v1 `session/load`** (`logs/c4-v1-load`): history is replayed before the response. The live goal
  turn renders after it.

## Other observations (not defects in codex-acp)
- **Goal turn after `thread/goal/clear`.** In `c3b` at 39416→39421, Codex started one more goal turn
  5 ms after `thread/goal/cleared`. The continuation was already scheduled. codex-acp rendered it
  correctly as `running` … `idle`.

## Open questions
- **D3 fix direction.** For a thread with no rollout, should the restart start a fresh thread, keep the
  session and lazily re-create the thread, or drop the session and tell the client? This needs a
  design decision and a researcher. It is out of scope for 10(f2).
- **Harmless custom `providers/set`.** It was not exercised. Only `disable` was used, and it has the
  same restart path.

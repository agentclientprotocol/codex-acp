# v2 agent-owned terminals: final `output` snapshot after streamed chunks, and what `terminal_update.command` should contain

**Sources checked:**
- ACP spec `agent-client-protocol` @ `5b45096edda805802cbcadc414848dbc0a228ada` (2026-09-24): `docs/protocol/v2/tool-calls.mdx`, `docs/protocol/v2/migration.mdx`, `docs/protocol/v2/prompt-lifecycle.mdx`, `docs/rfds/v2/terminal-output.mdx`, `schema/v2/schema.json`
- ACP TypeScript SDK `acp-typescript-sdk` @ `69fda3703bfb3a33d2f0e9fa6b90081270297d4c` (2026-09-23)
- ACP TCK `acp-tck` @ `5418887d4c56f007ca59ab344696a71db750f694` (2026-09-23)
- Codex `openai/codex` tag `rust-v0.156.1` (commit `b412ff32c417f855c2b2d1581b77058eed87c84b`), matching `@openai/codex` `^0.156.1` in `package.json:69` (installed `0.156.1`). This was a read-only sparse clone in `/tmp/codex-src`. The app-server README (tag and `main`) does not document delta caps, so the Codex claims below come from source.
- codex-acp working tree on `eugenethedev/acp-v2` (HEAD `e37457a`).

**Confidence:** high on what the spec says (the text is explicit and consistent across docs, RFD and schema). High on the Codex caps (read directly from 0.156.1 source). Medium on the recommendations, which are judgment calls: the spec allows either choice.

## Answer

**Q1.** The spec does not require a final `terminal_update.output` snapshot, and does not recommend one either. `output` is a patch field, so leaving it out means "unchanged" (`tool-calls.mdx:432-435`). A completion that sends only `exitStatus` is fully conformant. A snapshot fully replaces what the client has stored (clients MUST NOT merge, `tool-calls.mdx:441-445`). So a correct client never shows it twice. It can still erase or change streamed content if the snapshot bytes differ from what was streamed. The spec's stated purpose for snapshots is "replay, correction, and resynchronization" (RFD `terminal-output.mdx:115,176-178`; `migration.mdx:418,739`), not a required end-of-command marker. In Codex 0.156.1, `aggregatedOutput` and the streamed deltas differ in both directions:
- Live deltas stop after 10,000 frames per command, while the transcript keeps growing. The stream is then incomplete.
- `aggregatedOutput` is a 1 MiB head+tail buffer with a `... N bytes omitted ...` marker. Past 1 MiB, the stream is more complete than the snapshot.
- `aggregatedOutput` lacks codex-acp's synthetic stdin echo.
- On a failed unified-exec run, `aggregatedOutput` appends a failure message that was never streamed.

**Recommendation: keep the current behavior (no snapshot after streamed chunks).** Optionally add one narrow correction: send a snapshot from `item.aggregatedOutput` only when the command hit Codex's 10,000-delta cap. That is a judgment call and needs a user decision. Replay (`session/resume` history) already sends the full snapshot from `aggregatedOutput`, which covers the one case where the spec does call for snapshots.

**Q2.** The spec only says `command` "describes the command being run" (`tool-calls.mdx:437`). The RFD calls it "the human-readable command being run … descriptive" (`terminal-output.mdx:79`), and the schema says "The command being run." (`schema/v2/schema.json:5123-5124`). Nothing requires the exact argv or the shell wrapper. Today codex-acp is inconsistent:
- Single `unknown` command action: `rawInput.command` already has the wrapper removed by Codex.
- Zero actions or several known actions: it is Codex's `shlex_join(argv)` with the wrapper, e.g. `/bin/zsh -lc 'npm test'`.

**Recommendation (judgment call, not spec-mandated): use the stripped form, `stripShellPrefix(rawInput.command)`.** That is the same text as the tool-call `title` and the permission prompt's `rawInput.command`. The exact raw command stays available in the tool call's `rawInput.command`.

## Requirements

| # | Requirement | Tier | Citation |
|---|-------------|------|----------|
| R1 | `terminal_update` is an upsert keyed by `terminalId`. For non-key fields, omitted = unchanged, `null` = clear, a value = replace. | MUST (wire semantics, both sides) | agent-client-protocol `docs/protocol/v2/tool-calls.mdx:432-435`; `schema/v2/schema.json:5111` (`TerminalUpdate` description) |
| R2 | A concrete `output` snapshot replaces all stored bytes. Clients **MUST NOT** merge or splice the previous bytes into it. | MUST (client) | `tool-calls.mdx:441-445`; `migration.mdx:418`; RFD `terminal-output.mdx:81` |
| R3 | Chunks that arrive after a snapshot append to it ("Later chunks append to the replacement"). | MUST (client; stated in RFD and migration guide, implied by R2+R4 in stable docs) | RFD `terminal-output.mdx:81`; `migration.mdx:432` |
| R4 | Clients decode each `terminal_output_chunk.data` separately and append the bytes in the order received. They MUST NOT concatenate base64 strings before decoding. | MUST (client) | `tool-calls.mdx:469-476` |
| R5 | Send a final `output` snapshot at completion, or after streamed chunks. | **Not specified.** MAY at most: nothing requires or recommends it. | absence in `tool-calls.mdx:414-476`; purpose stated in RFD `terminal-output.mdx:115,176-178` |
| R6 | Replay: send terminal replacement snapshots instead of every historical chunk. | SHOULD-ish migration guidance (migration checklist, not normative MUST text) | `migration.mdx:739`; RFD `terminal-output.mdx:144` |
| R7 | Do not put two `terminal_update`/`terminal_output_chunk` for the same `terminalId` in one JSON-RPC batch when order matters. | MUST (agent), RFD only | RFD `terminal-output.mdx:113` |
| R8 | `command` describes the command being run. Agents SHOULD send it on the first update when applicable. | SHOULD (presence). Content: unspecified, "human-readable"/"descriptive" per RFD. | `tool-calls.mdx:437-438`; RFD `terminal-output.mdx:79`; `schema/v2/schema.json:5123-5124` |
| R9 | `cwd` MUST be absolute when supplied. | MUST | `tool-calls.mdx:439-440` (TCK ACP-PATCH-206) |
| R10 | Chunk and snapshot `data` are standalone RFC 4648 base64. | MUST | `tool-calls.mdx:441-442,469-470` (TCK ACP-PATCH-207) |

## Details

### Q1 — how snapshot and chunks interact on the client

The spec's client state model for one `terminalId`:
- `terminal_update` with `output: {data}` sets `bytes = decode(data)`. It is a full replacement with no merging (R2).
- `terminal_update` without `output` leaves the bytes unchanged. `exitStatus` only marks the terminal as exited (R1, `tool-calls.mdx:448`).
- `terminal_update` with `output: null` clears the bytes (R1).
- `terminal_output_chunk` sets `bytes = bytes ++ decode(data)` (R3, R4).

What follows for codex-acp:
- **Sending a final snapshot equal to the streamed bytes:** a conforming client ends up in the same state. There are no duplicates, but it costs one more full copy of the output on the wire (base64, so about 4/3 of the bytes).
- **Sending a final snapshot that differs from the streamed bytes:** the client must drop what it streamed and show the snapshot. With Codex's `aggregatedOutput` as the source, that can:
  - remove the stdin echo lines codex-acp adds (`\n${stdin}\n`, `src/CodexEventHandler.ts:1082-1089`), because Codex's transcript does not contain them;
  - swap a complete >1 MiB streamed transcript for a head+tail buffer with an omission marker;
  - add a failure message that was never streamed (failed unified exec);
  - restore bytes that stopped streaming at the delta cap (the one real benefit).
- **Non-conforming clients** that append a snapshot instead of replacing it would duplicate the output. The spec forbids this (R2), and the TS SDK does not help either way (below). This is a hypothesis about third-party clients; there is no upstream evidence of such clients.
- **Late-joining clients, resync and replay:** this is the snapshot's intended job (RFD `:115`, `:144`, `:176-178`; `migration.mdx:739`). codex-acp already covers replay. On history replay, `createCommandExecutionCompleteUpdate` puts `aggregatedOutput` and `terminal_exit` in the same update (`src/CodexToolCallMapper.ts:114-151`, called from `src/CodexAcpServer.ts:2457-2463`). The v2 fork turns output that arrives together with the exit into `terminal_update.output` (`src/AcpV2SessionUpdate.ts:181-190`). A live second client that joins mid-command, with no replay, would never get a snapshot. Whether codex-acp v2 supports several observers of one session is out of scope (see Open questions).

**TypeScript SDK:** there is no v2 client-side terminal state helper. v2 `terminal_update`/`terminal_output_chunk` appear only in generated files (`src/v2/schema/types.gen.ts:4135-4185`, `zod.gen.ts`, `guards.gen.ts`). The only terminal runtime code is the v1 Client-owned `TerminalHandle` (`src/acp.ts:2800-3062`), and `src/protocol-router.ts` has no conversion for terminal session updates. So the SDK gives no runtime evidence on accumulation. The spec text is the only authority.

**TCK:** it checks only `cwd` absoluteness and consistency (ACP-PATCH-206, `src/tck/v2/requirements.py:1201-1211`) and base64 validity (ACP-PATCH-207, `:1213-1222`). Nothing about snapshots at completion or the content of `command`.

### Q1 — Codex 0.156.1: when streamed deltas and `aggregatedOutput` differ

Unified exec is the default command path (`codex-rs/features/src/lib.rs:985-988`: `unified_exec`, `Stage::Stable`, `default_enabled: true`).

| Fact | Citation (openai/codex @ rust-v0.156.1) |
|------|------------------------------------------|
| Live deltas are capped at `MAX_EXEC_OUTPUT_DELTAS_PER_CALL = 10_000`. The comment says: "Aggregation still collects full output; only the live event stream is capped." | `codex-rs/core/src/exec.rs:83-85` |
| Unified exec uses that cap per process (`remaining_deltas: MAX_EXEC_OUTPUT_DELTAS_PER_CALL`). Each frame is ≤ 8192 bytes, split on UTF-8 boundaries. | `codex-rs/core/src/unified_exec/async_watcher.rs:36-42,75,251-300` |
| The transcript is pushed **before** the emit quota check, so after the cap bytes still reach the transcript but no deltas are sent. | `async_watcher.rs:265` (push) vs `:320` (`remaining_deltas.checked_sub(1) else return false`) |
| The transcript is a `HeadTailBuffer` with a 1 MiB cap (`UNIFIED_EXEC_OUTPUT_MAX_BYTES = 1024 * 1024`). It keeps 50% head and 50% tail and drops the middle. | `core/src/unified_exec/mod.rs:80`; `core/src/unified_exec/head_tail_buffer.rs:5-19` |
| `aggregatedOutput` = `from_utf8_lossy(transcript.to_bytes_with_omission_marker())`. The marker is `"... {n} bytes omitted ..."`. | `async_watcher.rs:468-478`; `head_tail_buffer.rs:106-111`; `unified_exec/mod.rs:231-233` |
| Failed unified exec: `aggregated_output = format!("{stdout}\n{message}")`, a failure message that was never streamed. | `async_watcher.rs:410-417` |
| Broadcast lag (`RecvError::Lagged`) skips a chunk for both the deltas and the transcript. A snapshot would not recover it. | `async_watcher.rs:125-127` (push happens only inside `Buffer::push`, `:265`) |
| Legacy (non-unified) shell tool: 10,000 deltas per stream (stdout and stderr each), raw 8192-byte reads with no UTF-8 boundary handling. Retained output is capped at `DEFAULT_OUTPUT_BYTES_CAP = 1 MiB`. | `core/src/exec.rs:74,81,271-278,1211-1236`; `codex-rs/utils/pty/src/lib.rs:22` |
| The app-server decodes each delta with `String::from_utf8_lossy` per chunk, which is safe for unified exec (boundary-aligned) and lossy at split code points for the legacy path. `aggregatedOutput` is decoded once as a whole. | `codex-rs/app-server-protocol/src/protocol/event_mapping.rs:436-446` |
| `aggregatedOutput` is `None` when empty. The completed item carries it as-is from `ExecCommandEnd`. | `codex-rs/app-server-protocol/src/protocol/item_builders.rs:116-138` |

So streamed bytes can be incomplete. A command that emits more than 10,000 PTY frames gets its live stream cut off, with no signal on the wire. With PTY reads this is realistic for about 10k lines of build or test log, even when the total size is well under 1 MiB. In that case `aggregatedOutput` has the full output if it is ≤ 1 MiB, or head+tail otherwise. Beyond 1 MiB, the streamed bytes (up to about 10,000 × 8 KiB) are more complete than `aggregatedOutput`.

Also relevant: on v2, codex-acp already sends the whole `aggregatedOutput` as text in the completion `tool_call_update.rawOutput.formatted_output`. This is because `terminalOutputDeltaSupported = false` on v2 (`src/CodexAcpServer.ts:391`; `src/CodexEventHandler.ts:1152-1157`; see `src/__tests__/CodexACPAgent/data/terminal-v2-streamed.json`). A client that wants Codex's final text already has it outside the terminal.

### Q1 — options

| Option | Spec | Effect on a conforming client | Cost / risk |
|--------|------|-------------------------------|-------------|
| A. **Keep** (current): after streamed chunks, completion = `terminal_update{exitStatus}` only. If nothing was streamed, `output` + `exitStatus` together. | Conformant (R1, R5) | Shows exactly what was streamed, including stdin echo. Silently incomplete past 10,000 deltas. | None. v1 parity. |
| B. **Always snapshot from `aggregatedOutput`** (prior research/architecture) | Conformant | Removes stdin echo. Replaces >1 MiB transcripts with head+marker+tail. Appends failure text. Fixes the delta-cap case. | Up to ~1.33 MiB extra per command. Changes the visible output in common cases (stdin echo) to fix a rare one. |
| C. **Always snapshot from codex-acp's own streamed bytes** | Conformant | No visible change. | Pure bandwidth cost with no benefit: replay already uses history, and codex-acp would need to buffer every terminal. |
| D. **Keep A, plus a correction snapshot from `aggregatedOutput` only when the item's `outputDelta` count reached 10,000** | Conformant; this is the "correction" use the RFD names (`:115`) | Fixes the capped case. In that case stdin echo is lost and >1 MiB output becomes head+tail. | Relies on a `pub(crate)` Codex constant (`exec.rs:85`) that is not exposed on the wire, so it is brittle across Codex upgrades. One counter per terminal item. |

**Recommendation: A, optionally D.** This is a judgment call; the spec mandates neither. The earlier "always send `terminal_update.output` at completion" line (`.agents/research/v2-tool-calls-messages-and-terminal-streaming.md:510-511,557`; `.agents/architecture.md:364`) was design advice. It was not a spec requirement and should be corrected. If D is adopted:
- Count only real `item/commandExecution/outputDelta` notifications with non-empty `delta`, not the synthetic `terminalInteraction` chunks. Codex only emits non-empty frames (`async_watcher.rs:322-330`).
- Treat `count >= 10000` as "possibly capped".
- Send the snapshot in the same `terminal_update` as `exitStatus`. This also follows R7: nothing separate to order.

### Q2 — what `command` should be

What the spec says (full list): "`command` describes the command being run. Agents **SHOULD** provide it on the first update when applicable." (`tool-calls.mdx:437-438`). The RFD adds: "the human-readable command being run … It is descriptive and does not ask the Client to execute anything." (`terminal-output.mdx:79`). The schema says "The command being run." (`schema/v2/schema.json:5123-5124`). The permission `CommandPermissionSubject.command` says "The command that would be run if permission is granted." (`schema/v2/schema.json:1950-1956`). None of these define argv fidelity, quoting, or wrappers.

What Codex sends (0.156.1):
- `ThreadItem.commandExecution.command` = `redact_secrets(shlex_join(argv))`, documented as "Shell-formatted command with recognizable secrets redacted". For model shell calls this includes the wrapper, e.g. `/bin/zsh -lc 'npm test'` (`codex-rs/app-server-protocol/src/protocol/item_builders.rs:47-61`).
- When any parsed action is `Unknown`, Codex collapses the actions into one `unknown` whose `cmd` is the script with the wrapper removed, via `extract_shell_command`, which handles bash/zsh/sh and PowerShell (`codex-rs/shell-command/src/parse_command.rs:40-42,54-83`). So Codex's own "human-readable" form is the unwrapped one.

What codex-acp sends today:
- The terminal path is taken when there is not exactly one action, or the single action is `unknown` (`src/CodexToolCallMapper.ts:611-614`).
- Single `unknown`: `rawInput.command = commandAction.command`, already unwrapped. `title = stripShellPrefix(...)` (`src/CodexToolCallMapper.ts:596-607`).
- Zero actions or ≥ 2 known actions (e.g. `ls && cat f`): `rawInput.command = item.command`, with the wrapper. `title = stripShellPrefix(item.command)` (`src/CodexToolCallMapper.ts:90-111`).
- `terminal_update.command = rawInput.command` (`src/AcpV2SessionUpdate.ts:171-175`). The terminal header therefore sometimes shows the wrapper and sometimes not, and can disagree with the tool-call title.
- Permission prompts already strip: `rawInput.command = stripShellPrefix(params.command)` (`src/permissions/presentation.ts:24-25`).
- History fallback: `rawInput.command` comes from `exec_command` args `cmd`, which is normally unwrapped (`src/ResponseItemHistoryFallback.ts:470-481`).

**Recommendation: stripped. This is a judgment call, not spec-mandated.** Set `terminal_update.command = stripShellPrefix(rawInput.command)`, which gives the same text as the tool-call `title` in both terminal paths. Reasons:
- The spec and RFD frame `command` as a human-readable description.
- Codex's own presentation unwraps it.
- It makes the terminal header match the title and the permission prompt.
- The exact executed form is still in `tool_call.rawInput.command`.

Keep the raw form only if you decide `command` should be byte-exact for copy-paste reproduction; the spec does not ask for that.

Caveat (hypothesis, not verified against the Rust `shlex` crate): `stripShellPrefix` (`src/CommandUtils.ts:1-7`) only matches `bash|zsh|sh` bare or under `/bin/`, and only removes one pair of outer single quotes. It does not undo `shlex_join` escaping of inner single quotes, and does not handle `/usr/bin/bash`, `/opt/homebrew/bin/zsh`, or PowerShell wrappers. For those inputs the result may still show the wrapper or escape residue. That is an existing title-quality issue shared with `title` (see Open questions).

## Testability notes

Everything below uses the existing harness in `src/__tests__/CodexACPAgent/terminal-v2.test.ts`: fake app-server notifications, then the v2 `session/update`s are decoded and file-snapshotted.

- **R1/R5 (keep, option A):** stream two `outputDelta`s plus a `terminalInteraction`, then complete. Assert that the final `terminal_update` has `exitStatus` and no `output` key. The current `data/terminal-v2-streamed.json` already covers this. Conforming client-side result: the concatenated decoded chunks equal the final display. A test can model this by adding a tiny reducer in the test that follows R1-R4 and snapshotting its end state: "what a conforming client shows".
- **Nothing streamed:** completion carries `output` = base64(`aggregatedOutput`) together with `exitStatus` in one update (`data/terminal-v2-snapshot.json`).
- **Option D, if adopted:** emit 10,000 non-empty deltas (generated in a loop), then complete with an `aggregatedOutput` that has extra tail text. Assert that exactly one `terminal_update` carries both `output` and `exitStatus`, and that the reducer's end state equals `aggregatedOutput`. Also check the negative case: 9,999 deltas give no `output`. Also check that `terminalInteraction` chunks do not count toward the threshold.
- **R7:** codex-acp sends each notification on its own, so there are no batches. Nothing to assert beyond "the snapshot and exit are in one update".
- **Q2:** use a `commandExecution` with `commandActions: []` and `command: "/bin/zsh -lc 'npm test'"`. Assert `terminal_update.command === "npm test"` and that it equals the tool call's `title`, while `rawInput.command` stays raw. Also test a single `unknown` action (already unwrapped; must stay unchanged).
- **Not observable in tests:** whether a real client replaces or appends on a snapshot, and whether Codex actually hit its delta cap. The cap is not on the wire and can only be inferred from the count. The TCK does not exercise either area (PATCH-206/207 only).

## Discrepancies

- **Internal docs vs spec:** `.agents/research/v2-tool-calls-messages-and-terminal-streaming.md:510-511,557` and `.agents/architecture.md:364` say to "always send `terminal_update.output` for the completion snapshot". The spec does not require it (R5). It is design advice, and from Codex's `aggregatedOutput` it would change the visible output (stdin echo, the 1 MiB head/tail, failure text). The 6(b) deviation is spec-conformant.
- **Stable doc vs RFD wording:** the stable `tool-calls.mdx` does not state "later chunks append to the replacement". The RFD (`terminal-output.mdx:81`) and `migration.mdx:432` do state it. They are consistent, not conflicting.
- **Spec vs TS SDK:** there is no conflict. The SDK has no v2 terminal runtime behavior at all, only generated types.
- **Codex vs ACP model:** Codex has two unrelated caps (10,000 delta frames vs 1 MiB head+tail retained), so neither the stream nor `aggregatedOutput` is a strict superset of the other. ACP assumes the agent has one authoritative byte sequence. codex-acp has to pick one, and there is no lossless choice past both caps.
- **codex-acp internal inconsistency:** `terminal_update.command` has the wrapper in some cases and not in others, and differs from `title` and the permission `rawInput.command` (Q2 details).

## Open questions

1. Does codex-acp v2 support several clients observing one live session, or `session/resume` without `replayFrom` in the middle of a command? If so, a client that joins mid-command gets chunks with no base snapshot. That would argue for sending a snapshot on attach, not at completion. Route this to the resume/replay topic.
2. Replay of a command that is still in progress when the session is resumed. `createCommandExecutionCompleteUpdate` returns `null` for `inProgress` (`src/CodexToolCallMapper.ts:118-120`), so no terminal output is replayed. Should a partial snapshot be sent?
3. `stripShellPrefix` robustness: non-`/bin/` shell paths, PowerShell, and `shlex_join` inner-quote escaping. This affects the titles too. Consider reusing Codex's unwrapped `unknown` action text, or porting `extract_shell_command` semantics.
4. Should the v2 `CommandPermissionSubject` (`schema/v2/schema.json:1950`), if adopted for command approvals, use the same stripped `command` as `terminal_update.command`, for consistency?
5. Codex never reports a signal (`exitStatus.signal` is always `null`). Timeouts show up as exit code 124 (`core/src/exec.rs:70`) or `-1` in the unified-exec failure path. This is out of scope and not investigated further.

# TCK v1 and v2 (targeted): after slice 6(a) (v2 `messageId` on agent chunks + `tool_call` upsert)

- Date: 2026-09-24
- codex-acp: commit `893a4a3`, `dist/index.js` rebuilt with `npm run build`. Agent/thought chunks now render on v2
  (item id, or a fresh UUID for one-off notices); `tool_call` is re-tagged to `tool_call_update`;
  `tool_call_update` passes through. Diff and terminal tool-call content still fail loud (6(c), 6(b)).
- acp-tck: `5418887`
- Scoped runs, so the verdict (NOT CONFORMANT, exit 1) is meaningless; read the targeted rows.
- Flags: `--timeout 90 --test-timeout 300`.

## v1 `-k test_prompt` (7 tests)

6 passed, 1 skipped (64 s). Matches the baseline; no regressions. (v1 has no tool-call test module.)

| Requirement       | Result  | Notes |
|-------------------|---------|-------|
| ACP-PROMPT-001    | PASS    | |
| ACP-PROMPT-002    | PASS    | |
| ACP-PROMPT-003    | PASS    | |
| ACP-PROMPTCAP-001 | PASS    | |
| ACP-PROMPTCAP-002 | SKIPPED | audio not advertised (known) |
| ACP-PROMPTCAP-003 | PASS    | |
| ACP-META-001      | PASS    | |

## v2 `-k "test_prompt or test_patches or test_enums"` (21 tests)

12 passed, 9 skipped (107 s), no failures.

| Requirement       | Result  | Notes |
|-------------------|---------|-------|
| ACP-PROMPT-201    | PASS    | |
| ACP-PROMPT-203    | PASS    | |
| ACP-PROMPT-205    | PASS    | now with agent chunks actually sent (previously passed only because they were dropped) |
| ACP-PROMPT-003    | PASS    | |
| ACP-PROMPTCAP-001 | PASS    | |
| ACP-PROMPTCAP-002 | SKIPPED | audio not advertised (known) |
| ACP-PROMPTCAP-003 | PASS    | |
| ACP-STATE-201     | PASS    | |
| ACP-STATE-202     | PASS    | |
| ACP-STATE-203     | PASS    | |
| ACP-PATCH-201     | PASS    | every message chunk carries a `messageId` |
| ACP-PATCH-203     | PASS    | |
| ACP-PATCH-204     | SKIPPED | the TCK's fixed prompt makes no tool call |
| ACP-PATCH-205     | SKIPPED | no `plan_update` in the turn |
| ACP-PATCH-206     | SKIPPED | no `terminal_update` (6(b)) |
| ACP-PATCH-207     | SKIPPED | no terminal output (6(b)) |
| ACP-PATCH-208     | SKIPPED | the TCK's fixed prompt makes no tool call |
| ACP-PATCH-209     | SKIPPED | no permission request (topic 4) |
| ACP-ENUM-201      | SKIPPED | no tool call / plan entries observed |
| ACP-ENUM-202      | PASS    | |
| ACP-ENUM-203      | SKIPPED | no permission request |

## Manual v2 probe with real tool calls

The TCK has no knob for a tool-using prompt, so a scratch v2 client (SDK 1.5.0, outside the repo) drove real Codex:

- `cat notes.txt` + `echo hi && ls`: both commands arrive as a titled `tool_call_update` create (`kind: read`),
  then `_meta.terminal_output_delta` updates and a completing `tool_call_update`. Agent chunks carry the Codex item
  id (`msg_…`), one id per message. No violations.
- `python3 -c 'print(6*7)'` (no recognized command action, so v1 reports terminal content): the create is dropped
  (fail loud, logged), but the output-delta and completion `tool_call_update`s still reach the client, so the client
  sees a tool call with no `title`. This would fail ACP-PATCH-208 (advisory) if the TCK observed such a command.
  Goes away with 6(b).

# TCK v1 and v2 (targeted): after slice 6(b) (v2 agent-owned terminal streaming)

- Date: 2026-09-24
- codex-acp: commit `2d25cac`, `dist/index.js` rebuilt with `npm run build`. On v2 the private terminal `_meta`
  keys on tool call updates are rendered as `terminal_update` / `terminal_output_chunk` (base64) and stripped;
  `terminal` tool call content passes through.
- acp-tck: `5418887`
- Scoped runs, so the verdict (NOT CONFORMANT, exit 1) is meaningless; read the targeted rows.
- Flags: `--timeout 90 --test-timeout 300`.

## v1 `-k test_prompt` (7 tests)

6 passed, 1 skipped (44 s). Matches the baseline; no regressions. ACP-PROMPTCAP-002 skipped (audio, known).

## v2 `-k "test_prompt or test_patches or test_enums"` (21 tests)

12 passed, 9 skipped (103 s), no failures. Same rows as after 6(a).

| Requirement   | Result  | Notes |
|---------------|---------|-------|
| ACP-PATCH-204 | SKIPPED | the TCK's fixed prompt makes no tool call |
| ACP-PATCH-206 | SKIPPED | still no `terminal_update`: the fixed prompt runs no command |
| ACP-PATCH-207 | SKIPPED | still no terminal output, same reason |
| ACP-PATCH-208 | SKIPPED | no tool call |
| ACP-ENUM-201  | SKIPPED | no tool call / plan entries observed |

All other targeted rows (PROMPT-201/203/205/003, PROMPTCAP-001/003, STATE-201/202/203, PATCH-201/203, ENUM-202)
PASS; PROMPTCAP-002, PATCH-205, PATCH-209, ENUM-203 SKIPPED as before.

## Manual v2 probe with real commands

The TCK has no knob for a command-running prompt, so a scratch v2 client (SDK 1.5.0, outside the repo) drove real
Codex with `for i in 1 2 3; do echo line$i; sleep 0.5; done` and then `python3 -c 'import sys; sys.exit(3)'`
(both generic shell commands, i.e. terminal content on v1). Per command the client got: `terminal_update{command,
cwd: /tmp/6b-probe/wd}` → titled `tool_call_update` create with `{type:"terminal"}` content → one
`terminal_output_chunk` per line (`bGluZTEK` = `line1\n`, …) → `terminal_update{exitStatus:{exitCode:0|3,
signal:null}}` → completing `tool_call_update` (`completed` / `failed`). The probe checked the PATCH-206/207/208
invariants itself: absolute cwd, set once per terminal, every payload valid base64, a title on each first
`tool_call_update`, no private terminal `_meta` keys. No problems found. The 6(a) title-less tool call is gone.

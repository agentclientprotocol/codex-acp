# TCK v1 (targeted): after slice 9b (plans, available commands and moot probes on v2)

- Date: 2026-09-24
- codex-acp: commit `55093c8` (`toV2SessionUpdate` renders `plan` and `available_commands_update`; the v2
  capability view marks plan/compaction/notices as supported; v1 path unchanged), `dist/index.js` rebuilt with
  `npm run build`
- acp-tck: `5418887`, protocol version 1
- Command: `HOW-TO-RUN.md` "Full v1 suite" plus `-k "test_prompt or test_session"` (prompt turns, which carry plan
  updates, and session lifecycle, which carries `available_commands_update` after `session/new`). The v1 TCK has no
  plan-specific test names.

## Result (scoped run, verdict not meaningful)

27 tests selected: 24 passed, 3 skipped, 29 deselected (102 s). 0 failures.

| Tier          | PASS | FAIL | SKIPPED | NOT_TESTED (deselected) |
|---------------|------|------|---------|-------------------------|
| MANDATORY     | 5    | 0    | 0       | 16                      |
| CAPABILITY    | 15   | 0    | 2       | 2                       |
| ADVISORY      | 4    | 0    | 1       | 7                       |
| INFORMATIONAL | 0    | 0    | 0       | 4                       |

Exercised rows:

- ACP-CONFIG-003: PASS
- ACP-PROMPT-001: PASS
- ACP-PROMPT-002: PASS
- ACP-SESSION-001: PASS
- ACP-SESSION-002: PASS
- ACP-ADDDIRS-001: PASS
- ACP-CLOSE-001: PASS
- ACP-CLOSE-002: SKIPPED
- ACP-CONFIG-001: PASS
- ACP-CONFIG-002: PASS
- ACP-DELETE-001: PASS
- ACP-LIST-001: PASS
- ACP-LIST-002: PASS
- ACP-LOAD-001: PASS
- ACP-LOAD-002: PASS
- ACP-MODES-001: PASS
- ACP-MODES-002: PASS
- ACP-PROMPTCAP-001: PASS
- ACP-PROMPTCAP-002: SKIPPED
- ACP-PROMPTCAP-003: PASS
- ACP-RESUME-001: PASS
- ACP-RESUME-002: PASS
- ACP-AUTH-005: SKIPPED
- ACP-DELETE-002: PASS
- ACP-LOAD-003: PASS
- ACP-META-001: PASS
- ACP-PROMPT-003: PASS

## Comparison with `1a-v1.md`

All 27 exercised rows match the 1a full v1 run (same PASS/SKIPPED status per requirement). The skips are the known
ones: ACP-AUTH-005 (agent advertises authMethods), ACP-PROMPTCAP-002 (audio not advertised), ACP-CLOSE-002
(timing-dependent). No regressions. v2 TCK skipped: `session/new` is not registered on v2 yet.

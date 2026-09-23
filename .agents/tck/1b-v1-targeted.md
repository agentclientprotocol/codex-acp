# TCK v1 (targeted): after slice 1b (version-aware `session/update` send point)

- Date: 2026-09-24
- codex-acp: commit `e9e898e` (`ACPSessionConnection.update()` routes through the v2 binding on v2 connections;
  v1 path unchanged), `dist/index.js` rebuilt with `npm run build`
- acp-tck: `5418887`, protocol version 1
- Command: `HOW-TO-RUN.md` "Full v1 suite" plus `-k "test_prompt or test_session or test_cancel"`
  (prompt turns, session lifecycle/config/capabilities, cancellation: every module that drives `session/update`)

## Result (scoped run, verdict not meaningful)

29 tests selected: 26 passed, 3 skipped, 27 deselected (111 s). 0 failures.

| Tier          | PASS | FAIL | SKIPPED | NOT_TESTED (deselected) |
|---------------|------|------|---------|-------------------------|
| MANDATORY     | 7    | 0    | 0       | 14                      |
| CAPABILITY    | 15   | 0    | 2       | 2                       |
| ADVISORY      | 4    | 0    | 1       | 7                       |
| INFORMATIONAL | 0    | 0    | 0       | 4                       |

Exercised rows:

- ACP-CANCEL-001: PASS
- ACP-CANCEL-002: PASS
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

All 29 exercised rows match the 1a full v1 run exactly (same PASS/SKIPPED status per requirement). The skips are the
same known ones: ACP-AUTH-005 (agent advertises authMethods), ACP-PROMPTCAP-002 (audio not advertised),
ACP-CLOSE-002 (timing-dependent). No regressions.

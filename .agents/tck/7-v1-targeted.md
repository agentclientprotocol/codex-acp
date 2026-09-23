# TCK v1 (targeted): after topic 7 (MCP server config accepts v1 and v2 shapes)

- Date: 2026-09-24
- codex-acp: commit `7f5a814` (MCP server entries normalized through `src/McpServerConfig.ts`; v1 output and
  rejections unchanged), `dist/index.js` rebuilt with `npm run build`
- acp-tck: `5418887`, protocol version 1
- Command: `HOW-TO-RUN.md` "Full v1 suite" plus `-k "test_session"` (test_session, test_session_config,
  test_session_capabilities: every v1 test that sends `mcpServers` through session/new, load, and resume)

## Result (scoped run, verdict not meaningful)

20 tests selected: 18 passed, 2 skipped, 36 deselected (61 s). 0 failures.

| Tier          | PASS | FAIL | SKIPPED | NOT_TESTED (deselected) |
|---------------|------|------|---------|-------------------------|
| MANDATORY     | 3    | 0    | 0       | 18                      |
| CAPABILITY    | 13   | 0    | 1       | 5                       |
| ADVISORY      | 2    | 0    | 1       | 9                       |
| INFORMATIONAL | 0    | 0    | 0       | 4                       |

Exercised rows:

- ACP-CONFIG-003: PASS
- ACP-SESSION-001: PASS
- ACP-SESSION-002: PASS
- ACP-ADDDIRS-001: PASS
- ACP-CLOSE-001: PASS
- ACP-CLOSE-002: SKIPPED (timing-dependent, known noise)
- ACP-CONFIG-001: PASS
- ACP-CONFIG-002: PASS
- ACP-DELETE-001: PASS
- ACP-LIST-001: PASS
- ACP-LIST-002: PASS
- ACP-LOAD-001: PASS
- ACP-LOAD-002: PASS
- ACP-MODES-001: PASS
- ACP-MODES-002: PASS
- ACP-RESUME-001: PASS
- ACP-RESUME-002: PASS
- ACP-AUTH-005: SKIPPED (agent advertises authMethods)
- ACP-DELETE-002: PASS
- ACP-LOAD-003: PASS

## Comparison with `1a-v1.md`

No regressions. Every session row that `1a-v1.md` passed still passes, and the results match `9a-v1-targeted.md`
row for row. The two skips (ACP-CLOSE-002, ACP-AUTH-005) are among 1a's five known skips. The v1 TCK sends only
empty `mcpServers`, so non-empty MCP conversion is covered by the Vitest suite, not the TCK. v2 TCK not run: it
needs v2 `session/new` (topic 5).

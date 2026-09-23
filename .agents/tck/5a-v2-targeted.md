# TCK v2 (targeted): after slice 5a (v2 session new/list/close/delete/resume)

- Date: 2026-09-24
- codex-acp: commit `9d22983`, `dist/index.js` rebuilt with `npm run build`. The v2 chain registers `initialize`,
  `session/new`, `session/list`, `session/close`, `session/delete`, `session/resume` (`replayFrom` absent/`null`
  only; `{type:"start"}` is temporarily rejected with `-32603`, other types with `-32602`), and
  `session/set_config_option`. `session/prompt` is not registered on v2 yet.
- acp-tck: `5418887`, `--protocol-version 2`
- Scoped runs, so the verdict (NOT CONFORMANT, exit 1) is meaningless; read the targeted rows.

## Run 1: `-k test_initialize` (7 of 103 tests)

7 passed.

| Requirement    | Result | Notes |
|----------------|--------|-------|
| ACP-INIT-001   | PASS   | |
| ACP-INIT-003   | PASS   | |
| ACP-INIT-201   | PASS   | |
| ACP-INIT-202   | PASS   | |
| ACP-INIT-203   | PASS   | |
| ACP-INIT-204   | PASS   | |
| ACP-SCHEMA-001 | PASS   | failed in `1a-v2-initialize.md` only because `session/new` was missing on v2; now passes |

## Run 2: `-k test_session` (26 of 103 tests: test_session, test_session_config, test_session_capabilities)

22 passed, 1 failed, 3 skipped (65 s).

| Tier          | PASS | FAIL | SKIPPED |
|---------------|------|------|---------|
| CAPABILITY    | 19   | 1    | 2       |
| ADVISORY      | 1    | 0    | 1       |
| INFORMATIONAL | 2    | 0    | 0       |

| Requirement     | Result  | Classification / notes |
|-----------------|---------|------------------------|
| ACP-SESSION-001 | PASS    | |
| ACP-SESSION-002 | PASS    | |
| ACP-SESSION-203 | PASS    | `mcpServers` omitted and `[]` are equivalent |
| ACP-ADDDIRS-201 | PASS    | |
| ACP-ADDDIRS-202 | PASS    | |
| ACP-CLOSE-201   | PASS    | |
| ACP-CONFIG-201  | PASS    | |
| ACP-CONFIG-202  | PASS    | |
| ACP-CONFIG-203  | PASS    | resume `configOptions` shape |
| ACP-CONFIG-204  | PASS    | |
| ACP-CONFIG-206  | PASS    | no `config_option_update` observed |
| ACP-DELETE-201  | PASS    | |
| ACP-DELETE-202  | SKIPPED | Expected, needs topic 2: the session is never prompted (no v2 `session/prompt`), so Codex never materializes it and `session/list` never reports it |
| ACP-DELETE-203  | PASS    | |
| ACP-LIST-201    | PASS    | |
| ACP-LIST-202    | PASS    | |
| ACP-LIST-203    | PASS    | 0 entries for the fresh cwd (same reason as DELETE-202) |
| ACP-LIST-204    | PASS    | |
| ACP-RESUME-201  | PASS    | |
| ACP-RESUME-202  | FAIL    | Expected, slice 5b (after topic 6): `replayFrom: {type:"start"}` is deliberately rejected with `-32603` "session/resume with replayFrom 'start' is not supported on an ACP v2 connection yet". The test's `_add_history` prompt also got `-32601` (topic 2) |
| ACP-RESUME-203  | PASS    | no history updates before the response (0 counted) |
| ACP-RESUME-204  | SKIPPED | Expected, needs topic 2 (+ 5b): `session/prompt` is `-32601`, so there is no `messageId` to check |
| ACP-RESUME-205  | PASS    | Vacuous: 0 replayed chunks because replay is rejected; recheck in 5b |
| ACP-AUTH-205    | SKIPPED | Known: agent advertises authMethods (same as v1 ACP-AUTH-005) |
| ACP-MCP-201     | PASS    | stdio MCP server accepted on `session/new` |
| ACP-MCP-202     | PASS    | http MCP server accepted on `session/new` |

No unexpected non-passes. ACP-CLOSE-202 lives in `test_cancel` and was not selected.

## Wire observations

- No `session/update` in either run hit a `toV2SessionUpdate` fail-loud case. After `session/new`/`session/resume`
  the agent sent only `available_commands_update` (v2 tagged `input`), `session_info_update` with `_meta.goal`
  (resume only), and the `_auth/status_update` extension notification.
- Agent stderr shows `Failed to publish available commands ...: Codex process has exited with code 0` in some
  tests. This is teardown noise: the TCK kills the process while the async publish is still in flight.

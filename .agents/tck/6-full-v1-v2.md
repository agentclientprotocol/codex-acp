# End of topic 6 — full TCK runs (v1 and v2)

Commit under test: 5aa5f0e (slice 6(d), `npm run build` bundle). Reports: `/tmp/acp-tck-reports/6d-v1.{txt,json}`,
`/tmp/acp-tck-reports/6d-v2.{txt,json}` (not committed).

## v1 (full, no `-k`)

`VERDICT: CONFORMANT`, exit 0. 50 passed / 1 failed / 5 skipped in 202 s — identical to the baseline.

- MANDATORY 21/0/0, CAPABILITY 15 pass / 4 skip, ADVISORY 10 pass / 1 fail / 1 skip, INFORMATIONAL 4/0/0.
- FAIL: ACP-SCHEMA-002 (pre-existing advisory: root-level `models` on `session/new`, `usage` on `session/prompt`).
- SKIPPED: AUTH-003/004/005 (no `--tck-auth-method` / advertises authMethods / no `--allow-logout`),
  PROMPTCAP-002 (audio not advertised), CLOSE-002 (turn finished before `session/close`; flips with PASS).

## v2 (full, no `-k`) — first full v2 baseline

`VERDICT: NOT CONFORMANT (3 mandatory failures, 6 capability failures)`, exit 1.
103 tests: 72 passed / 11 failed / 20 skipped in 997 s (the cancel tests wait out 90 s timeouts).

| Tier | PASS | FAIL | SKIP |
|------|------|------|------|
| MANDATORY | 15 | 3 | 1 |
| CAPABILITY | 33 | 6 | 12 |
| ADVISORY | 12 | 4 | 4 |
| INFORMATIONAL | 11 | 2 | 3 |

PASS: AUTH-201/202/206, BATCH-201/203, EXT-001/203, INIT-001/003/201/202/203/204, JSONRPC-002/004/005,
SCHEMA-001/002, TRANSPORT-002/201/203, ADDDIRS-201/202, CANCEL-208, CLIENTCAP-201/202, CLOSE-201/202,
CONFIG-201/202/203/204/206, DELETE-201/203, ENUM-202, ERROR-001, LIST-201/202/203/204, META-001/201,
PATCH-201/203, PROMPT-003/201/203/205, PROMPTCAP-001/003, RESUME-201/203/205, SESSION-001/002/203,
STATE-201/202/203, SHUTDOWN-001, INFO-BATCH-201/202, INFO-CANCEL-201, INFO-CONCURRENT-201,
INFO-INVALIDREQ-001, INFO-PARSE-001, INFO-UNKNOWNSESSION-001, MCP-201/202, STDERR-001.

### FAIL rows

| Requirement | Tier | Cause | Classification |
|-------------|------|-------|----------------|
| CANCEL-201, CANCEL-207 | CAPABILITY | idle after `session/cancel` has `stopReason: end_turn` | Expected — topic 3 (`session/cancel` on v2) |
| CANCEL-203, CANCEL-205, CANCEL-206 | CAPABILITY | turn never reaches a terminating idle within 90 s after cancel | Expected — topic 3 |
| CANCEL-204 | INFORMATIONAL | same test family, timed out | Expected — topic 3 |
| INFO-CANCEL-202 | INFORMATIONAL | cancel during pending permission request (record-only) | Expected — topics 3/4 |
| RESUME-202 | CAPABILITY | `session/resume` with `replayFrom: start` returns -32603 "not supported on an ACP v2 connection yet" | Expected — topic 5b |
| EXT-202 | ADVISORY | `capabilities.providers` is an unrecognized root key for the TCK (stable schema) | Known — `providers` is an unstable-schema capability (topic 1 placement decision); providers methods are topic 10 |
| BATCH-202, JSONRPC-003 | MANDATORY | after a notification-only batch the agent writes a line: the unsolicited `_auth/status_update` push scheduled right after `initialize` | Unexpected on v2 / needs a decision: it is an agent notification, not a response, but every "expect silence" probe sees it |
| EXT-201 | ADVISORY | same `_auth/status_update` push seen as a "response" to a custom notification | Same cause as BATCH-202 |
| BATCH-204, BATCH-205, JSONRPC-001 | ADVISORY / MANDATORY | `session/list` sent without `params` → -32602 "Invalid input: expected object, received undefined" (batch framing and id echo were fine) | Unexpected gap — omitted `params` for a request whose fields are all optional is rejected by the v2 parser |

### SKIPPED rows

| Requirement | Reason | Classification |
|-------------|--------|----------------|
| AUTH-203, AUTH-204 | no `--tck-auth-method` / no `--allow-logout` | Run configuration |
| AUTH-205 | agent advertises authMethods | N/A |
| AUTH-207 | no `type=="terminal"` auth method advertised | N/A |
| CANCEL-202 | prerequisite: turn did not end `cancelled` | Expected — topic 3 |
| DELETE-202 | `session/list` did not list a fresh, prompt-less session | Codex lists only persisted threads; no v1 counterpart |
| ENUM-201, PATCH-204, PATCH-205, PATCH-208 | TCK prompt produced no tool call / plan | TCK prompt content |
| PATCH-206, PATCH-207 | no terminal update (TCK prompt runs no command) | TCK prompt content |
| ENUM-203, PATCH-209, PERM-201 | no permission request observed | Expected — topic 4 |
| PROMPTCAP-002 | audio not advertised | N/A |
| RESUME-204 | retained user message not replayed | Expected — topic 5b |
| BATCH-206, BATCH-207, BATCH-208 | record-only | N/A |

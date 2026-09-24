# TCK fix — no-reply quiet-period checks ignore agent-initiated messages

TCK: `acp-tck` `main` @ `473a1b5` (fix `1997552`, self-tests `473a1b5`; base `5418887`).
codex-acp: `dist/index.js` as built at `6e27658` (not rebuilt, not changed).

TCK change: every "a notification gets no response" check now fails only on a reply (a JSON-RPC
object without `method`, bare or inside a batch). Agent notifications and agent -> client requests
in the quiet period are skipped, and requests are left unanswered. That covers v2 BATCH-202 (with the
batch half of JSONRPC-003), EXT-201, the single-message JSONRPC-003, the EXT-203 and INFO-CANCEL-201
probes, and v1 JSONRPC-003. codex-acp's `_auth/status_update` push after `initialize` is no longer
flagged.

## v2 `-k "test_batch or test_jsonrpc or test_extensibility"`

| Row | Before | After |
|-----|--------|-------|
| BATCH-201 | PASS | PASS |
| BATCH-202 | FAIL | **PASS** |
| BATCH-203 | PASS | PASS |
| BATCH-204 / 205 | FAIL | FAIL (expected: `session/list` with omitted `params` -> `-32602`) |
| JSONRPC-001 | FAIL | FAIL (same omitted-`params` cause) |
| JSONRPC-002 / 004 / 005 | PASS | PASS |
| JSONRPC-003 | FAIL | **PASS** |
| EXT-001 | PASS | PASS |
| EXT-201 | FAIL | **PASS** |
| EXT-202 | FAIL | FAIL (unrelated: `capabilities.providers` root key) |
| META-001 / 201, SCHEMA-002 | PASS | PASS |
| BATCH-206/207/208 | SKIPPED | SKIPPED (record-only) |
| EXT-203 (info) | "replied: `_auth/status_update` ..." | "silent (ignored)" |
| INFO-BATCH-201 / 202 (info) | unchanged | unchanged |

The push is still sent (EXT-203 recorded it before); it is now skipped rather than counted as a reply.

## v1 `-k "test_batch or test_jsonrpc or test_extensibility"`

Before and after identical: EXT-001, JSONRPC-001..005, META-001 PASS; SCHEMA-002 FAIL (advisory,
known `models`/`usage` root keys).

## v1 full suite (after)

50 passed, 1 failed, 5 skipped; `VERDICT: CONFORMANT`. Matches the baseline.
- FAIL: SCHEMA-002 (advisory, known).
- SKIPPED: AUTH-003, AUTH-004, AUTH-005 (no `--auth-method` / `--allow-logout`), CLOSE-002 (timing),
  PROMPTCAP-002 (audio not advertised).

## Known TCK limitation not fixed here

BATCH-203 (`_collect_flattened_responses`) and BATCH-204/205 read the first line(s) after a batch as
its reply without skipping agent notifications. A push that lands in that window would fail them
falsely. codex-acp's push currently arrives after those replies, so this does not show in these runs.

Raw reports: `/tmp/acp-tck-reports/qp-{before,after}-v{1,2}.{txt,json}`, `qp-after-v1-full.*`,
`qp-after-v2-batch.*`.

## Follow-up: reply-waiting checks skip agent-initiated messages

TCK: `acp-tck` `main` @ `e644ee7` (fix `b7cb958`, self-tests `e644ee7`). codex-acp `dist/index.js` not rebuilt.

The limitation above is fixed. New helpers `is_agent_initiated`/`next_reply_line` (v1, v2) skip a line only if it
is a JSON-RPC object with `method`, or (v2) a non-empty array made only of such objects (an agent's own notification
batch). Any other line, including a mixed or malformed array, is judged as before. Used by BATCH-201, BATCH-203
(`_collect_flattened_responses`), BATCH-204/205 (with JSONRPC-001/005 batch halves), INFO-BATCH-201/202 and
INFO-PARSE-001/INVALIDREQ-001 (v1 and v2).

### v2 `-k "test_batch or test_jsonrpc or test_extensibility"` (after)

Same as after `1997552`: BATCH-201/202/203, JSONRPC-002/003/004/005, EXT-001/201, META-001/201, SCHEMA-002 PASS.
BATCH-204/205 and JSONRPC-001 FAIL, still for `session/list` with omitted `params` -> `-32602 Invalid params`
("expected object, received undefined"). EXT-202 FAIL (`capabilities.providers` root key). BATCH-206/207/208 SKIPPED.
EXT-203 "silent (ignored)", INFO-BATCH-201 `-32700`.

### v1 full suite (after)

50 passed, 1 failed (SCHEMA-002, advisory), 5 skipped (AUTH-003/004/005, CLOSE-002, PROMPTCAP-002);
`VERDICT: CONFORMANT`, exit 0. Matches the baseline.

Raw reports: `/tmp/acp-tck-reports/rr-after-v2-batch.{txt,json}`, `rr-after-v1-full.{txt,json}`.

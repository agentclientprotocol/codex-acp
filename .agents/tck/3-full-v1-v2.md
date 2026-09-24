# End of topic 3 — full TCK runs (v1 and v2)

Commit under test: 08e97a8 (slice 3(d), `npm run build` bundle). Reports: `/tmp/acp-tck-reports/3-full-v1.{txt,json}`,
`/tmp/acp-tck-reports/3-full-v2.{txt,json}` (not committed).

## v1 (full, no `-k`)

`VERDICT: CONFORMANT`, exit 0. 50 passed / 1 failed / 5 skipped in 200 s — unchanged from the topic-6 baseline
(`6-full-v1-v2.md`).

- MANDATORY 21/0/0, CAPABILITY 15 pass / 4 skip, ADVISORY 10 pass / 1 fail / 1 skip, INFORMATIONAL 4/0/0.
- FAIL: ACP-SCHEMA-002 (pre-existing advisory: root-level `models` on `session/new`, `usage` on `session/prompt`) —
  same as baseline.
- SKIPPED: AUTH-003/004/005 (no `--tck-auth-method` / advertises authMethods / no `--allow-logout`),
  PROMPTCAP-002 (audio not advertised), CLOSE-002 (turn finished before `session/close`; flips with PASS, as
  documented) — same set as baseline.

No deltas vs. the topic-6 v1 run.

## v2 (full, no `-k`)

`VERDICT: NOT CONFORMANT (1 capability failure)`, exit 1. 103 tests: 81 passed / 2 failed / 20 skipped in 502 s (vs.
72/11/20 in the topic-6 baseline — 997 s, since the cancel tests no longer wait out the 90 s timeout).

| Tier | PASS | FAIL | SKIP |
|------|------|------|------|
| MANDATORY | 18 | 0 | 1 |
| CAPABILITY | 39 | 1 | 11 |
| ADVISORY | 15 | 1 | 4 |
| INFORMATIONAL | 12 | 0 | 4 |

All results match the expectations in `.agents/state.md`: every CANCEL-* row and INFO-CANCEL-202 now PASS
(CANCEL-204 SKIP, unobservable by design), and BATCH-202/BATCH-204/BATCH-205/JSONRPC-001/JSONRPC-003/EXT-201 all PASS
(fixed in earlier topics). No unexpected rows.

### FAIL rows (both expected, unchanged from baseline)

| Requirement | Tier | Cause | Classification |
|-------------|------|-------|----------------|
| RESUME-202 | CAPABILITY | `session/resume` with `replayFrom: start`: zero replayed updates before/after the response (conforming per R5's retention escape hatch, but the TCK records it as a fail pending real replay) | Expected — topic 5b, unchanged |
| EXT-202 | ADVISORY | `capabilities.providers` is an unrecognized root key for the TCK (stable schema expects vendor extensions under `capabilities._meta`) | Known — topic 1 placement decision; providers methods are topic 10, unchanged |

### Deltas vs. the topic-6 baseline (`6-full-v1-v2.md`)

| Requirement | Topic 6 | Topic 3 (now) | Note |
|-------------|---------|----------------|------|
| CANCEL-201, CANCEL-203, CANCEL-205, CANCEL-206, CANCEL-207 | FAIL | PASS | Fixed by topic 3 (a)/(b)/(c)/(d) |
| CANCEL-202 | SKIPPED | PASS | Turn now reaches `cancelled` |
| CANCEL-204 | FAIL (timed out) | SKIPPED | Now completes fast enough that the TCK marks it unobservable (documented as always-skip) rather than timing out |
| INFO-CANCEL-202 | FAIL (record-only cancel-during-permission) | PASS | Fixed by 3(d) (Q-PERM: per-prompt permission abort on cancel) |
| BATCH-202, JSONRPC-003 | FAIL (unsolicited `_auth/status_update` push mistaken for a response) | PASS | Fixed in an earlier topic (not topic 3) |
| EXT-201 | FAIL (same `_auth/status_update` cause) | PASS | Fixed in an earlier topic |
| BATCH-204, BATCH-205, JSONRPC-001 | FAIL (`session/list` without `params` rejected) | PASS | Fixed in an earlier topic |
| RESUME-202 | FAIL | FAIL | Unchanged — expected, topic 5b |
| EXT-202 | FAIL | FAIL | Unchanged — expected, known placement decision |

### SKIPPED rows

Same skip set and reasons as the topic-6 baseline, except CANCEL-204 (see delta table above): AUTH-203/204/205/207,
DELETE-202, ENUM-201/203, PATCH-204/205/206/207/208/209, PERM-201, PROMPTCAP-002, RESUME-204, BATCH-206/207/208.

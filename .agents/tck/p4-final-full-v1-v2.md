# P4 final verification — full TCK runs (v1 and v2)

Commit under test: `46ea4a1` (`npm run build` bundle), tip of `eugenethedev/acp-v2` at the time of this
run. acp-tck at `main` @ `b15c7bd` (same commit as the `10-full-v1-v2.md` baseline). Reports:
`/tmp/acp-tck-reports/v1.{txt,json}`, `/tmp/acp-tck-reports/v2.{txt,json}` (not committed).

Preceding this run: `npm run typecheck` clean, `npx vitest run` 978 passed / 26 skipped (matches
expected), `npm run build` succeeded (no `bun` on this machine; the esbuild-based `build.mjs` covers it).

## v1 (full, no `-k`)

`VERDICT: CONFORMANT`, exit 0. 50 passed / 1 failed / 5 skipped in 222.57 s.

- MANDATORY 21/0/0, CAPABILITY 15 pass / 4 skip, ADVISORY 10 pass / 1 fail / 1 skip, INFORMATIONAL 4/0/0.
- FAIL: ACP-SCHEMA-002 (pre-existing advisory noise: root-level `models` on `session/new`, `usage` on
  `session/prompt`).
- SKIPPED: AUTH-003/004/005 (no `--tck-auth-method` / advertises authMethods / no `--allow-logout`),
  PROMPTCAP-002 (audio not advertised), CLOSE-002 (turn finished before `session/close`; timing-flip).

## v2 (full, no `-k`)

`VERDICT: CONFORMANT`, exit 0. 84 passed / 0 failed / 19 skipped in 556.16 s.

- MANDATORY 18/0/1, CAPABILITY 41/0/10, ADVISORY 16/0/4, INFORMATIONAL 12/0/4.
- No FAIL rows. All 19 SKIPPED are the established run-configuration / "no tool call or permission
  request observed this turn" classes (auth flags not passed, no `--allow-logout`, TCK prompt produced
  no tool call/plan/terminal/permission event, `session/list` timing, batch record-only markers).

## Diff against baseline (`10-full-v1-v2.md`)

None. v1: 50/1/5 (identical, same FAIL and SKIP rows). v2: 84/0/19 (identical pass/fail/skip counts;
same 19 SKIPPED requirement IDs). No regressions observed; no re-run needed.

This was a verification-only pass at the end of the ACP v2 migration slice — no source changes were
made in this run.

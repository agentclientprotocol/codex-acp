# End of slice 10(f2) — full TCK runs (v1 and v2)

Commit under test: fix for provider-restart baseline tracker + unowned-turn close-out (`npm run build`
bundle). acp-tck at `main` @ `b15c7bd`. Reports: `/tmp/acp-tck-reports/v1.{txt,json}`,
`/tmp/acp-tck-reports/v2.{txt,json}` (not committed).

## v1 (full, no `-k`)

`VERDICT: CONFORMANT`, exit 0. 50 passed / 1 failed / 5 skipped in 207 s — identical to the established
baseline (see `6-full-v1-v2.md`).

- MANDATORY 21/0/0, CAPABILITY 15 pass / 4 skip, ADVISORY 10 pass / 1 fail / 1 skip, INFORMATIONAL 4/0/0.
- FAIL: ACP-SCHEMA-002 (pre-existing advisory noise: root-level `models` on `session/new`, `usage` on
  `session/prompt`; not affected by this slice).
- SKIPPED: AUTH-003/004/005 (no `--tck-auth-method` / advertises authMethods / no `--allow-logout`),
  PROMPTCAP-002 (audio not advertised), CLOSE-002 (turn finished before `session/close`; timing-flip).

## v2 (full, no `-k`)

`VERDICT: CONFORMANT`, exit 0. 84 passed / 0 failed / 19 skipped in 514 s.

- MANDATORY 18/0/1, CAPABILITY 41/0/10, ADVISORY 16/0/4, INFORMATIONAL 12/0/4.
- No FAIL rows. All 19 SKIPPED are the established run-configuration / "no tool call or permission
  request observed this turn" classes (auth flags not passed, no `--allow-logout`, TCK prompt produced
  no tool call/plan/terminal/permission event, `session/list` timing, batch record-only markers) — none
  are new or related to provider restarts.

This slice touches only the provider-restart path (`providers/set`/`providers/disable`), which the TCK's
fixed test prompts never exercise directly; the full-suite run here is a regression check, not a targeted
probe of the fix. Both verdicts match the pre-slice baselines exactly (v1: 50/1/5, v2: 84/0/19).

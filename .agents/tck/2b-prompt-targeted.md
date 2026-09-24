# TCK v1 and v2 (targeted): after slice 2(b) (v2 `state_update` running/idle)

- Date: 2026-09-24
- codex-acp: commit `9da450e`, `dist/index.js` rebuilt with `npm run build`. v2 `promptV2` now sends
  `state_update` `running` after insertion and one `idle` with the v1 stop reason at turn end. Agent/thought chunks
  still fail loud on v2 (6(a)).
- acp-tck: `5418887`
- Scoped runs, so the verdict (NOT CONFORMANT, exit 1) is meaningless; read the targeted rows.
- Flags: `--timeout 90 --test-timeout 300`.

## v1 `-k test_prompt` (7 tests)

6 passed, 1 skipped (39 s). Matches the baseline; no regressions.

| Requirement       | Result  | Notes |
|-------------------|---------|-------|
| ACP-PROMPT-001    | PASS    | |
| ACP-PROMPT-002    | PASS    | |
| ACP-PROMPT-003    | PASS    | |
| ACP-PROMPTCAP-001 | PASS    | |
| ACP-PROMPTCAP-002 | SKIPPED | audio not advertised (known) |
| ACP-PROMPTCAP-003 | PASS    | |
| ACP-META-001      | PASS    | |

## v2 `-k test_prompt` (10 tests)

9 passed, 1 skipped (57 s). Previously (2(a1)) 9 failed, all timing out waiting for idle.

| Requirement       | Result  | Notes |
|-------------------|---------|-------|
| ACP-PROMPT-201    | PASS    | |
| ACP-PROMPT-203    | PASS    | |
| ACP-PROMPT-205    | PASS    | passes because the agent chunks that lack `messageId` are dropped (fail loud) instead of sent; recheck after 6(a) |
| ACP-PROMPT-003    | PASS    | |
| ACP-PROMPTCAP-001 | PASS    | |
| ACP-PROMPTCAP-002 | SKIPPED | audio not advertised (known) |
| ACP-PROMPTCAP-003 | PASS    | |
| ACP-STATE-201     | PASS    | |
| ACP-STATE-202     | PASS    | |
| ACP-STATE-203     | PASS    | |

The assistant's text is still not visible to a v2 client (agent chunks dropped until 6(a)); the TCK prompt rows don't
check agent output content.

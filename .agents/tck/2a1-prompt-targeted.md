# TCK v1 and v2 (targeted): after slice 2(a1) (v2 `session/prompt`, idle case)

- Date: 2026-09-24
- codex-acp: commit `99f13e7`, `dist/index.js` rebuilt with `npm run build`. The v2 chain now registers
  `session/prompt` → `promptV2`: `{messageId}` + `user_message_chunk` at the matching `userMessage` item; no
  `state_update` yet (2(b)); agent/thought chunks still fail loud on v2 (6(a)).
- acp-tck: `5418887`
- Scoped runs, so the verdict (NOT CONFORMANT, exit 1) is meaningless; read the targeted rows.

## v1 `-k test_prompt` (7 tests: test_prompt, test_prompt_capabilities)

6 passed, 1 skipped (61 s). Matches the 9b baseline; no regressions.

| Requirement       | Result  | Notes |
|-------------------|---------|-------|
| ACP-PROMPT-001    | PASS    | |
| ACP-PROMPT-002    | PASS    | |
| ACP-PROMPT-003    | PASS    | |
| ACP-PROMPTCAP-001 | PASS    | |
| ACP-PROMPTCAP-002 | SKIPPED | audio not advertised (known) |
| ACP-PROMPTCAP-003 | PASS    | |
| ACP-META-001      | PASS    | |

## v2 `-k test_prompt` (10 tests), `--timeout 60 --test-timeout 120`

9 failed, 1 skipped (563 s). All failures are the expected timeout: the TCK's `run_prompt` waits for an idle
`state_update`, which codex-acp does not send until 2(b).

| Requirement       | Result  | Notes |
|-------------------|---------|-------|
| ACP-PROMPT-201    | FAIL    | timeout waiting for idle. Transcript shows the right shape: `result: {messageId}` ~0.4 s after the request, after Codex recorded the user message |
| ACP-PROMPT-203    | FAIL    | timeout waiting for idle. Transcript shows `user_message_chunk` with the same `messageId`, sent just before the response |
| ACP-PROMPT-205    | FAIL    | timeout waiting for idle |
| ACP-PROMPT-003    | FAIL    | timeout waiting for idle |
| ACP-PROMPTCAP-001 | FAIL    | timeout waiting for idle. Image prompt accepted: two `user_message_chunk`s (text, image) + `{messageId}` |
| ACP-PROMPTCAP-002 | SKIPPED | audio not advertised (known) |
| ACP-PROMPTCAP-003 | FAIL    | timeout waiting for idle |
| ACP-STATE-201/202/203 | FAIL | no `state_update` yet (2(b)) |

In every run the turn itself finished on the Codex side (`session_info_update` threadStatus `idle`, title updates).
The agent's `agent_message_chunk`s are dropped with a logged fail-loud error on v2 (6(a)); they do not wedge the turn.
Expected to pass once 2(b) (`state_update`) and 6(a) (agent chunk `messageId`) land.

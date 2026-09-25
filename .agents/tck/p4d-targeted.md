# P4(d): targeted TCK checks (D2 fix)

Verifies the D2 fix (provider restart now fails any tool call left `in_progress` by a cut-off
turn, and ends its terminal, before the turn's own idle/cancelled close-out) does not regress
session/state conformance. codex-acp `eugenethedev/acp-v2`, built via `npm run build`
(`dist/index.js`). acp-tck `main` @ same revision as P4(c).

## v2, `-k "test_session or test_state"`

```
uv --project /Users/eugene/Documents/JetBrains/projects/acp-tck run acp-tck \
  --protocol-version 2 --agent-cwd /tmp/acp-tck-wd --timeout 90 --test-timeout 300 \
  -k "test_session or test_state" \
  -- node /Users/eugene/Documents/JetBrains/projects/codex-acp/dist/index.js
```

24 passed, 2 skipped, 0 failed (77 deselected by `-k`, scoped run so `VERDICT: NOT CONFORMANT` is
expected/ignorable per `HOW-TO-RUN.md`). Matches the P4(c) baseline exactly. Skips are both
known/unrelated: `AUTH-205` (agent advertises `authMethods`) and `session/list` (session not
reported, `test_session_capabilities.py`).

## v1, `-k test_session`

```
uv --project /Users/eugene/Documents/JetBrains/projects/acp-tck run acp-tck \
  --agent-cwd /tmp/acp-tck-wd --timeout 90 --test-timeout 300 \
  -k test_session \
  -- node /Users/eugene/Documents/JetBrains/projects/codex-acp/dist/index.js
```

18 passed, 2 skipped, 0 failed (36 deselected, scoped). Matches the P4(c) baseline exactly. Skips
are known/unrelated: `AUTH-A1` and `ACP-CLOSE-002`/close-cancellation timing
(`test_session_capabilities.py`).

No fails in either run; no regressions from the D2 fix.

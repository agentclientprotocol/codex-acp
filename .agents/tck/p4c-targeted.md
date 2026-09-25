# P4(c): targeted TCK checks (D1 fix)

Verifies the D1 fix (`enqueueProviderUpdate`'s restart close-out now runs per session, before that
session's tracker/`resumeSession`, instead of after every session has been resumed) does not
regress session/state conformance. codex-acp `eugenethedev/acp-v2`, built via `npm run build`
(`dist/index.js`). acp-tck `main` @ `b15c7bd`.

## v2, `-k "test_session or test_state"`

```
uv --project /Users/eugene/Documents/JetBrains/projects/acp-tck run acp-tck \
  --protocol-version 2 --agent-cwd /tmp/acp-tck-wd --timeout 90 --test-timeout 300 \
  -k "test_session or test_state" \
  -- node /Users/eugene/Documents/JetBrains/projects/codex-acp/dist/index.js
```

24 passed, 2 skipped, 0 failed (77 deselected by `-k`, scoped run so `VERDICT: NOT CONFORMANT` is
expected/ignorable per `HOW-TO-RUN.md`). Skips are both known/unrelated: `AUTH-205` (agent
advertises `authMethods`) and `session/list` (session not reported, `test_session_capabilities.py`).

## v1, `-k test_session`

```
uv --project /Users/eugene/Documents/JetBrains/projects/acp-tck run acp-tck \
  --agent-cwd /tmp/acp-tck-wd --timeout 90 --test-timeout 300 \
  -k test_session \
  -- node /Users/eugene/Documents/JetBrains/projects/codex-acp/dist/index.js
```

18 passed, 2 skipped, 0 failed (36 deselected, scoped). Skips are known/unrelated: `AUTH-A1` and
`ACP-CLOSE-002`/close-cancellation timing (`test_session_capabilities.py`).

No fails in either run.

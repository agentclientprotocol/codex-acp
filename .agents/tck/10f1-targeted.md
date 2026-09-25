# 10(f1) targeted TCK run

Fix: register the baseline turn tracker (`startCodexTurnTracker`) before `thread/resume`/
`thread/load` is sent, so a Codex-initiated goal turn firing during resume/load setup is no
longer silently dropped. Affects v1 `session/resume`/`session/load` and v2 `session/resume`
(with and without `replayFrom`).

Ran against the built bundle (`npm run build`, `dist/index.js`), per `.agents/tck/HOW-TO-RUN.md`.

## v1: `-k test_session`

```
18 passed, 2 skipped, 36 deselected in 74.64s
```

No failures. Both skips are pre-existing/expected (`AUTH-A1` empty-auth-methods case not
applicable; `ACP-CLOSE-002` timing-dependent, prompt turn finished before `session/close`).
Scoped run reports `VERDICT: NOT CONFORMANT` only because deselected requirements count as
`NOT TESTED` — expected for a `-k` scoped run per the how-to doc.

## v2: `-k "test_session or test_resume or test_state"`

```
24 passed, 2 skipped, 77 deselected in 136.65s
```

No failures. Skips are the same pre-existing/expected cases as v1 (`AUTH-205` empty-auth-methods;
a `session/list` capability skip unrelated to this fix). `ACP-RESUME-201..205` and `ACP-SESSION-*`
all pass, consistent with the fix's target behavior.

## Anomalies

None. No failures in either run.

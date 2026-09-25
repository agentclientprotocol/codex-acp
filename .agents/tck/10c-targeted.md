# TCK targeted run: slice 10(c), `_session/async_task/stop` on ACP v2

Registered `_session/async_task/stop` (`ASYNC_TASK_STOP_METHOD`) on the v2 chain in
`AcpAgentRouter.ts`, reusing the v1 zod parser (`asyncTaskStopParamsParser`) and `extMethod`
delegate unchanged. Ran against `dist/index.js` (`npm run build`) per `.agents/tck/HOW-TO-RUN.md`,
acp-tck @ `b15c7bd` (`main`).

All runs are scoped (`-k`), so `VERDICT: NOT CONFORMANT` / exit 1 is expected (deselected
requirements count as NOT TESTED). Only PASS/FAIL/SKIPPED rows for the targeted requirements
matter here; no `_session/async_task/stop`-specific requirement exists in the TCK (topic 10
research already noted this -- the method's advertising is via the shared AIR `asyncTasks`
capability list, which was unchanged by this slice).

## v1, `-k "test_initialize or test_extensibility"`

`1 failed, 7 passed, 48 deselected`. The 1 fail is the pre-existing, documented `ACP-SCHEMA-002`
advisory noise (`session/new`'s root-level `models` key / `session/prompt`'s root-level `usage`
key not in the vendored v1 schema) -- unrelated to this change, listed in HOW-TO-RUN.md's "Known
noise". No other fails. Matches the 10(b) baseline exactly.

## v2, `-k "test_initialize or test_extensibility"`

`14 passed, 89 deselected`. No fails. Matches the 10(b) baseline exactly, confirming the new
registration introduces no regression in initialize/extensibility conformance.

## Conclusion

No regressions from registering `_session/async_task/stop` on v2. The TCK has no direct coverage
for the extension method itself; correctness there is pinned by the new Vitest suite
(`src/__tests__/CodexACPAgent/async-task-stop-v2.test.ts`).

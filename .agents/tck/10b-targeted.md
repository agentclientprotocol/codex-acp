# TCK targeted run: slice 10(b), `_session/goal` on ACP v2

Registered `_session/goal` (`GOAL_CONTROL_METHOD`) on the v2 chain in `AcpAgentRouter.ts`, reusing
the v1 zod parser and `extMethod` delegate unchanged. Ran against `dist/index.js` (`npm run build`)
per `.agents/tck/HOW-TO-RUN.md`, acp-tck @ `b15c7bd` (`main`).

All runs are scoped (`-k`), so `VERDICT: NOT CONFORMANT` / exit 1 is expected (deselected
requirements count as NOT TESTED). Only PASS/FAIL/SKIPPED rows for the targeted requirements
matter here; no `_session/goal`-specific requirement exists in the TCK (topic 10 research already
noted this).

## v1, `-k "test_initialize or test_extensibility"`

`1 failed, 7 passed, 48 deselected`. The 1 fail is the pre-existing, documented
`ACP-SCHEMA-002` noise (`session/new`'s root-level `models` key / `session/prompt`'s `usage` key
not in the vendored v1 schema) -- unrelated to this change, listed in HOW-TO-RUN.md's "Known
noise". No other fails.

## v2, `-k "test_initialize or test_extensibility"`

`14 passed, 89 deselected`. No fails. `ACP-SCHEMA-002` and `ACP-EXT-202` both PASS on v2 (topic 10
research: the v2 TCK vendors the unstable schema differently and this row was already expected to
pass).

## v2, `-k "test_state or test_prompt"`

`9 passed, 1 skipped, 93 deselected`. No fails. The 1 skip
(`ACP-PROMPTCAP-002`/`test_prompt_capabilities.py:68`) is unrelated: `capabilities.session.prompt.audio`
isn't advertised. `ACP-STATE-201/202/203` and `ACP-PROMPT-201/203/205`/`ACP-PROMPTCAP-001/003`/
`ACP-PROMPT-003` all PASS, confirming the v2 baseline turn tracker's `running`/`idle` framing
(exercised by the ordinary prompt path) is unaffected by adding the goal registration.

## Conclusion

No regressions from registering `_session/goal` on v2. The TCK has no direct coverage for the
extension method itself; correctness there is pinned by the new Vitest suite
(`src/__tests__/CodexACPAgent/session-goal-v2.test.ts`).

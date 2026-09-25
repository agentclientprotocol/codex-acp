# TCK targeted run: slice 10(d), `session/fork` on ACP v2

Registered `session/fork` on the v2 chain in `AcpAgentRouter.ts`
(`acpV2.methods.agent.session.fork`), backed by a new `forkSessionV2` in `CodexAcpServer.ts` that
reuses v1's `forkSession` and drops `modes` from the response, adding v2-shaped `configOptions` via
`createSessionConfigOptionsResponseV2` (same pattern as `resumeSessionV2`/`newSessionV2`). No
replay, no `available_commands_update` (parity with v1, unchanged shared logic). Ran against
`dist/index.js` (`npm run build`) per `.agents/tck/HOW-TO-RUN.md`, acp-tck @ `b15c7bd` (`main`).

All runs are scoped (`-k`), so `VERDICT: NOT CONFORMANT` / exit 1 is expected (deselected
requirements count as NOT TESTED). Only PASS/FAIL/SKIPPED rows for the targeted requirements
matter here.

## v1, `-k test_session`

`18 passed, 2 skipped, 36 deselected`. No fails. The 2 skips are the documented,
timing/capability-dependent skips (`ACP-AUTH-A1`/authMethods, `ACP-CLOSE`/cancellation timing) --
unrelated to this change.

## v2, `-k test_session`

`24 passed, 2 skipped, 77 deselected`. No fails. `ACP-RESUME-*`, `ACP-SESSION-*`, `ACP-LIST-*`,
`ACP-CONFIG-*`, `ACP-DELETE-*`, `ACP-CLOSE-201`, `ACP-ADDDIRS-*`, `ACP-MCP-*` all PASS. The TCK has
no fork-specific requirement ID of its own (fork isn't separately exercised by name), so
`session/fork` correctness is pinned by the new Vitest suite
(`src/__tests__/CodexACPAgent/session-lifecycle-v2.test.ts`), not by a TCK requirement.

## v2, `-k "test_initialize or test_extensibility"`

`14 passed, 89 deselected`. No fails. `ACP-EXT-201`, `ACP-EXT-202`, `ACP-META-001`,
`ACP-META-201`, `ACP-SCHEMA-002` all PASS -- unchanged from the 10(c) baseline, confirming the new
registration introduces no regression in initialize/extensibility conformance.

## Known noise (v1 full suite only, not hit here)

`ACP-SCHEMA-002` (ADVISORY) fails on the v1 full suite due to pre-existing root-level `models`/
`usage` keys; not exercised in this targeted run (it's a v2-only PASS here because the v2 vendored
schema does include the equivalent fields).

## Conclusion

No regressions from registering `session/fork` on v2. `modes` is dropped and `configOptions` is
v2-shaped only on v2; v1's `session/fork` is untouched (regression-pinned in
`src/__tests__/CodexACPAgent/session-fork.test.ts`).

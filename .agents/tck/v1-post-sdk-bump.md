# TCK v1: after the SDK bump

- Date: 2026-09-24
- codex-acp: `@agentclientprotocol/sdk` pinned to `~1.5.0` (resolved `1.5.0`), `dist/index.js` rebuilt with
  `npm run build`
- acp-tck: `5418887`, protocol version 1
- Command: see `HOW-TO-RUN.md`, "Full v1 suite"

## Result: VERDICT: CONFORMANT (exit 0)

56 tests: 50 passed, 1 failed, 5 skipped (212 s).

| Tier          | PASS | FAIL | SKIPPED | NOT_TESTED |
|---------------|------|------|---------|------------|
| MANDATORY     | 21   | 0    | 0       | 0          |
| CAPABILITY    | 15   | 0    | 4       | 0          |
| ADVISORY      | 10   | 1    | 1       | 0          |
| INFORMATIONAL | 4    | 0    | 0       | 0          |

## Failing requirements

- ACP-SCHEMA-002 (ADVISORY): unknown root-level keys. `session/new` returns `models` and `session/prompt` returns
  `usage`. The failure message is identical to the baseline.

## Comparison with `v1-baseline-pre-sdk-bump.md`

No regressions. Every requirement has the same status as in the baseline: the same single failure (ACP-SCHEMA-002),
the same five skips (ACP-AUTH-003, ACP-AUTH-004, ACP-AUTH-005, ACP-PROMPTCAP-002, ACP-CLOSE-002), and the same
informational observations.

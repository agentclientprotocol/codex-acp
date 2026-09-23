# TCK v1 baseline: before the SDK bump

- Date: 2026-09-24
- codex-acp: HEAD `b2678b1` (branch `eugenethedev/acp-v2`), `dist/index.js` built by `npm run build`
- SDK actually bundled: `@agentclientprotocol/sdk@1.4.0`. This was a stale local `node_modules`; `package.json` and the
  lockfile at HEAD already said `^1.5.0` / `1.5.0`.
- acp-tck: `5418887`, protocol version 1, schema pinned at spec `6d08f412`
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
  `usage`, and neither key is in the TCK's v1 schema. This does not affect the verdict.

## Skipped requirements

- ACP-AUTH-003, ACP-AUTH-004: no `--auth-method` was given, so `authenticate` was not exercised. This is not needed
  because codex-acp does not gate sessions on auth.
- ACP-AUTH-005: logout was not exercised because `--allow-logout` was not passed.
- ACP-PROMPTCAP-002: codex-acp does not advertise the `audio` prompt capability.
- ACP-CLOSE-002: the prompt turn finished before `session/close` was sent. This one is timing-dependent.

## Informational

- ACP-INFO-INVALIDREQ-001: replied `-32600`, and the connection was still usable afterwards.
- ACP-INFO-PARSE-001: replied `-32700` with `id: null`, and the connection was still usable afterwards.
- ACP-INFO-UNKNOWNSESSION-001: replied `-32603`.
- ACP-STDERR-001: 671 bytes on stderr.

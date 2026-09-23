# TCK v1 + v2 (targeted): after topic 8 (v2 `auth/login` / `auth/logout`)

- Date: 2026-09-24
- codex-acp: commit `11a1969`, `dist/index.js` rebuilt with `npm run build`. The v2 chain now also registers
  `auth/login` and `auth/logout`. The v1-only `authentication/status|logout` extensions stay v1-only.
- acp-tck: `5418887`, `-k test_authentication`, no `--auth-method`, no `--allow-logout`.
- Scoped runs, so the verdict (NOT CONFORMANT, exit 1) is meaningless; read the targeted rows.

## v1 (`--protocol-version 1`): 2 passed, 3 skipped

| Requirement  | Result  | Notes |
|--------------|---------|-------|
| ACP-AUTH-001 | PASS    | |
| ACP-AUTH-002 | PASS    | |
| ACP-AUTH-003 | SKIPPED | Known: no `--auth-method` |
| ACP-AUTH-004 | SKIPPED | Known: no `--allow-logout` |
| ACP-AUTH-005 | SKIPPED | Known: agent advertises authMethods |

Same as the baseline; no regression.

## v2 (`--protocol-version 2`): 3 passed, 4 skipped

| Requirement  | Result  | Notes |
|--------------|---------|-------|
| ACP-AUTH-201 | PASS    | `methodId` values unique |
| ACP-AUTH-202 | PASS    | Vacuous: no terminal auth method |
| ACP-AUTH-206 | PASS    | every method has `type: "agent"` |
| ACP-AUTH-203 | SKIPPED | No `--allow-logout` (destructive); `auth/logout` is covered by `auth-v2.test.ts` |
| ACP-AUTH-204 | SKIPPED | No `--auth-method`; the local Codex CLI reports "Not logged in", so `chat-gpt` would start a real browser login. `auth/login` is covered by `auth-v2.test.ts` |
| ACP-AUTH-205 | SKIPPED | Known: agent advertises authMethods |
| ACP-AUTH-207 | SKIPPED | No terminal auth method |

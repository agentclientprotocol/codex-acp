# Slice 10(e): `providers/*` on v2 — targeted TCK runs

acp-tck `main` @ `b15c7bd` (`.agents/tck/HOW-TO-RUN.md`). `bun` not on PATH; ran via `uv run acp-tck`
directly instead of the `npm run build` + bun wrapper (equivalent: bundle rebuilt with
`npm run build` first, then invoked `dist/index.js` directly).

## v1, `-k "test_initialize or test_extensibility"`

`7 passed, 1 failed, 48 deselected`. The one failure is the known pre-existing ACP-SCHEMA-002
advisory (root-level `models`/`usage` keys not in the vendored v1 schema) — unrelated to this
slice, unchanged from baseline.

## v2, `-k "test_initialize or test_extensibility"`

`14 passed, 0 failed, 89 deselected`. Notably **ACP-EXT-202 PASS** (the TCK's unstable-schema fix
from the prior session correctly allows `capabilities.providers`) and **ACP-SCHEMA-002 PASS**.

## v2, `-k test_session`

`24 passed, 2 skipped, 0 failed, 77 deselected`. Skips are pre-existing/unrelated
(`AUTH-205` empty-authMethods case; `session/list` timing in `test_session_capabilities.py`).

No regressions and no new failures from registering `providers/list`, `providers/set`,
`providers/disable` on the v2 chain. The TCK has no dedicated `providers/*` test module; real
coverage for those three methods is the new Vitest suite
(`src/__tests__/CodexACPAgent/providers-v2.test.ts`).

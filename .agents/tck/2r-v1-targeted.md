# TCK v1 (targeted): after slice 2(r) (v1 `/review` two-id turn tracking)

- Date: 2026-09-24
- codex-acp: commit `1c46656`, `dist/index.js` rebuilt with `npm run build`.
- acp-tck: `5418887`
- Scoped run, so the verdict (NOT CONFORMANT, exit 1) is meaningless; read the targeted rows.

## v1 `-k "test_prompt or test_cancel"` (9 tests)

8 passed, 1 skipped (49 s). Prompt rows match the 2(a1) baseline (6 pass / 1 skip); cancel rows pass. No regressions.
The TCK does not exercise `/review`; the review-specific behavior is covered by
`src/__tests__/CodexACPAgent/review-turn-ids.test.ts`.

| Requirement       | Result  | Notes |
|-------------------|---------|-------|
| ACP-CANCEL-001    | PASS    | |
| ACP-CANCEL-002    | PASS    | |
| ACP-PROMPT-001    | PASS    | |
| ACP-PROMPT-002    | PASS    | |
| ACP-PROMPT-003    | PASS    | |
| ACP-PROMPTCAP-001 | PASS    | |
| ACP-PROMPTCAP-002 | SKIPPED | audio not advertised (known) |
| ACP-PROMPTCAP-003 | PASS    | |
| ACP-META-001      | PASS    | |

# TCK v1 and v2 (targeted): after slice 2(e) (v2 post-insertion failures + idle `_meta`/`usage`)

- Date: 2026-09-24
- codex-acp: commit `1e20ae9`, `dist/index.js` rebuilt with `npm run build`. A prompt that fails after insertion now
  sends its error as agent text (unless the turn already sent it) and then one `idle`/`end_turn`; every v2 `idle`
  carries v1's `PromptResponse.usage` and `_meta` (`quota`, AIR `sessionFailure`).
- acp-tck: `5418887`
- Scoped runs, so the verdict (NOT CONFORMANT, exit 1) is meaningless; read the targeted rows.
- Flags: `--timeout 90 --test-timeout 300`.

## v1 `-k test_prompt` (7 tests)

6 passed, 1 skipped (42 s). Matches the baseline: PROMPT-001/002/003, PROMPTCAP-001/003, META-001 PASS;
PROMPTCAP-002 SKIPPED (audio not advertised).

## v2 `-k "test_prompt or test_patches or test_enums"` (21 tests)

12 passed, 9 skipped (101 s), no failures. Same rows as after 6(a): PROMPT-201/203/205/003, PROMPTCAP-001/003,
STATE-201/202/203, PATCH-201/203, ENUM-202 PASS; PROMPTCAP-002, PATCH-204..209, ENUM-201/203 SKIPPED (no audio, no
tool call/plan/terminal/permission in the TCK's fixed prompt). PROMPT-205 now validates idle updates that carry
`_meta.quota` and `usage`. The TCK cannot trigger post-insertion failures, so that path is covered by Vitest only.

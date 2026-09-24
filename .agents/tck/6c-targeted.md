# Slice 6(c) — targeted TCK runs (diff content on v2)

Commit under test: 1bcd452 (`npm run build` bundle).

## v1 `-k test_prompt`

6 passed, 1 skipped (ACP-PROMPTCAP-002, audio not advertised) — unchanged baseline.
PASS: PROMPT-001/002/003, PROMPTCAP-001/003, META-001.

## v2 `-k "test_prompt or test_patches or test_enums"`

12 passed, 9 skipped, 0 failed — unchanged from 6(b).
PASS: PATCH-201/203, PROMPT-201/203/205/003, PROMPTCAP-001/003, STATE-201/202/203, ENUM-202.
SKIPPED: ENUM-201/203, PATCH-204/205/206/207/208/209, PROMPTCAP-002 (the TCK prompt makes no
tool call, plan, terminal, or permission request). No TCK row covers diff content.

## Scratch v2 client against real Codex

`/tmp/6c-probe/probe.mjs`: one prompt asking for a single apply_patch that edits a.txt, adds b.txt,
deletes c.txt and moves d.txt to e.txt. Received one `diff` per file: `modify` a.txt, `add` b.txt,
`delete` c.txt, and (the model chose delete + add instead of `*** Move to`) `delete` d.txt + `add`
e.txt. Every patch was a `diff --git` section with absolute paths; no `oldText`/`newText`/`path`
fields and no private `diff_old_path` key reached the client. The `move` rendering is covered by
unit tests only.

# Slice 2(h) — targeted TCK runs (v1 unspawned /review fix)

Commit under test: 76ad33e (`npm run build` bundle). No TCK row exercises `/review`; these runs only
check that prompt/cancel behaviour did not regress.

## v1 `-k "test_prompt or test_cancel"`

8 passed, 1 skipped — unchanged baseline (2(r)).
PASS: CANCEL-001/002, PROMPT-001/002/003, PROMPTCAP-001/003, META-001.
SKIPPED: PROMPTCAP-002 (audio not advertised).

## v2 `-k "test_prompt or test_cancel"`

12 passed, 6 failed, 1 skipped (683 s).
PASS: CANCEL-208, CLOSE-202, PROMPT-003/201/203/205, PROMPTCAP-001/003, STATE-201/202/203,
INFO-CANCEL-201, INFO-CANCEL-202.
FAIL: CANCEL-201/203/205/206/207, CANCEL-204 (informational) — the expected topic 3 failures
from the end-of-topic-6 baseline.
FAIL: CANCEL-202 — was SKIPPED in the baseline. Same cause as CANCEL-203/205/206: the cancelled
turn did not reach a terminating idle within 90 s (v2 `session/cancel` is topic 3). In the baseline
the model finished before the timeout, so the row skipped on its "not cancelled" prerequisite.
Timing-dependent, not a regression.
INFO-CANCEL-202 flipped FAIL -> PASS (record-only row, timing-dependent).
SKIPPED: PROMPTCAP-002 (audio not advertised).
Every row that passed in the baseline still passes.

## Real Codex (0.156.1), scratch client, non-git cwd

`/review-branch main`, then two plain prompts, in one session:
- Before the fix: the review prompt never resolved.
- After: Codex sends `error{turnId: P, willRetry: false}` and nothing else; the review prompt
  resolves `end_turn` right away (legacy: error rendered as agent text; typed clients:
  `sessionFailure` on the response), the same as a failed normal turn.
- Codex then reports the next turn as `turn/completed{status: "failed"}` with the stale
  "not a git repository" error (no `error` notification for it). Without the leak fix a typed client
  got a `sessionFailure` on that successful prompt; with it the prompt returns a clean `end_turn`.
  The third turn arrives as `completed` from Codex, so the leak lasts exactly one turn.

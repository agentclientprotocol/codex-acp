# Slice 10(a) targeted TCK runs

Scope: `-k "test_session or test_prompt"`, both protocol versions, against `dist/index.js` built
from this slice's changes (subagent RFD upsert + async task renderer cases in
`toV2SessionUpdate`). Per `.agents/tck/HOW-TO-RUN.md`, a scoped run always ends
`VERDICT: NOT CONFORMANT` (deselected requirements count as `NOT TESTED`) -- only the PASS/FAIL
rows for the targeted requirements matter here.

## v1

```
24 passed, 3 skipped, 29 deselected in 110.56s
```

0 FAIL. The 3 skips are pre-existing/environment-dependent (no `audio` capability, no empty
`authMethods`, close-cancellation race) and unrelated to this slice.

## v2

```
33 passed, 3 skipped, 67 deselected in 169.73s
```

0 FAIL, including `ACP-RESUME-201..205` (all PASS) and `ACP-STATE-201..203` (all PASS). The 3
skips mirror the v1 ones (audio capability, empty `authMethods`, `session/list` timing) and are
also unrelated to this slice.

## Conclusion

No regressions from the renderer changes in `src/AcpV2SessionUpdate.ts` (subagent RFD upsert and
async task cases) in either protocol's targeted `session`/`prompt` conformance surface.

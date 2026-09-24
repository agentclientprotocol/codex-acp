# TCK fix — ACP-EXT-202 false positive on `capabilities.providers`

TCK: `acp-tck` `main` @ `b15c7bd` (fix `6e29654`, self-tests `b15c7bd`; base `64b62b6`).
codex-acp: `dist/index.js` as built at `f9d477b` (not rebuilt, not changed).

TCK change: `find_unknown_root_keys` (backs `ACP-EXT-202`/`ACP-SCHEMA-002`) only resolved a
`$def`'s allowed root properties against the vendored stable `schema.json`. A field that a real
Draft RFD defines only in `schema.unstable.json` -- `AgentCapabilities.providers`
(`docs/rfds/custom-llm-endpoint.mdx`, MUST advertise) and `SessionCapabilities.fork`
(`docs/rfds/session-fork.mdx`) -- therefore looked like an undeclared vendor extension, even
though it is a typed, spec-tracked field, not a vendor extension. `schema.unstable.json` is now
vendored alongside `schema.json` (`src/tck/v2/schema/`, commit `d8805733`), and
`_allowed_root_properties` unions properties resolved from both schemas. Full jsonschema
validation (`ACP-SCHEMA-001`, `validate_agent_message`/`validate_agent_response`) is untouched
and stays scoped to the stable schema only, since that requirement's text specifically demands
validation "against the vendored v2 schema" (the stable one). Two new self-test fixtures:
`unstable_capability_key.py` (advertises `capabilities.providers`, must PASS EXT-202) and
`unknown_capability_root_key.py` (advertises a genuinely unknown `capabilities.vendorFeature`,
must still FAIL EXT-202).

## v2 `-k "test_initialize or test_extensibility"`

| Row | Before | After |
|-----|--------|-------|
| INIT-001/003/201/202/203/204 | PASS | PASS |
| SCHEMA-001 | PASS | PASS |
| EXT-001 | PASS | PASS |
| EXT-201 | PASS | PASS |
| **EXT-202** | **FAIL** (`capabilities.providers` flagged as unrecognized root key) | **PASS** |
| META-001 / META-201 | PASS | PASS |
| SCHEMA-002 | PASS | PASS |
| EXT-203 (info) | "silent (ignored)" | "silent (ignored)" |

Only EXT-202 changes. Nothing else in this scoped run moves.

## v1 `-k "test_initialize or test_extensibility"`

Before and after identical (v1 code untouched by this fix): EXT-001, INIT-001/002/003,
SCHEMA-001, META-001, INIT-004 PASS. **SCHEMA-002 FAIL** (advisory) both before and after,
same cause as always -- known `models`/`usage` root keys on codex-acp's v1 wire. The fix is
scoped to `tck/v2/`, so v1's `find_unknown_root_keys` and its schema are never touched, and this
row cannot change.

## Full runs (after fix)

- **v2 full suite:** `84 passed, 19 skipped`, zero FAIL anywhere, `VERDICT: CONFORMANT`.
  MANDATORY 18/0/1skip, CAPABILITY 41/0/10skip, ADVISORY 16/0/4skip, INFORMATIONAL 12/0/4skip.
- **v1 full suite:** `50 passed, 1 failed, 5 skipped`, `VERDICT: CONFORMANT`. FAIL: SCHEMA-002
  (advisory, known). SKIPPED: AUTH-003/004/005 (no `--auth-method`/`--allow-logout`), CLOSE-002
  (timing), PROMPTCAP-002 (audio not advertised). Matches the documented v1 baseline exactly.

## Full runs (before fix, acp-tck changes stashed)

- **v2 full suite:** `83 passed, 1 failed, 19 skipped`, `VERDICT: CONFORMANT` (the one FAIL,
  EXT-202, is ADVISORY-tier and does not block the verdict). Every other row matches the "after"
  run's PASS/SKIP set exactly -- EXT-202 is the only difference between the two full v2 runs.
- v1 full suite not re-run before the fix; the scoped `-k` comparison above already shows v1 is
  byte-for-byte unaffected (same FAIL/PASS set), and the fix touches no v1 file.

## acp-tck's own suite

`uv run pytest`: 286 passed (284 baseline + 2 new self-tests), exit 0.

Raw reports: `/tmp/acp-tck-reports/{v1,v2}-{before,after}.{txt,json}`,
`/tmp/acp-tck-reports/{v1,v2}-full-{before,after}.{txt,json}` (v1-full-before not generated, see
above).

## Design note (not left open)

The task considered whether unstable-schema fields should be accepted unconditionally or only
when actually advertised/gated by their own capability marker. `find_unknown_root_keys` is a
static allowed-key-membership check, not a gating check -- `ACP-EXT-202`'s own text is "lives
under `capabilities._meta`, not as an unrecognized root key of `capabilities`", which is about
*where* a key may live, not whether the surface it names is truly implemented. Accepting any
key the unstable schema types at that `$def`'s root, unconditionally, is the direct reading of
that text and needed no separate design call.

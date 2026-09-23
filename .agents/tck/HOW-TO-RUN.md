# Running the ACP TCK against codex-acp

The TCK lives at `/Users/eugene/Documents/JetBrains/projects/acp-tck` (Python, run through `uv`). It launches
codex-acp as a stdio subprocess, one fresh process per test.

## Prerequisites

- `uv` on PATH (the TCK's venv is created/used automatically by `uv --project ...`).
- codex-acp built to `dist/index.js`: `npm run build` (esbuild bundle). Rebuild after every source change; the TCK runs
  the built bundle, not `src/`.
- A working local Codex login (`~/.codex`). codex-acp does **not** gate `session/new` on `authenticate`, so no
  `--auth-method` is needed; session/prompt tests talk to the **real model** and spend real tokens.
- The report directory must exist before the run. If `--report-json` points into a missing directory, all tests run and
  then the TCK crashes with `FileNotFoundError` while writing the report (the summary table is lost, and the exit code
  is not reliable).

## Full v1 suite (baselines, broad verification)

From the codex-acp checkout:

```bash
cd /Users/eugene/Documents/JetBrains/projects/codex-acp
npm run build
mkdir -p /tmp/acp-tck-wd /tmp/acp-tck-reports
uv --project /Users/eugene/Documents/JetBrains/projects/acp-tck run acp-tck \
  --agent-cwd /tmp/acp-tck-wd \
  --timeout 90 --test-timeout 300 \
  --report-json /tmp/acp-tck-reports/v1.json \
  -- node /Users/eugene/Documents/JetBrains/projects/codex-acp/dist/index.js \
  > /tmp/acp-tck-reports/v1.txt 2>&1; echo exit=$?
sed -n '/ACP TCK requirement summary/,$p' /tmp/acp-tck-reports/v1.txt
```

- Takes about 3.5 minutes (56 tests).
- Exit code `0` means `VERDICT: CONFORMANT`; `1` means not conformant.
- The terminal summary lists every requirement ID with PASS/FAIL/SKIPPED/NOT TESTED plus per-tier counts. The JSON
  report adds the wire transcript and agent stderr for every failing test.
- Keep reports outside the repo (`/tmp/...`); commit only the summaries under `.agents/tck/`.

## Full v2 suite

Same command with `--protocol-version 2` (the TCK's v2 suite targets the Draft protocol):

```bash
uv --project /Users/eugene/Documents/JetBrains/projects/acp-tck run acp-tck \
  --protocol-version 2 \
  --agent-cwd /tmp/acp-tck-wd \
  --timeout 90 --test-timeout 300 \
  --report-json /tmp/acp-tck-reports/v2.json \
  -- node /Users/eugene/Documents/JetBrains/projects/codex-acp/dist/index.js \
  > /tmp/acp-tck-reports/v2.txt 2>&1; echo exit=$?
```

Until codex-acp implements v2, it negotiates `protocolVersion: 1`, so the v2 run is expected to be `NOT CONFORMANT`
with version-dependent tests `SKIPPED` (`VERSION-MISMATCH`). A scoped probe (`-k test_initialize`) on the pre-v2 code
passed ACP-INIT-001/003/201/202 and skipped ACP-INIT-203/204 and ACP-SCHEMA-001.

Optional v2 flags: `--allow-logout` exercises `auth/logout` (ACP-AUTH-203). Do not pass it on a machine whose Codex
login you want to keep, because it may revoke those credentials.

## Targeted subsets with `-k`

`-k EXPR` is passed straight to pytest. It matches **test module and test function names** (substring match, with
`and`/`or`/`not`). It does **not** match requirement IDs: `-k ACP-INIT` selects 0 of 56 tests, because the IDs are
arguments of the `@pytest.mark.requirement("...")` marker, not test names or keywords.

Examples (append to the full-suite command above, before the `--`):

```bash
# all tests in test_initialize.py (initialize/version negotiation)
-k test_initialize

# cancellation plus prompt-turn tests. "test_prompt" also matches test_prompt_capabilities.py
-k "test_cancel or test_prompt"

# a single test function
-k test_full_exchange_has_no_unknown_root_keys

# test_session.py and test_session_config.py, but not test_session_capabilities.py
-k "test_session and not test_session_capabilities"
```

To select by requirement ID, look up which test functions carry that marker, then pass those names to `-k`:

```bash
# v1; use src/tck/v2/conformance for v2
grep -rn -A1 'requirement("ACP-CANCEL' /Users/eugene/Documents/JetBrains/projects/acp-tck/src/tck/v1/conformance
```

Test modules (v1): `test_authentication`, `test_cancel`, `test_client_capabilities`, `test_diagnostics`,
`test_extensibility`, `test_informational`, `test_initialize`, `test_jsonrpc`, `test_prompt`,
`test_prompt_capabilities`, `test_session`, `test_session_capabilities`, `test_session_config`, `test_transport`.
v2 has the same modules plus `test_batch`, `test_enums`, `test_patches`, and `test_permission`.

A scoped run always ends `VERDICT: NOT CONFORMANT` with exit code `1`, because the deselected requirements count as
`NOT TESTED`. The TCK prints a hint saying so. For a scoped run, read the PASS/FAIL rows of the requirements you
targeted and ignore the verdict and exit code. Use the full suite for baselines and verdicts.

## Known noise

- ACP-SCHEMA-002 (ADVISORY) fails on v1: `session/new` returns a root-level `models` key and `session/prompt` returns a
  root-level `usage` key. The TCK's vendored v1 schema does not include either key. This is pre-existing and does not
  affect the verdict.
- ACP-CLOSE-002 is timing-dependent. It is SKIPPED when the prompt turn finishes before `session/close` arrives, so it
  can switch between SKIPPED and PASS from run to run. `--cancel-prompt TEXT` with a longer task makes the cancellation
  tests more likely to actually run.

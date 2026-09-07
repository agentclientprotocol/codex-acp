# Prompt usage

`PromptResponse.usage` and `_meta.quota.token_count` report observed usage for
the root Codex thread during this ACP prompt. They include all model requests
in the prompt, including a plan and its approved implementation. They exclude
earlier prompts, native child threads, and background title generation.

The adapter subtracts the thread total captured before the prompt from each
subsequent total. Repeated notifications add zero. New threads start at zero;
load/resume snapshots supply the historical baseline. A missing baseline is
unknown: the first snapshot establishes it without charging historical usage.
Later observations are retained, but the result is partial.

`_meta.usageAccounting` identifies the contract:

```json
{
  "version": 1,
  "source": "codex/thread-token-usage-delta",
  "scope": "root_thread_prompt",
  "completeness": "reported"
}
```

`reported` means the observed counters were usable. It does not certify provider
billing or include work outside the stated scope. `partial` means a baseline or
usage was missing, a counter was replaced or invalid, or the prompt was cancelled
or returned a typed failure. Known counts remain available; no observations
produce `usage: null`. A transport error without a prompt response still has no
terminal usage result.

Cached reads are separated from input. Cache writes remain included in non-read
input, as before; reasoning is a subset of output. Neither is added twice.
`session/update.usage_update.used` remains context occupancy and must not be
summed as token consumption. Reports from adapter versions before this change
describe only the last model request and cannot be repaired retroactively.

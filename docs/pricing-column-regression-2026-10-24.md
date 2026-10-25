# Pricing-column regression, 2026-10-24

The published OpenAI Markdown pricing table changed from
`input, cached input, cache writes, output` to
`input, output, cached input, 30m write, 12h write` within each context band.
The positional parser therefore read Astra cached input as $50/M instead of $1/M,
and output as $12.50/M instead of $50/M in standard short-context mode.

The reported $402.42 was reproduced exactly from this chat's recorded usage:
8,136,314 input tokens, including 8,014,208 cached input tokens, and 39,285 output
tokens. Fresh input was 122,106; cache writes were zero. The old column mapping
produced $402.4225225; the correct mapping produces an API-rate estimate of
$11.199518 for that same point in time. This is an estimate, not a billed invoice.

Source: https://developers.openai.com/api/docs/pricing.md, fetched 2026-10-24.
The regression fixture retains the relevant official table headers and Astra rows.

The parser now maps normalized, uniquely named headers, tolerates reordered/new
columns and repeated pricing sections, and rejects missing/ambiguous columns,
empty rates, and contradictory duplicates. Both prior and current table layouts
are covered. The change is shared by ACP v1 and v2 cost calculations.

Verification: 1,886 tests passed, 36 skipped; typecheck and build passed. A live
fetch through the corrected provider confirmed current standard/fast rates.

The current development chat's running adapter instance was narrowly repaired
under the Node debugger after verifying the exact session ID, standard Astra
model, zero cache writes and the known-bad rate mapping. Its accumulated amount
was recomputed from its existing cumulative counters; no messages or token usage
were rewritten. At repair, $518.5491025 became $14.171778 before the next usage
increment. Subsequent raw ACP usage records carry the corrected totals. The
breakpoint was removed and the debugger listener shut down. The built adapter
contains the durable parser fix; other already-running adapter instances are not
hot-patched and need a normal restart to load it.

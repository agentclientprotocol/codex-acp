# Session system prompt append

Clients may send `_meta.systemPrompt.append` on `session/new`, `session/load`,
`session/resume`, and `session/fork` to install session-scoped developer
instructions. Ordinary prompts remain ordinary user messages. Codex owns tool
execution, history, and compaction; this extension does not replace its base
instructions or write instruction files.

Check the initialization response before using the extension:

```json
{"_meta":{"systemPrompt":{"version":1,"append":true,"maxBytes":262144}}}
```

Example session metadata:

```json
{"_meta":{"systemPrompt":{"append":"Review database migrations for this session."}}}
```

The adapter reads effective user/project `developer_instructions` for the
requested working directory, honoring a `CODEX_CONFIG` override, and appends the
client text with a blank line. The underlying configuration is not modified.
Each session gets its own value; repeated loads reconstruct it from configuration
rather than appending to the already-appended restored instructions.

Absent or whitespace-only text leaves the existing native lifecycle unchanged.
With explicit text, new and forked threads receive the combined value; load and
resume apply it to an **unloaded** thread. Codex ignores instruction overrides on
already-loaded threads, including idle threads. Those requests are rejected
rather than silently claiming success: close/unload the thread first, or open it
in a fresh adapter process. Omitting metadata leaves native restoration and
inheritance behavior to Codex. This is not an in-place instruction editor.

Only the `{ "append": "..." }` form is supported. Replacement strings, unknown
fields, non-string values, and values over 256 KiB in UTF-8 are rejected before
session creation or skill changes. Config lookup failures are propagated; the
adapter never substitutes an empty configuration and loses user instructions.

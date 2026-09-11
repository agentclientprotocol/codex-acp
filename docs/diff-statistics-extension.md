# AIR diff statistics extension

Status: Experimental

Agents can attach line counts and a navigation line to an ACP `diff` content block.
Clients can use these values without comparing the block's texts again.
The extension applies to any ACP agent, including Codex.

## Wire format

The payload belongs to the individual diff block at `_meta.jetbrains.air.diffStats`.
It does not belong to the enclosing tool call or session notification.

```json
{
  "type": "diff",
  "path": "/project/file.txt",
  "oldText": "keep\nold\n",
  "newText": "keep\nnew\nextra\n",
  "_meta": {
    "kind": "update",
    "jetbrains": {
      "air": {
        "version": 1,
        "diffStats": {
          "version": 1,
          "added": 2,
          "removed": 1,
          "firstChangedLine": 2
        }
      }
    }
  }
}
```

`jetbrains.air.version` identifies the AIR envelope. Clients accept integer versions of at least 1.
`diffStats.version` identifies this payload. This specification defines version 1 only.
Agents preserve other metadata, including the existing `kind` field.

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | integer | Must equal `1`. |
| `added` | integer | Number of added lines, between 0 and 2147483647. |
| `removed` | integer | Number of removed lines, between 0 and 2147483647. |
| `firstChangedLine` | integer or null | One-based navigation line in the block's new text. |

All four fields are required. Numeric strings are invalid.
If both counts are zero, `firstChangedLine` must be null.
Otherwise, it must be positive.
For a deletion at the end, clamp it to the last new line.
For an empty new text, use line 1.
For a partial diff, the line is relative to that block, not the complete file.
ACP `locations` retain their separate file coordinates.

## Count semantics

Counts describe the patch that produced the emitted old and new texts.
A patch can contain more operations than a minimal comparison of the final texts.
Clients must preserve valid provider counts rather than replace them with a different comparison.

For line boundaries, treat CRLF and CR as LF and ignore one final line terminator.
An empty string has zero lines. A string containing only one line terminator has one empty line.
Normalized equal texts have zero added and removed lines.
New files have zero removed lines; deleted files have zero added lines.

Each diff block owns its statistics. Do not aggregate counts across blocks or tools.
A text revision must carry statistics for that revision, or omit the payload.
Clients must invalidate old statistics when the corresponding texts change.
A status-only update preserves the previous statistics.
Late statistics for unchanged texts may replace previously calculated values.

## Availability and compatibility

This is optional display metadata. No capability negotiation is required.
Clients that do not understand it can ignore it and render the standard diff content.
Agents must still send the usual `path`, `oldText`, and `newText` values.

An agent omits `diffStats` if it cannot produce trustworthy counts.
An empty or invalid patch does not by itself mean that zero lines changed.
Clients fall back to their own comparison when the envelope or payload is missing, invalid, or unsupported.
Unknown fields do not invalidate an otherwise valid payload.

The earlier experimental `com.intellij/diffStats` key is not part of this contract.
AIR ignores that key and uses its normal fallback.
Already persisted AIR statistics keep their existing format and need no migration.

## Codex behavior

For updates, Codex uses the parsed patch used to construct the emitted texts.
It checks hunk sizes, order, coordinates, and content before publishing statistics.
Fuzzy or relocated hunks omit statistics when these checks fail.
For additions and deletions, Codex counts the supplied file content.

Tests: `src/__tests__/DiffStats.test.ts` and
`src/__tests__/CodexACPAgent/file-change-events.test.ts`.

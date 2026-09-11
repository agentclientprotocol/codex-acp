# AIR diff statistics extension

Status: Experimental

Agents can attach added and removed line counts to an ACP `diff` content block.
Clients use these values without comparing the block's texts again.
The extension applies to any ACP agent, including Codex.

## Wire format

The payload belongs to the individual diff block at `_meta.jetbrains.air.diffStats`.

```json
{
  "type": "diff",
  "path": "/project/file.txt",
  "oldText": "old\n",
  "newText": "new\nextra\n",
  "_meta": {
    "kind": "update",
    "jetbrains": {
      "air": {
        "version": 1,
        "diffStats": {
          "version": 1,
          "added": 2,
          "removed": 1
        }
      }
    }
  }
}
```

`jetbrains.air.version` identifies the AIR envelope. Clients accept integer versions of at least 1.
`diffStats.version` identifies this payload. This specification defines version 1 only.
Agents preserve other metadata, including `kind`.

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | integer | Must equal `1`. |
| `added` | integer | Number of added lines, between 0 and 2147483647. |
| `removed` | integer | Number of removed lines, between 0 and 2147483647. |

All three fields are required. Numeric strings are invalid.
Statistics contain no navigation coordinates. Clients must not compare texts to obtain coordinates when they receive valid counts.

## Count semantics

For updates, counts describe the addition and deletion operations in the supplied patch.
Context lines and `No newline at end of file` markers do not contribute to counts.
A replacement contributes both added and removed lines.
A patch can contain operations that leave the normalized file content unchanged.
Clients preserve the patch counts instead of recomputing a minimal diff.
Relocating an exact hunk does not change its counts.

For creation and deletion, count the supplied file content.
Treat CRLF and CR as line boundaries and do not count an extra line after the final terminator.
An empty string has zero lines. One line terminator represents one empty line.
Creation has zero removed lines; deletion has zero added lines.

Each diff block owns its statistics.
A text revision carries statistics for that revision, or omits the payload.
Clients invalidate old statistics when the texts change.
Status-only updates preserve previous statistics.
Late statistics may replace calculated values for unchanged texts.

## Availability and compatibility

This is optional display metadata. No capability negotiation is required.
Clients that do not understand it can ignore it and render the standard diff content.
Agents still send the usual `path`, `oldText`, and `newText` values.

An agent omits statistics when it cannot produce valid counts.
Clients use their normal comparison when metadata is missing, malformed, or unsupported.
Unknown fields do not invalidate a valid payload.

The earlier experimental `com.intellij/diffStats` key is not part of this contract.
AIR ignores that key and uses its normal fallback.
Existing persisted statistics, including stored navigation lines, remain readable without migration.

## Codex behavior

The existing patch application validates the file change and produces the texts for ACP.
The statistics calculator then reads only the parsed patch. It receives no file texts.
It validates hunk sizes and coordinates and counts `+` and `-` operations.
It does not verify file contents again or locate a navigation line.

Tests: `src/__tests__/DiffStats.test.ts` and
`src/__tests__/CodexACPAgent/file-change-events.test.ts`.

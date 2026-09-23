# AIR diff patch extension

Status: Experimental

This extension lets an ACP agent send one compact Git patch instead of file text snapshots.
It applies to an ACP `diff` content block.

## Capability negotiation

The client advertises `diffPatch` in the initialize request:

```json
{
  "clientCapabilities": {
    "_meta": {
      "jetbrains": {
        "air": {
          "version": 1,
          "capabilities": ["diffPatch"]
        }
      }
    }
  }
}
```

The adapter advertises the same capability in the initialize response:

```json
{
  "_meta": {
    "jetbrains": {
      "air": {
        "version": 1,
        "capabilities": ["diffPatch"]
      }
    }
  }
}
```

The adapter uses patch mode only when both peers advertise `diffPatch` with an integer AIR envelope version of at least 1.
If either declaration is absent or malformed, the adapter sends the standard `oldText` and `newText` values.

## Diff content

Patch mode puts the payload at `_meta.jetbrains.air.diffPatch`:

```json
{
  "type": "diff",
  "path": "/workspace/src/App.ts",
  "oldText": null,
  "newText": "",
  "_meta": {
    "kind": "update",
    "jetbrains": {
      "air": {
        "version": 1,
        "diffPatch": {
          "version": 1,
          "format": "git_patch",
          "text": "diff --git a/workspace/src/App.ts b/workspace/src/App.ts\n--- a/workspace/src/App.ts\n+++ b/workspace/src/App.ts\n@@ -1 +1 @@\n-old\n+new\n"
        }
      }
    }
  }
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | integer | Must equal `1`. |
| `format` | string | Must equal `git_patch`. |
| `text` | string | One unified Git patch for the block's file. |

The patch contains Git file headers and at least one `@@` hunk.
Each header path is the absolute file path without its leading slash, with the `a/` or `b/` prefix.
A Windows path uses forward slashes, for example `a/C:/work/App.ts`.
The adapter quotes a path in C style when it contains a double quote, a backslash or a control character, as Git does.
It does not quote non-ASCII characters.
A `---` or `+++` line ends with a tab when its unquoted path contains a space.

An added file has a `new file mode 100644` header and uses `/dev/null` as the old file header.
A deleted file has a `deleted file mode 100644` header and uses `/dev/null` as the new file header.
A moved file has `rename from` and `rename to` headers, and the block `path` is the target path.
The patch keeps the provider bytes, including a carriage return.
A file without a final newline ends with the `\ No newline at end of file` marker.

In patch mode, `oldText: null` and `newText: ""` are compatibility placeholders.
They are not file snapshots or changed fragments.
The receiver must use `diffPatch.text` as the change payload after it accepts the negotiated extension.

The receiver derives line counts and changed fragments from the patch.

## Compatibility and fallback

The adapter sends the standard ACP diff when it cannot build a valid patch.
That fallback contains meaningful `oldText` and `newText` values and omits `diffPatch`.
The adapter uses the fallback in these cases:

- The file is empty, so no hunk can express it.
- The content is binary. The adapter treats content as binary when its first 8000 characters contain a NUL character.
- The patch text is larger than 1 MiB (`DIFF_PATCH_MAX_BYTES`).
- A pure rename has no hunk.
- The update hunks from Codex are malformed. In a hunk, a line that starts with `\` is valid only as the exact `\ No newline at end of file` marker.

For an update, the fallback reads the file and applies the Codex hunks.
When the adapter cannot parse the hunks or apply them, it omits the block and logs the change.

A receiver accepts the patch only after bilateral negotiation.
It also validates both versions, the format, and the patch text.
If validation fails, the receiver ignores `diffPatch` and reads the standard text fields.
Unknown fields do not invalidate a valid payload.

## Codex behavior

Codex App Server supplies compact hunks for updates and file content for additions and deletions.
The adapter checks the update hunks and puts its own Git headers before them.
It drops the file headers that Codex supplied, so that all headers name the same paths.
It builds one full-file patch for an addition or deletion because the provider already supplied that content.

The adapter applies this mode to live file changes and replayed session history.
It does not read the current file when it can forward a provider patch.

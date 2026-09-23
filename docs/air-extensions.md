# AIR extensions in codex-acp

Status: Experimental

This document is the wire contract of the JetBrains AIR extensions that `codex-acp` implements.
It describes only this adapter.

## Contents

- [Purpose and scope](#purpose-and-scope)
- [Compatibility rule](#compatibility-rule)
- [Negotiation](#negotiation)
- [AIR metadata keys](#air-metadata-keys)
- [JetBrains shared keys](#jetbrains-shared-keys)
- [Zed conventions](#zed-conventions)
- [Tool call contract](#tool-call-contract)
- [Codex items and ACP fields](#codex-items-and-acp-fields)
- [Diff patch](#diff-patch)
- [Permission presentation](#permission-presentation)
- [Plan content delta and plan review](#plan-content-delta-and-plan-review)
- [Goal](#goal)
- [Recommended config values](#recommended-config-values)
- [Async tasks](#async-tasks)
- [Agent file-change report](#agent-file-change-report)
- [Session failure](#session-failure)
- [Native subagent sessions](#native-subagent-sessions)
- [Context compaction](#context-compaction)
- [Session fork point](#session-fork-point)
- [Presentation hints](#presentation-hints)
- [Removed keys](#removed-keys)

## Purpose and scope

AIR is the ACP client that JetBrains builds.
AIR needs some data that standard ACP does not define.
This adapter sends that data as opt-in extensions under the `_meta.jetbrains.air` namespace.

`jetbrains` owns the non-standard contract.
`air` names the client whose rendering rules the contract follows.
The two levels keep other JetBrains ACP clients from reading this metadata by accident.

Each extension is experimental.
Each extension is shaped so that it can become a first-class ACP API later.

## Compatibility rule

Only AIR gets the AIR extensions.
A client is AIR when it declares `initialize.clientCapabilities._meta.jetbrains.air`.

A client that does not declare it, for example Zed or a plain ACP client, gets the fields that the adapter sent before these extensions.
The fields have the same values in the same places.
Only these differences are allowed:

- A `tool_call_update` omits a top-level field that did not change since the last report of the same tool call.
  The permission request of a tool call counts as a report. ACP clients merge an update into the stored tool call.
  The permission request itself omits no field that the adapter sent in it before, such as the `kind`.
  After a cancelled or failed permission request, the next update carries every field again.
  ACP defines no merge for `_meta` keys, so the `_meta` of each report keeps every key that the adapter sent before.
- Bug fixes: a unique MCP startup tool call id, the result of a dynamic tool in `content`,
  and no output after a tool call ended.
- The client gets no AIR-only key.
  That is no `_meta.jetbrains.air` key and none of the earlier keys in [Removed keys](#removed-keys).

The keys of Zed, of upstream ACP, and of other JetBrains teams stay as they were.
See [JetBrains shared keys](#jetbrains-shared-keys) and [Zed conventions](#zed-conventions).
[Codex items and ACP fields](#codex-items-and-acp-fields) lists the fields of each client.

The scenario tests in `src/__tests__/scenarios/` record every outbound message for three client profiles.
The profiles are a plain ACP client, Zed, and AIR. The tests validate each message against the ACP schema.
They keep the AIR messages as snapshots, one message per line.
They compare the messages of the plain client and of Zed with the messages of the adapter before these extensions.
The comparison applies only the differences above.

## Negotiation

### Client declaration

AIR declares its capabilities in the `initialize` request:

```json
{
  "clientCapabilities": {
    "_meta": {
      "jetbrains": {
        "air": {
          "version": 1,
          "capabilities": ["diffPatch", "rawInputRendering", "planContentDelta"]
        }
      }
    }
  }
}
```

The adapter accepts a capability only when all of these are true:

- `version` is an integer and is at least `1`.
- `capabilities` is an array.
- The array contains the exact capability name.

A malformed declaration enables no capability.
The adapter reads the declaration once, in `initialize`.

### Agent declaration

The `initialize` response carries the agent side of the extension only when the client is AIR:

```json
{
  "_meta": {
    "steering": { "supported": true },
    "jetbrains": {
      "air": {
        "version": 1,
        "goal": {
          "version": 1,
          "controlMethod": "_session/goal",
          "actions": ["set", "pause", "resume", "clear"]
        },
        "capabilities": [
          "sessionFailure",
          "diffPatch",
          "agentFileChangeReport",
          "nativeSubagentSessions",
          "asyncTasks",
          "recommendedValue",
          "rawInputRendering",
          "planContentDelta"
        ]
      }
    }
  }
}
```

The agent list does not depend on the client capability list.
An extension is active only when the client declared its capability.
A client that is not AIR gets no `jetbrains` key and no `goal` key in the `initialize` response.

### Capabilities

| Capability | What the adapter does when the client declares it | Section |
| --- | --- | --- |
| `diffPatch` | Sends a file change as one Git patch in the diff block. | [Diff patch](#diff-patch) |
| `rawInputRendering` | Sends no display copy of readable input in `content`. The client renders `rawInput`. | [Tool call contract](#tool-call-contract) |
| `planContentDelta` | Streams a Markdown plan as appended text in `plan_update`. | [Plan content delta and plan review](#plan-content-delta-and-plan-review) |
| `recommendedValue` | Adds the Codex recommendation to the model and effort selectors. | [Recommended config values](#recommended-config-values) |
| `asyncTasks` | Publishes background terminal commands as async tasks. | [Async tasks](#async-tasks) |
| `agentFileChangeReport` | Accepts a report request on `session/prompt` and sends the changed file list. | [Agent file-change report](#agent-file-change-report) |
| `sessionFailure` | Sends warnings and errors as typed transcript records. | [Session failure](#session-failure) |
| `nativeSubagentSessions` | Reports a Codex subagent as a native ACP child session. | [Native subagent sessions](#native-subagent-sessions) |

The goal extension has no client capability.
The agent advertises the `goal` object, and the client uses the control method when it wants to.

## AIR metadata keys

Every payload goes into `_meta.jetbrains.air`, next to `version: 1`.
The adapter merges a payload into an existing `_meta` and keeps the other namespaces.
The adapter sends these keys only to AIR. "AIR" in the gate column means that the key needs no AIR capability.

| Key | Message and field path | Shape | Gate |
| --- | --- | --- | --- |
| `capabilities` | `initialize` response `_meta.jetbrains.air` | string array | AIR |
| `goal` | `initialize` response `_meta.jetbrains.air` | `{version: 1, controlMethod, actions}` | AIR |
| `goal` | `session_info_update._meta.jetbrains.air` | goal snapshot or `null` | AIR |
| `diffPatch` | tool call `content[]` of type `diff`, `_meta.jetbrains.air` | `{version: 1, format: "git_patch", text}` | `diffPatch` |
| `contentDelta` | `plan_update._meta.jetbrains.air` | string | `planContentDelta` |
| `permission` | `session/request_permission` request `_meta.jetbrains.air` | `{version: 1, title, description?}` | AIR |
| `permission` | permission option `_meta.jetbrains.air` | `{version: 1, description}` | AIR |
| `recommendedValue` | `model` and `reasoning_effort` config options, `_meta.jetbrains.air` | option value string | `recommendedValue` |
| `asyncTasks` | `tool_call_update._meta.jetbrains.air` | `{backgrounded: true}` | `asyncTasks` |
| `agentFileChangeReportRequest` | `session/prompt` request `_meta.jetbrains.air` (client to agent) | `{version: 1, requestId}` | `agentFileChangeReport` |
| `agentFileChangeReport` | `session_info_update._meta.jetbrains.air` | report object | `agentFileChangeReport` |
| `sessionFailure` | `session_info_update._meta.jetbrains.air` or `PromptResponse._meta.jetbrains.air` | failure record | `sessionFailure` |
| `subagent` | `tool_call._meta.jetbrains.air` of a `spawnAgent` collaboration item or a subagent activity item | `true` | AIR |
| `contextCompaction` | `tool_call` and `tool_call_update` `_meta.jetbrains.air` of the synthetic compaction tool call | `{version: 1}` | AIR, when the client has no ACP compaction |
| `fork` | `session/fork` request `_meta.jetbrains.air` (client to agent) | `{version: 1, messageId, messageFingerprint?, messageOccurrence?}` | none |
| `phase` | `agent_message_chunk._meta.jetbrains.air` | Codex message phase string | AIR |
| `kind` | session mode `_meta.jetbrains.air` and `mode` config option value `_meta.jetbrains.air` | `standard`, `auto_review`, or `full_access` | AIR |
| `commandAction` | available command `_meta.jetbrains.air` | command action object | AIR |

## JetBrains shared keys

These keys are JetBrains conventions outside the AIR namespace.
Other JetBrains ACP clients and adapters use them too.
The adapter keeps them where they are.

| Key | Where | Meaning |
| --- | --- | --- |
| `terminal_output_delta` | client `initialize` `clientCapabilities._meta.terminal_output_delta: true`; tool call `_meta.terminal_output_delta = {terminal_id, data}` | The client appends each chunk of command output. AIR gets it only when it declares it. A client that is not AIR also gets it when it declares no other channel, see [Zed conventions](#zed-conventions). |
| `terminal_input` | tool call `_meta.terminal_input = {terminal_id, data}` | Text that was written to the stdin of a running command. It is not output. Only AIR gets it. |
| `mcp_output_delta` | tool call `_meta.mcp_output_delta = {data}` | MCP progress text to append, trimmed. AIR does not get it. |
| `is_mcp_tool_call` | tool call `_meta.is_mcp_tool_call: true` | The tool call is an MCP tool call. |
| `is_mcp_tool_approval` | `session/request_permission` request `_meta.is_mcp_tool_approval: true` | The permission request approves an MCP tool call. |
| `steering` | `initialize` response `_meta.steering = {supported: true}` | The agent accepts `_session/steering` for a running turn. |
| `quota` | `PromptResponse._meta.quota` | Token usage and rate limits of the turn. |
| `authStatus` | `initialize` response `agentCapabilities._meta.authStatus` | The agent pushes `_auth/status_update`. The object carries no payload. |

## Zed conventions

The adapter keeps these Zed conventions for every client:

- A command tool call has `content: [{type: "terminal", terminalId}]` and `_meta.terminal_info = {cwd, terminal_id}`.
- The end of a command sends `_meta.terminal_exit = {exit_code, signal: null, terminal_id}`.

The terminal id is the tool call id.
The output channel follows the declaration of the client:

- A client that declares `terminal_output_delta` gets the output chunks of every command in `_meta.terminal_output_delta`.
- Otherwise, a client that declares `terminal_output` gets output chunks in `_meta.terminal_output = {terminal_id, data}`
  for a command that shows a terminal. Zed declares `terminal_output: true` and `terminal-auth: true`.
  The chunks of a read, search, or list command go to `_meta.terminal_output_delta`.
- A client that is not AIR and declares neither gets every output chunk in `_meta.terminal_output_delta`.
  This is the behavior of the adapter before the tool call contract.
- AIR that declares neither gets no output chunks.

A client that is not AIR also keeps these fields:

- The end of a command carries `rawOutput = {formatted_output, exit_code}`, with the whole output.
  A client that declares `terminal_output_delta` does not get it for a live command.
  A replayed command always carries it.
- Output that did not stream goes in one chunk at the end, for a command that shows a terminal.
  A live read, search, or list command sends this chunk only to a client that declares `terminal_output_delta`.
- The text that was written to the stdin of a command goes to the output channel as `\n<stdin>\n`.
- The output of a read, search, or list command is in `rawOutput.formatted_output`, not in `content`.

So a plain ACP client gets the output chunks in `_meta.terminal_output_delta`,
and it sees the output of every command in `rawOutput.formatted_output` when the command ends.

AIR gets no `rawOutput.formatted_output` and no `rawOutput.exit_code`.
AIR gets stdin in `_meta.terminal_input`, and the output of a read, search, or list command once in `content`.

This adapter offers no `terminal-auth` authentication method.

## Tool call contract

AIR gets this contract. Each fact goes in exactly one field.
A client that is not AIR keeps the fields of the adapter before this contract,
see [Codex items and ACP fields](#codex-items-and-acp-fields).

| Fact | The only field that carries it |
| --- | --- |
| Tool parameters | `rawInput`, once they are complete, and again only when they change |
| File text of an edit | the diff in `content`, a patch when `diffPatch` is negotiated, never also in `rawInput` |
| Result to show (read text, search hits, review verdict) | `content` |
| Result without a display form (MCP result and error, elicitation action) | `rawOutput` |
| Command output | the terminal channel that the client negotiated |
| MCP progress | none, AIR does not show it |
| Status, title, kind, locations | the field itself, only when it changes |

Rules:

- An update carries only the fields that changed since the last report of that tool call.
- Input is never copied into `title` or `_meta`, with one exception.
  The `title` of a command, a read, a search, or an MCP call names the command, the path, or the query.
  Zed shows the title as that label.
- Some input is text that the user reads: the prompt of a subagent, a reviewed action, an elicitation question.
  AIR with `rawInputRendering` gets no copy of it in `content`.
  AIR without `rawInputRendering` gets one display copy of that input in `content`.
- Output is never copied into `rawOutput` when it is in `content`.
  Output is never copied into `content` when it is in the terminal channel.
- `title` is a short label. It is not the output.
- Streamed message text is not sent again in full when the complete message arrives. This applies to subagents too.

### Adapter structure

- A `ToolReporter` per Codex item type reads the event once and produces `ToolFacts`.
- One `AcpToolCallRenderer` turns the facts into ACP fields.
  It reads the client choices from one `ClientCapabilities` object.
- `ToolFacts.standard` holds the fields of a client that is not AIR, where they differ from the contract fields.
  The renderer applies them for such a client and sends it no AIR key.
- A changed-field filter drops the fields that an earlier report of the same tool call already sent.
  It applies to the top-level fields for every client.
  It drops an unchanged `_meta` key only for AIR, because ACP defines no merge for `_meta` keys.
- The `jetbrains.air` capabilities are AIR capabilities.
  The adapter does not treat them as a generic client feature.

## Codex items and ACP fields

The table shows the fields that differ between AIR and the other clients.
A field that the table does not name is the same for every client.
The other clients get the same fields as before the AIR extensions.

| Codex item | AIR | Other clients |
| --- | --- | --- |
| `commandExecution` with one `read`, `search`, or `listFiles` action | `kind` `read` or `search`, a title that names the path or the query, `locations`. The output goes to `content` once, at completion. No terminal. | The same start. The output is in `rawOutput.formatted_output` at completion. |
| Any other `commandExecution` | `kind: execute`, `title` is the command, `rawInput = {command, cwd}`, a terminal. Output streams to `_meta.terminal_output_delta`. Stdin goes to `_meta.terminal_input`. The end sends `_meta.terminal_exit`. With `asyncTasks`, a command that keeps running gets `_meta.jetbrains.air.asyncTasks.backgrounded`. | The same start. Output and stdin follow [Zed conventions](#zed-conventions). The end also carries `rawOutput.formatted_output` and `rawOutput.exit_code`. |
| `fileChange` | `kind: edit`, `title: "Editing files"`, one `diff` block per changed file with `oldText` and `newText`. The block has `_meta.kind` `add`, `update`, or `delete`. With `diffPatch`, each block carries a Git patch. | The same, without a patch. |
| `mcpToolCall` | `kind: execute`, `title: "mcp.<server>.<tool>"`, `rawInput = {server, tool, arguments}`, `_meta.is_mcp_tool_call`. No `content`. `rawOutput = {result, error}` with the whole Codex result and error. AIR shows the text of `result` and `error.message`. No progress. | The same. The progress text goes to `_meta.mcp_output_delta`, trimmed. |
| `dynamicToolCall` | `name`, `kind: execute`, `title` is the tool, `rawInput = {arguments}`. The content items go to `content`. | The same. |
| `collabAgentToolCall`, without native subagent sessions | `kind: other`, `title` is the Codex tool name, `rawInput` holds the prompt, `senderThreadId`, `receiverThreadIds`, `agentsStates`, the model, and the effort. AIR recognizes a collaboration tool call by these three keys. Only `spawnAgent` gets `_meta.jetbrains.air.subagent: true`. Without `rawInputRendering`, one copy of the prompt in `content`. | `rawInput` also holds the Codex `status`. No `rawOutput`, no `content`, no `_meta`. |
| `subAgentActivity`, without native subagent sessions | `kind: other`, a title such as `Start subagent <name>`, `rawInput = {agentThreadId, agentPath, activityKind}`, `_meta.jetbrains.air.subagent: true`. | The same, without `_meta`. |
| Guardian approval review | `toolCallId: guardian_assessment:<reviewId>`, `kind: think`, `title: "Guardian Review"`, `rawInput = {action}`. The verdict goes to `content`. Without `rawInputRendering`, one `Action: ...` text in `content`. | One text in `content` with the status, the action, the risk, the authorization, and the rationale. The start has the whole Codex event in `rawInput`, a later report in `rawOutput`. |
| MCP elicitation shown as a permission | A standalone tool call with `rawInput = {serverName, description, schema}` or `{serverName, description, url}`. Without `rawInputRendering`, one copy of the question in `content`. | The same, with the question in `content`. |
| `webSearch` | `kind: search`, a title that names the query or the page, `rawInput = {query, action}`. | A live report has `rawInput = {type, id, query, action}`. |
| `imageGeneration` | `kind: other`, `title: "Image generation"`. The revised prompt and the image go to `content`. A saved image without data goes to `content` as a resource link. | The start has `rawInput = {id}`. The end has `rawOutput = {status, revisedPrompt, result, savedPath}`, and no resource link. |
| `plan` item (the Markdown plan of plan mode) | With `planContentDelta`, appended text in `plan_update`. | `plan_update` snapshots when the client shows plans. Otherwise the whole plan in one `agent_message_chunk` when the plan item completes. |
| Turn plan (`turn/plan/updated`) | standard `plan` with entries | The same. |
| `contextCompaction` | `compaction_update` when the client declares `session.compaction`. Otherwise a synthetic tool call with `_meta.jetbrains.air.contextCompaction`. | The same, without `_meta`. |
| `agentMessage` | `agent_message_chunk` with `_meta.jetbrains.air.phase` when Codex reports a phase. | No `_meta`. |
| Command, file change, or sandbox permission request | See [Tool call of the request](#tool-call-of-the-request). | `kind`, `status: pending`, and a generic title such as `Run command` or `Edit files`, also for a started tool call. No `_meta`. |
| `imageView`, fuzzy search, MCP startup | standard shape. A fuzzy search that finds no file sends `locations: []`. | The same. |

## Diff patch

The diff patch extension lets the adapter send one compact Git patch instead of file text snapshots.
It applies to an ACP `diff` content block.

### Activation

The adapter uses patch mode only when the client declares `diffPatch`.
The agent advertises `diffPatch` to AIR.
Without the client declaration, the adapter sends the standard `oldText` and `newText` values.

### Diff content

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
| `text` | string | One unified Git patch for the file of the block. |

The patch rules:

- The patch contains Git file headers and at least one `@@` hunk.
- Each header path is the absolute file path without its leading slash, with the `a/` or `b/` prefix.
- A Windows path uses forward slashes, for example `a/C:/work/App.ts`.
- The adapter quotes a path in C style when it contains a double quote, a backslash, or a control character, as Git does.
  It does not quote non-ASCII characters.
- A `---` or `+++` line ends with a tab when its unquoted path contains a space.
- An added file has a `new file mode 100644` header and uses `/dev/null` as the old file header.
- A deleted file has a `deleted file mode 100644` header and uses `/dev/null` as the new file header.
- A moved file has `rename from` and `rename to` headers. The block `path` is the target path.
- The patch keeps the provider bytes, including a carriage return.
- A file without a final newline ends with the `\ No newline at end of file` marker.

In patch mode, `oldText: null` and `newText: ""` are compatibility placeholders.
They are not file snapshots or changed fragments.
The receiver must use `diffPatch.text` as the change payload.
The receiver derives line counts and changed fragments from the patch.

### Fallback

The adapter sends the standard ACP diff when it cannot build a valid patch.
That diff contains meaningful `oldText` and `newText` values and has no `diffPatch`.
The adapter uses the fallback in these cases:

- The file is empty, so no hunk can express it.
- The content is binary. The content is binary when its first 8000 characters contain a NUL character.
- The patch text is larger than 1 MiB (`DIFF_PATCH_MAX_BYTES`).
- A pure rename has no hunk.
- The update hunks from Codex are malformed. In a hunk, a line that starts with `\` is valid only as the exact `\ No newline at end of file` marker.

For an update, the fallback reads the file and applies the Codex hunks.
When the adapter cannot parse or apply the hunks, it omits the block and logs the change.

### Receiver validation

A receiver accepts the patch only after the negotiation.
It validates both versions, the format, and the patch text.
If validation fails, the receiver ignores `diffPatch` and reads the standard text fields.
Unknown fields do not make a valid payload invalid.

### Codex behavior

Codex App Server supplies compact hunks for an update and the file content for an addition or a deletion.
The adapter checks the update hunks and puts its own Git headers before them.
It drops the file headers that Codex supplied, so that all headers name the same paths.
It builds one full-file patch for an addition or a deletion from the content that Codex supplied.
The adapter applies this mode to live file changes and to replayed session history.
It does not read the current file when it can forward a provider patch.

## Permission presentation

Permission decisions use the standard ACP `session/request_permission` method.
The optional `_meta.jetbrains.air.permission` record adds display text only.
It never changes which actions a client may approve.
Only AIR gets the record. It needs no AIR capability.

### Request

Every permission request contains:

- a `toolCall` that describes the action to approve;
- an ordered `options` array with every decision that the user may select;
- an optional request-level and option-level `_meta.jetbrains.air.permission` record.

```json
{
  "sessionId": "session-1",
  "toolCall": {
    "toolCallId": "command-7",
    "kind": "execute",
    "status": "pending",
    "title": "Run command",
    "rawInput": { "command": "npm test", "cwd": "/workspace" }
  },
  "options": [
    { "optionId": "allow_once", "name": "Yes, proceed", "kind": "allow_once" },
    { "optionId": "cancel", "name": "No, and tell Codex what to do differently", "kind": "reject_once" }
  ],
  "_meta": {
    "jetbrains": {
      "air": {
        "version": 1,
        "permission": {
          "version": 1,
          "title": "Run command?",
          "description": "The test suite needs to run outside the current sandbox."
        }
      }
    }
  }
}
```

The client makes a decision by returning one of the advertised `optionId` values.
It must not derive a decision from the option label, the `kind`, or the metadata.
The adapter keeps the exact Codex decision of each option and returns that value to Codex.

### Presentation record

| Field | Level | Required | Meaning |
| --- | --- | --- | --- |
| `version` | request, option | yes | Must equal `1`. |
| `title` | request | yes | The approval heading. |
| `description` | request | no | The non-blank reason that Codex supplied. |
| `description` | option | yes | What the option does. Only MCP elicitation options carry it. |

The request titles are `Run command?`, `Allow network access?`, `Make edits?`, and `Grant permissions?`.
The adapter does not copy action payloads into the metadata.

### Tool call of the request

The `toolCall` is an ACP `ToolCallUpdate`. The client merges it into the stored tool call.

- The request always carries `toolCallId`, `title`, and `rawInput`.
- `rawInput` holds the structured command, working directory, URL, or permission profile.
- `locations` holds the affected paths when Codex supplies them.
- `content` holds details that do not fit a location, such as a network host, a filesystem glob, or a special Codex scope.
- When the client already has the command or file-change tool call, the request omits `status` and `kind`.
  The title is then the title that the tool call already shows.
  The request does not reset a started tool call to `pending`.
- A network approval has its network title.
- An approval of an MCP tool call that already started carries only `toolCallId` and `status: pending`.
- The question of a standalone MCP elicitation is in `rawInput.description`.
  A client without `rawInputRendering` also gets it as text in `content`.

A client that is not AIR gets the request tool call of the adapter before the AIR extensions.
It always carries `kind` and `status: pending`, and a generic title such as `Run command`, `Edit files`, or a network title.
Its `locations` hold every path of the Codex command actions.

Command approvals use `kind: execute`. File changes use `kind: edit`.
Additional sandbox permissions use `kind: other`. A URL authorization fallback uses `kind: fetch`.
For a file change, the locations come from the matching Codex `fileChange` item.
The adapter does not present `grantRoot` as though every file below it changes.

### Command and network decisions

When Codex sends `availableDecisions`, that ordered list is authoritative.
An older Codex version that omits the list gets the native Codex fallback decision set.

| Codex decision | ACP option kind | Meaning |
| --- | --- | --- |
| `accept` | `allow_once` | Approve this execution once. |
| `acceptForSession` | `allow_always` | Approve the command, host, or requested permissions for this session. |
| `acceptWithExecpolicyAmendment` | `allow_always` | Approve and install the exact proposed command-prefix rule. |
| network amendment with `allow` | `allow_always` | Approve and install the exact proposed allow rule. |
| network amendment with `deny` | `reject_always` | Reject and install the exact proposed deny rule. |
| `decline` | `reject_once` | Reject this execution and continue the turn. |
| `cancel` | `reject_once` | Reject this execution and stop the pending operation. |

The adapter returns an exec-policy or network amendment as the exact structured value that Codex supplied.
It rejects an amendment that does not match the proposal.
It hides an exec-policy option whose prefix contains a line break, as the native Codex UI does.
An unknown, malformed, empty, or inconsistent decision set fails closed with `cancel`.
The adapter does not invent replacement choices.

### File changes

| ACP option | Kind | Codex decision |
| --- | --- | --- |
| `Yes, proceed` | `allow_once` | `accept` |
| `Yes, and don't ask again for these files` | `allow_always` | `acceptForSession` |
| `No, and tell Codex what to do differently` | `reject_once` | `cancel` |

The protocol enum also contains `decline`.
The native Codex file-change prompt does not offer it, so the adapter does not offer it.

### Additional sandbox permissions

Codex can request a structured network and filesystem permission profile.
The adapter returns only permissions from that requested profile.
Codex intersects the response with the original request.

| User choice | Scope | `strictAutoReview` |
| --- | --- | --- |
| Grant for this turn | `turn` | `false` |
| Grant for this turn with strict auto review | `turn` | `true` |
| Grant for this session | `session` | `false` |
| Continue without permissions | `turn` | `false` |

Strict auto review is turn-scoped on purpose.
It sends the later actions of that turn through Codex review, also when the sandbox policy allows them.
The adapter never combines it with a session-scoped grant.
Cancellation, an unknown option, a stale turn, or a missing handler returns an empty profile with turn scope and `strictAutoReview: false`.

### MCP elicitation approvals

A message-only MCP elicitation uses `session/request_permission`.
The client then gets the same decision matrix as the native Codex UI.
Codex offers durable choices through the request `_meta.persist`.
The adapter never creates a persistence scope that the server did not offer.

| Condition | ACP option | MCP response |
| --- | --- | --- |
| always | `Allow` | `action: accept` |
| `persist` contains `session` | `Allow for this session` | `action: accept`, `_meta.persist: session` |
| `persist` contains `always` | `Always allow` | `action: accept`, `_meta.persist: always` |
| request is not a tool approval | `Deny` | `action: decline` |
| always | `Cancel` | `action: cancel` |

A tool-call approval has no `Deny` choice. Cancellation stops the tool call.
For an ordinary MCP request, `Deny` declines the request and the turn continues. `Cancel` stops the request.
A tool-call approval carries `_meta.is_mcp_tool_approval: true`.

A structured form or URL elicitation uses the ACP elicitation capability when the client declares it.
The adapter cancels a structured form that the client cannot render.
A permission fallback would lose required input.
A message-only or URL request can use the permission fallback, because no field values are lost.

The Codex app-server omits the MCP request identity from form-mode elicitation parameters.
The adapter links the request to an MCP tool call only when exactly one pending call for that thread and server exists.
An ambiguous request gets a unique standalone `toolCallId` and includes the full message and schema.

### Lifecycle and safety

A permission prompt belongs to the active Codex turn.
The adapter rejects a request for a stale or interrupted turn without opening client UI.
Cancellation, an unadvertised `optionId`, a transport failure, and a malformed response all fail closed.
The adapter does not rebuild provider effects from ACP `kind` values.
`allow_always` describes presentation intent. It does not create a policy rule.
Only the exact Codex decision of the selected `optionId` can do that.

The active permission surface is the app-server v2 request methods:

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/permissions/requestApproval`
- `mcpServer/elicitation/request`

The deprecated `execCommandApproval` and `applyPatchApproval` methods are not a second permission pipeline.

## Plan content delta and plan review

### Plan stream

AIR accepts a plan in one of two modes: streamed text, or a path to a file that AIR follows. An agent that writes
its plan to a file sends the path. Codex keeps the plan only as text, so this adapter always uses the streamed mode.
It does not declare the AIR `planFile` capability.

Codex writes a Markdown plan in plan mode. The adapter streams it:

- A client that declares the draft `clientCapabilities.plan` gets `plan_update` with `plan = {type: "markdown", planId, content}`.
  The adapter throttles these updates to one per 150 ms.
- With `planContentDelta`, the first report of a plan carries the whole text.
  Each later report carries `plan.content: ""` and the appended text in `_meta.jetbrains.air.contentDelta`.
  The client appends that text to the plan content.
- Without `planContentDelta`, each report is a full `plan_update` snapshot.
- AIR without plan updates gets the plan as `agent_message_chunk` text with `phase: final_answer`.
- Another client without plan updates gets the whole plan in one `agent_message_chunk` when the plan item completes.

The completed plan item is authoritative. The stream sends only what the client does not have yet.
When a completed plan differs from the streamed text, the adapter sends a snapshot.

```json
{
  "sessionUpdate": "plan_update",
  "plan": { "type": "markdown", "planId": "item-1", "content": "" },
  "_meta": { "jetbrains": { "air": { "version": 1, "contentDelta": "\n3. Run the tests." } } }
}
```

### Plan review

After a completed plan, the adapter asks the user whether to implement it.
Every client gets the same request:

- `toolCallId: plan-review:<planItemId>`, `kind: switch_mode`, `title: "Implement this plan?"`.
- The plan text in `toolCall.rawInput.plan`. AIR reads the plan of the review there.
- Options `implement_plan` (`allow_once`) and `revise_plan` (`reject_once`).
- No `_meta`.

The final update of that tool call puts the decision text in `rawOutput`.

## Goal

The goal extension exposes a long-running, session-scoped objective.
It is shaped like a possible future first-class ACP API.
The adapter sends no other goal key.
Only AIR gets the goal capability and the goal snapshots.
Another client gets no goal key and no `session_info_update` for a goal.

### Capability

The `initialize` response advertises the goal support:

```json
{ "version": 1, "controlMethod": "_session/goal", "actions": ["set", "pause", "resume", "clear"] }
```

`actions` is the subset of `set`, `pause`, `resume`, and `clear` that the adapter supports.
A client must not assume support for an action that is not advertised.

### Control request

The client sends `_session/goal` with `sessionId` and `action`.
`set` also requires a non-blank `objective`.
`/goal` stays the user-facing way to set, pause, resume, or clear a goal.
The adapter still accepts `_codex/session/goal_control` as a legacy alias. It does not advertise the alias.

### Session state

The adapter publishes the current snapshot in `session_info_update._meta.jetbrains.air.goal`.
Clearing a goal publishes `goal: null`.

```json
{
  "objective": "Ship the change",
  "status": "active",
  "createdAt": 1710000000000,
  "updatedAt": 1710000012000,
  "tokenBudget": null,
  "tokensUsed": 42,
  "timeUsedSeconds": 12,
  "controlMethod": "_session/goal"
}
```

The statuses are `active`, `paused`, `blocked`, `limited`, and `complete`.
Timestamps are Unix milliseconds.

### Lifecycle

A goal belongs to the ACP session, not to one `session/prompt` request.
Goal activity and prompt activity are independent:

- `status: active` means that the objective can drive more work. It does not mean that a prompt runs now.
- A prompt completes when its backend turn reaches a quiet boundary, also when the goal stays active.
- A later autonomous cycle can publish more session updates outside that completed prompt.
- While a turn runs, a client uses steering or prompt queueing when advertised.
  While the session is quiet, a client can send an ordinary `session/prompt`.

This separation keeps a goal from holding the prompt slot of the session.
A client can show "working now" apart from "objective still active".

### Codex mapping

Codex `thread/goal/*` notifications map into the neutral snapshot.
The provider statuses `usageLimited` and `budgetLimited` map to `limited`.
The adapter converts the Codex timestamps from seconds to milliseconds.
It skips an update that does not change the snapshot.

## Recommended config values

The `recommendedValue` extension lets a client show the Codex recommendation apart from the current selection.
It applies to the `model` and `reasoning_effort` config selectors.

When the client declares `recommendedValue`, a selector with a recommendation carries:

```json
{ "_meta": { "jetbrains": { "air": { "version": 1, "recommendedValue": "medium" } } } }
```

- The recommended model is the available model that Codex marks `isDefault`.
- The recommended effort is the `defaultReasoningEffort` of the current model.
- The adapter sends a value only when the selector offers it as an option.
- `recommendedValue` is independent of `currentValue`. An explicit user choice stays current.
- After a model switch, the adapter computes the effort recommendation again for the new model.

Without the capability, the config options keep their old shape and carry no recommendation.

## Async tasks

Codex app-server owns shell commands that keep running after their tool call.
The adapter exposes them as async tasks when the client declares `asyncTasks`.
Without the capability, the adapter sends no async task update.

### Lifecycle

- The adapter reads the active processes from `thread/backgroundTerminals/list`.
- Before the spawn update, it marks the command tool call with `_meta.jetbrains.air.asyncTasks.backgrounded: true`.
  AIR then keeps the command card active without a second copy of its output.
- It sends `async_task_spawned` with `taskType: "shell"`, `showInTranscript: false`, `canStop: true`, and `toolCallId`.
  The name is the command title. The existing command card owns the output.
- For a root command, the command item id is both the async task id and the tool call id.
- A child command prefixes its task id with the child thread id, so task ids stay distinct across native subagent sessions.
  The tool call id stays the command item id. The adapter publishes the task on the child session.
- When the command ends, the adapter sends `async_task_state_update` with `completed` or `failed`.
- The active-terminal list repairs a lost completion event.
  The adapter reports `stopped` when an announced terminal leaves that list.
- Session loading restores root and child tasks after it replays their command history.
- A provider restart stops the old tasks and moves task control to the new app-server client.
- When the app-server exits, the adapter reports each unfinished task as `failed`.

The app-server process id stays an internal control handle.

### Stop request

The client sends `_session/async_task/stop`:

```json
{ "sessionId": "thread-id", "asyncTaskId": "command-item-id" }
```

The adapter resolves the process id and calls `thread/backgroundTerminals/terminate`.
It returns `{ "stopped": true }` after app-server accepts the termination.

## Agent file-change report

Standard ACP describes a change from one tool call. It has no complete file list for one prompt turn.
The version 1 `agentFileChangeReport` extension adds that list.

### Request

The client declares `agentFileChangeReport` and adds this object to `session/prompt`:

```json
{ "_meta": { "jetbrains": { "air": { "agentFileChangeReportRequest": { "version": 1, "requestId": "a-unique-request-id" } } } } }
```

The request object must have exactly the keys `version` and `requestId`, and `version` must be `1`.
The request id has 1 to 128 characters: ASCII letters, digits, `.`, `_`, `:`, and `-`.
The adapter ignores a malformed request.

### Report

The adapter sends one `session_info_update` before the `PromptResponse`:

```json
{
  "sessionUpdate": "session_info_update",
  "_meta": {
    "jetbrains": {
      "air": {
        "version": 1,
        "agentFileChangeReport": {
          "version": 1,
          "requestId": "a-unique-request-id",
          "status": "reported",
          "paths": ["/workspace/src/App.ts"],
          "declaredComplete": false,
          "truncated": false,
          "uncertainty": "Codex turn diffs may omit same-content renames and changes made outside apply_patch, including shell commands, version-control commands, generators, and child processes."
        }
      }
    }
  }
}
```

- Each path is an absolute normalized path in the working directory or in an additional workspace directory.
- The report has no file content, diff, line count, or path order guarantee.
- The adapter sends at most 1,024 paths. Each path has at most 4,096 characters.
- The serialized report has at most 256 KiB. The optional `uncertainty` has at most 2,000 characters.
- The adapter rejects a turn diff larger than 8 MiB before it parses it.

### Codex source

The adapter derives the report from the final aggregated `turn/diff/updated` snapshot of the main turn.
It does not run an extra model turn.
It keeps the Codex `cwd_relative_turn_diffs` feature disabled, so paths are relative to the Git root.
The Codex snapshot tracks `apply_patch` changes.
It can omit same-content renames and changes from shell commands, version-control commands, generators, or child processes.
The adapter therefore sends `declaredComplete: false` and explains the limit in `uncertainty`.

### Unavailable report

The adapter sends `status: "unavailable"` with a `reason`:

| Reason | Cause |
| --- | --- |
| `cancelled` | The prompt was cancelled. |
| `invalidOutput` | The turn diff is invalid. |
| `notReported` | No provider turn ran. |
| `providerError` | The provider failed. |

The `timeout` reason stays in the version 1 wire contract for backward compatibility. This adapter does not produce it.
A report failure does not change the prompt outcome.
A failure of the main turn still follows the normal prompt error behavior.

The client must match the request id.
It must ignore a duplicate, stale, malformed, or unavailable report.
Rollback is outside this extension. The adapter advertises no `undo` or `rollback` command.

## Session failure

The `sessionFailure` extension sends warnings and errors as durable transcript entries.
The client shows them in order beside user, agent, and tool messages.
They are not assistant text and not temporary banners.

### Activation

The extension is active when the client declares `sessionFailure`.
Without it, the adapter keeps the legacy behavior:
JSON-RPC errors, `Warning:` and `Config warning:` text chunks, and `session_info_update._meta.codex.error`.

A client can also declare the ACP `clientCapabilities.session.notices`.
Then a `warning`, `configWarning`, or `deprecationNotice` notification goes out as an ACP `notice` session update.
It does not go out as a `sessionFailure` record. Errors still use `sessionFailure`.

### Record

```json
{
  "_meta": {
    "jetbrains": {
      "air": {
        "version": 1,
        "sessionFailure": {
          "id": "turn-7:error",
          "revision": 1,
          "category": "limit",
          "severity": "error",
          "title": "You've hit your usage limit.",
          "actions": []
        }
      }
    }
  }
}
```

| Field | Required | Type | Meaning |
| --- | --- | --- | --- |
| `id` | yes | non-empty string | Stable identity of one incident. |
| `revision` | yes | positive integer | Increasing version of that incident. |
| `category` | yes | category | Broad visual group. |
| `severity` | yes | `warning` or `error` | Inline warning or error presentation. |
| `title` | yes | string | The complete user-facing text. |
| `details` | no | string | Long text that does not fit in `title`. |
| `actions` | yes | ordered string array | Recovery actions that the adapter recommends. |

### Identity and revisions

- The first record of an incident creates one transcript entry at the current stream position.
- The same `id` with a higher `revision` updates that entry in place.
- The client ignores the same or a lower revision.
- A later, independent incident gets a new `id`.
- A turn failure uses `<turnId>:error`. A later incident in the same scope uses `<scope>:error:<epoch>:<n>`.
- A notice uses `<sessionId>:notice:<epoch>:<n>`. Consecutive equal notices reuse the id with a higher revision.

### Delivery

- A terminal failure of the running turn goes on the `PromptResponse._meta` with `stopReason: end_turn`.
  The response keeps `_meta.quota` next to it.
- A retry warning, a failure of another turn, a failure after the prompt ended, and a notice go in a `session_info_update`.
- A warning does not end a turn.

### Categories and actions

| Codex condition | Category | Actions |
| --- | --- | --- |
| `httpConnectionFailed`, `responseStreamConnectionFailed`, `responseStreamDisconnected`, `responseTooManyFailedAttempts`, app-server exit | `connection` | `retry`, `new_session` |
| `unauthorized`, HTTP 401 | `access` | `login` |
| `rateLimitExceeded`, HTTP 429 | `limit` | `retry` |
| `usageLimitExceeded` | `limit` | none |
| `contextWindowExceeded`, `sessionBudgetExceeded` | `limit` | `new_session` |
| `cyberPolicy`, `misalignmentPolicyViolation`, `badRequest` | `request` | none |
| `serverOverloaded` | `service` | `retry` |
| `internalServerError`, an unexpected adapter error | `service` | `retry`, `new_session` |
| `threadRollbackFailed`, `sandboxError`, `activeTurnNotSteerable`, `other`, unknown | `service` | `retry` |
| `warning`, `configWarning`, `deprecationNotice` notifications | `unknown` | none |

A retry warning (`willRetry: true`) has `severity: warning` and no actions.
A notice has `severity: warning`.
A `deprecationNotice` is shown only to a client with the capability. Other clients never saw it.

The actions of version 1 are `retry`, `login`, and `new_session`.
The client filters the actions that it cannot run and ignores unknown or duplicate values.
The client must not infer actions from the category.

### Title and details

The title is the Codex error or warning message.
An app-server exit uses `Connection to Codex was lost.`
An unexpected adapter error uses `Codex encountered an internal error.`
A notice with details puts `summary — details` in the title when that fits in 240 characters.
Otherwise the summary goes to `title` and the details go to `details`.

### Recovery

Recovery is internal adapter state and is not sent.
A retry warning stops being active when Codex produces turn content again.
A successful turn ends an active warning of that turn.
Recovery never removes the transcript record.

## Native subagent sessions

The adapter implements the draft [ACP subagent RFD](https://github.com/agentclientprotocol/agent-client-protocol/pull/1992).
[Subagent sessions](subagent-sessions.md) describes the lifecycle.
This section covers only the AIR bridge.

- The canonical client field is `clientCapabilities.subagents: {}`.
- Released ACP SDKs can strip that draft field.
  AIR can instead declare `nativeSubagentSessions` in `_meta.jetbrains.air.capabilities`.
- Either signal enables native subagent sessions. New clients must prefer the canonical field.
- The agent always advertises `agentCapabilities.sessionCapabilities.subagents`. It advertises `nativeSubagentSessions` to AIR.
- Without either signal, a Codex subagent stays an ordinary tool call.
  AIR gets `_meta.jetbrains.air.subagent: true` on a spawn. Another client gets the tool call without `_meta`.

## Context compaction

The adapter implements the ACP session compaction RFD. See [Session compaction](session-compaction.md).
A client that does not declare `session.compaction` gets a synthetic tool call instead:

- `toolCallId` is the Codex item id, `title: "Compact conversation"`, `kind: think`.
- For AIR, each report carries `_meta.jetbrains.air.contextCompaction = {version: 1}`.
  The standard `toolCallId` and `status` own the identity and the phase.
  Another client gets the tool call without `_meta`.
- Codex supplies no trigger, token counts, or duration, so the record has only `version`.

## Session fork point

AIR can fork a session at one agent message.
It adds this object to the `session/fork` request:

```json
{ "_meta": { "jetbrains": { "air": { "fork": { "version": 1, "messageId": "item-12", "messageFingerprint": "sha256:<64 hex>", "messageOccurrence": 1 } } } } }
```

- The adapter reads the object only when `version` is `1`.
- `messageId` must be a non-empty string.
  An id with a `:segment:<n>` suffix also matches the message without the suffix.
- `messageFingerprint` is optional. It is `sha256:` and the SHA-256 hex digest of the message text.
  The adapter uses it when no item has the id.
- `messageOccurrence` is optional, a positive integer, and `1` by default.
  It selects among agent messages with the same fingerprint.
- An invalid field fails the request with `invalidParams`.
- When no message matches, the request fails with `invalidParams`.
- The fork keeps the history up to the turn that holds the message.

## Presentation hints

The adapter sends these keys only to AIR:

- `agent_message_chunk._meta.jetbrains.air.phase` carries the Codex phase of the message, for example `final_answer`.
- Each session mode and each value of the `mode` config option carries `_meta.jetbrains.air.kind`.
  `read-only` is `standard`, `agent` is `auto_review`, and `agent-full-access` is `full_access`.
- An available command can carry `_meta.jetbrains.air.commandAction`:
  - `/plan` has `{kind: "setConfigOption", configId, value, resetValue, presentation: "state"}`. It switches the collaboration mode to plan.
  - `/goal` has `{kind: "prefixPrompt", presentation: "state"}`.

## Removed keys

These keys moved into the AIR namespace.
AIR gets only the new key. A client that is not AIR gets neither the old key nor the new key.

| Old key | New key |
| --- | --- |
| `agent_message_chunk._meta.codex.phase` | `_meta.jetbrains.air.phase`, same values |
| `initialize._meta.goal`, `session_info_update._meta.goal` | `_meta.jetbrains.air.goal`, same shape |
| mode `_meta.kind`, config option value `_meta.kind` | `_meta.jetbrains.air.kind` |
| available command `_meta.commandAction` | `_meta.jetbrains.air.commandAction` |
| tool call `_meta.contextCompaction` | `_meta.jetbrains.air.contextCompaction` |

The adapter does not send these keys to any client:

- `_meta.codex.subagent` and `_meta.codex.collaboration`;
- the plan review `_meta.codex.kind` and `_meta.codex.planItemId`;
- the permission `_meta.permission`, replaced by `_meta.jetbrains.air.permission`;
- the diff `_meta.jetbrains.air.diffStats`.

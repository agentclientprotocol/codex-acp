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
- [Session index](#session-index)
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
  no output after a tool call ended, and a terminal status for a replayed image generation.
- Feature changes for every client: the `/mcp` command has a new description and an input hint.
- The client gets no AIR-only key.
  That is no `_meta.jetbrains.air` key and none of the earlier keys in [Removed keys](#removed-keys).
- The output of a command arrives once, in the chunks or in `content`, as [Zed conventions](#zed-conventions) describe.
  The adapter no longer repeats it in `rawOutput.formatted_output`.

The keys of Zed, of upstream ACP, and of other JetBrains teams stay as they were.
See [JetBrains shared keys](#jetbrains-shared-keys) and [Zed conventions](#zed-conventions).
[Codex items and ACP fields](#codex-items-and-acp-fields) lists the fields of each client.

The scenario tests in `src/__tests__/scenarios/` record every outbound message for three client profiles.
This includes the `_auth/status_update` notification and the `available_commands_update` of the session start.
The profiles are a plain ACP client, Zed, and AIR.
The tests validate only the standard ACP messages against the ACP schema.
The ACP schema does not define the AIR session updates of subagents and async tasks.
For these updates, the tests check only the `SessionNotification` envelope: the `sessionId`, the update kind, and `_meta`.
The ACP schema also defines no `_auth/status_update`, so the tests validate it against the payload in `src/AuthStatusMeta.ts`.
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
          "planContentDelta",
          "codexHooks"
        ]
      }
    }
  }
}
```

The agent list does not depend on the client capability list, except for `sessionIndex`.
The agent lists `sessionIndex` only when the client declared it, because AIR builds without it use
`session/list` and `session/delete` the old way. Exactly then it also lists `sessionArchive`, `sessionRename` and
`sessionListSubscribe`, which name requests of the session index; the client does not declare those three, and
declaring them without `sessionIndex` enables nothing.
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
| `codexHooks` | Lets AIR review and trust startup hooks before it opens a session. | [Hook trust](#hook-trust) |
| `sessionIndex` | Serves `session/list` as the session index of AIR, as the ACP session list extensions RFD and RFD #2161 describe, adds rename and archive requests, and pushes the changed rows of a cwd to a subscription. | [Session index](#session-index) |

Three agent capabilities come with `sessionIndex` and are listed exactly when it is. The client does not declare them:

| Agent capability | What it tells the client | Section |
| --- | --- | --- |
| `sessionArchive` | The agent serves `_session/archive` and `_session/unarchive`. | [Requests](#requests) |
| `sessionRename` | The agent serves `_session/rename`. | [Requests](#requests) |
| `sessionListSubscribe` | The agent serves `_session/list/subscribe` and `_session/list/unsubscribe` and sends `_session/list/changes`. | [Session list subscription](#session-list-subscription) |

The goal extension has no client capability.
The agent advertises the `goal` object, and the client uses the control method when it wants to.

### Hook trust

The adapter passes `CODEX_CONFIG.hooks` to Codex App Server at startup as a TOML override and removes them from the later thread config.
This lets AIR review the same process that will open the session. The adapter keeps other session config fields unchanged.
Codex validates the hooks itself. If they are malformed, App Server exits at startup and `initialize` fails with the Codex error.

AIR sends `_codex/hooks/list` with `{ "cwd": "/project" }` after `initialize`. The response contains only `sessionFlags` hooks.
Each hook includes its key, event, matcher, source path, status, timeout, enabled/managed state, current hash, trust status, and handler metadata.
Command hooks include the command; MCP hooks include the server and tool.
Codex does not expose the prompt or agent definition in this list response.
AIR can show their metadata and hash but cannot display or compare their full definitions.
The response also carries Codex warnings and path-specific errors; these do not hide hooks that Codex could list.

After consent, AIR sends `_codex/hooks/trust` with the directory and a list of `{ "key": "...", "currentHash": "..." }` values.
The adapter lists the hooks again. It writes only unchanged `sessionFlags` hashes and then checks that Codex reports `trusted`.
The response is `{ "trusted": true }` only when every requested hook is trusted. The adapter exposes no general config write method.

Codex stores the accepted hash in `hooks.state."<key>".trusted_hash` in `$CODEX_HOME/config.toml`.
This state is shared by Codex CLI and all projects using that Codex home; it is not scoped to a project.
If different project hooks or hook versions reuse a key, accepting a new hash replaces the old hash for that key.
The earlier definition will then need consent again. Project-specific bundled skills should account for this shared trust state.

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
| `skillPath` | available command `_meta.jetbrains.air` of a `$skill` command | OS-native absolute path of the skill's `SKILL.md`, not a URI | AIR |
| `customAnswer` | `request_user_input` note field of an elicitation schema, `_meta.jetbrains.air` | `true` | AIR. The same field also carries the root key `_meta._askUserQuestionCustomAnswer: true`, because released AIR versions read only that key. |

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
| `quota` | `PromptResponse._meta.quota` | Token usage of the whole turn, the same counts as `PromptResponse.usage`: `token_count` and one `model_usage` entry for the current model, or `null` and `[]` when Codex reported no usage for the prompt, as for a prompt that started no turn. |
| `authStatus` | `initialize` response `agentCapabilities._meta.authStatus` | The agent pushes `_auth/status_update`. The object carries no payload. |

## Zed conventions

The adapter keeps these Zed conventions for every client:

- A command tool call has `content: [{type: "terminal", terminalId}]` and `_meta.terminal_info = {cwd, terminal_id}`.
- The end of a command sends `_meta.terminal_exit = {exit_code, signal: null, terminal_id}`.

The terminal id is the tool call id.

The output of a command goes to the client once. The chunk channel follows the declaration of the client:

- A client that declares `terminal_output_delta` gets the output chunks of every command in `_meta.terminal_output_delta`.
- Otherwise, a client that declares `terminal_output` gets output chunks in `_meta.terminal_output = {terminal_id, data}`
  for a command that shows a terminal. Zed declares `terminal_output: true` and `terminal-auth: true`.
  Zed shows `terminal_output` only in a terminal, so a read, search, or list command has no chunk channel.
- A client that is not AIR and declares neither gets every output chunk in `_meta.terminal_output_delta`.
  This is the behavior of the adapter before the tool call contract.
- AIR that declares neither gets no output chunks.

A client that is not AIR gets the output of a command in one of two ways:

- With a chunk channel, the output goes only to the chunks. Output that did not stream goes in one chunk at the end,
  also for a replayed command. The text that was written to the stdin of a command goes to the chunks as `\n<stdin>\n`.
- Without a chunk channel, the whole output goes once to `content` as text at the end.
- The end of a command without a terminal carries `rawOutput = {exit_code}`. A terminal command sends its exit in `terminal_exit`.
  No client gets `rawOutput.formatted_output`: Zed shows `rawOutput` only when `content` is empty, and the chunks or `content` hold the output already.

AIR gets the output of a command that shows a terminal in `_meta.terminal_output_delta`, and stdin in `_meta.terminal_input`.
It gets the output of a read, search, or list command once, as `rawOutput` text at the end.
AIR stores `rawOutput` text as an output stream and moves a large one to a file.

This adapter offers no `terminal-auth` authentication method.

## Tool call contract

AIR gets this contract. Each fact goes in exactly one field.
A client that is not AIR keeps the fields of the adapter before this contract,
see [Codex items and ACP fields](#codex-items-and-acp-fields).

| Fact | The only field that carries it |
| --- | --- |
| Tool parameters | `rawInput`, once they are complete, and again only when they change |
| File text of an edit | the diff in `content`, a patch when `diffPatch` is negotiated, never also in `rawInput` |
| Result to show (review verdict, tool text) | `content` |
| Result without a display form (MCP result and error, elicitation action) | `rawOutput` |
| Command output | the chunk channel of a command with a terminal. Read, search, and list output as `rawOutput` text at the end |
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
| `commandExecution` with one `read`, `search`, or `listFiles` action | `kind` `read` or `search`, a title that names the path or the query, `locations`. No terminal. The whole output is `rawOutput` text at completion, from `aggregatedOutput`. No chunks. | The same start. The output follows [Zed conventions](#zed-conventions): chunks, or `content` text at completion. |
| Any other `commandExecution` | `kind: execute`, `title` is the command, `rawInput = {command, cwd}`, a terminal. Output streams to `_meta.terminal_output_delta`. Stdin goes to `_meta.terminal_input`. The end sends `_meta.terminal_exit`. With `asyncTasks`, a command that keeps running gets `_meta.jetbrains.air.asyncTasks.backgrounded`. | The same start. Output and stdin follow [Zed conventions](#zed-conventions). The output goes only to the chunks. |
| `fileChange` | `kind: edit`, `title: "Editing files"`. With `diffPatch`, one `diff` block per changed file carries a Git patch. Without a patch, see [Fallback](#fallback): one block per hunk of an update, the whole text of an added or a deleted file. The block has `_meta.kind` `add`, `update`, or `delete`. | The same, without a patch. |
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
- The patch text is larger than 1 MiB (`DIFF_PATCH_MAX_BYTES`), while the Codex diff itself is not.
- A pure rename has no hunk.
- The update hunks from Codex are malformed. In a hunk, a line that starts with `\` is valid only as the exact `\ No newline at end of file` marker.
  The hunks must follow each other in the old file without an overlap.
  The new start line of each hunk must equal its old start line plus the line count change of the hunks before it.

The standard diff comes from the Codex diff alone. The adapter never reads the file.

- An update gets one diff block per Codex hunk. `oldText` and `newText` hold the context lines and the changed lines of the hunk, not the whole file.
  A line keeps its line break, except a line that the `\ No newline at end of file` marker follows.
- A pure rename gets one block for the new path, with empty `oldText` and `newText`.
- An added or a deleted file gets its whole text, because the change is the whole file.
- A Codex diff larger than 1 MiB gets no block. The tool call still names the change in its title.

When the adapter cannot parse the hunks, it omits the block and logs the change.
These rules apply to every client, because the standard diff is the ACP diff.

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
AIR gets the goal capability and snapshots as before.
A client that is not AIR can opt in by declaring `clientCapabilities._meta.goal: {}`.
Another client gets no goal key and no `session_info_update` for a goal.

### Capability

The `initialize` response advertises the goal support:

```json
{ "version": 1, "controlMethod": "_session/goal", "actions": ["set", "pause", "resume", "clear"] }
```

`actions` is the subset of `set`, `pause`, `resume`, and `clear` that the adapter supports.
A client must not assume support for an action that is not advertised.
AIR receives the capability in `_meta.jetbrains.air.goal`.
An opted-in client that is not AIR receives it in `_meta.goal`.

### Control request

The client sends `_session/goal` with `sessionId` and `action`.
`set` also requires a non-blank `objective`.
`/goal` stays the user-facing way to set, pause, resume, or clear a goal.
The adapter still accepts `_codex/session/goal_control` as a legacy alias. It does not advertise the alias.

### Session state

The adapter publishes the current snapshot in `session_info_update._meta.jetbrains.air.goal` for AIR
and `session_info_update._meta.goal` for an opted-in client that is not AIR.
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

`unauthorized` and HTTP 401 get no session failure. The prompt ends with the ACP `authRequired` error, and the client starts the ACP login flow.

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

## Session index

AIR uses `session/list` as its index of Codex threads when it declares `sessionIndex`.
Everything in this section applies only to such a client. The `initialize` answer to it lists `sessionIndex`,
`sessionArchive`, `sessionRename` and `sessionListSubscribe` in `_meta.jetbrains.air.capabilities`.
Another client, AIR included, keeps the old `session/list`, `session/delete` and `initialize` answers.

The extension follows two ACP RFDs field for field: the session list extensions RFD (`limit`, order, row fields)
and [RFD #2161](https://github.com/agentclientprotocol/agent-client-protocol/pull/2161)
(archive). Only the transport differs, see [Relation to the ACP RFDs](#relation-to-the-acp-rfds). The
[session list subscription](#session-list-subscription) is the adapter's own.

### List

The request can carry `_meta.jetbrains.air.list`:

```json
{ "cwd": "/repo", "cursor": null, "_meta": { "jetbrains": { "air": { "list": { "limit": 50, "archived": "unarchived", "includeWorktrees": false } } } } }
```

- `limit`: omitted or `null` is `50`. An integer of at least 1 is clamped to `100`; the adapter never answers more
  rows. Anything else (a string, a fraction, `0`, a negative number, `NaN`, `Infinity`, a boolean, an object) fails
  with `-32602`.
- `archived` is a string with three values. Omitted or `null` is `"unarchived"`. Any other value fails with
  `-32602`.
  - `"unarchived"`: unarchived threads only, one `thread/list` with `archived: false`.
  - `"archived"`: archived threads only, one `thread/list` with `archived: true`.
  - `"all"`: unarchived and archived threads in one list, see below.
- `includeWorktrees` is a boolean. Omitted or `null` is `false`. Any other value fails with `-32602`.
  - `false`: `cwd` matches exactly, plus its canonical path when that differs (symlinks).
  - `true`: also the same relative subdirectory of `cwd` in the primary checkout and in each linked Git
    worktree: for `<repo>/src/app`, `<worktree>/src/app`. The adapter reads
    `<git-common-dir>/worktrees/*/gitdir` and never runs Git, as the Codex TUI does. A worktree whose directory is
    gone is left out. The worktrees of a bare repository count too; the primary checkout is added only when there
    is one. Each row reports its own real `cwd`.
- The adapter sends `thread/list`
  `{cwd, limit, sortKey: "recency_at", archived, sourceKinds: [], modelProviders: [], useStateDbOnly: true, cursor}`.
  - `cwd` is a string for a single path and an array otherwise.
  - `archived` of `thread/list` is a boolean: `false` for `"unarchived"`, `true` for `"archived"`.
  - Codex lists unarchived and archived threads apart, so `"all"` sends one request with `archived: false` and one
    with `archived: true` at the same time, and merges the two by recency, ties unarchived first. A row is answered
    only when no unread Codex page can hold a newer one. An empty Codex page that has a cursor tells nothing about
    that, so the adapter reads on in that list first; these reads count against the budget below.
  - `sourceKinds: []` means the interactive sources, so `codex exec` runs and subagent threads are not listed.
  - `modelProviders: []` means every provider, whatever the login of the agent.
  - Codex deletes a thread with `thread/delete`, so a deleted thread is never listed, whatever `archived` is.
- A relative `cwd` keeps the basename filter of the old path: the adapter sends the requests above without `cwd`
  and with `limit: 100`, filters each page by the basename of `Thread.cwd`, gathers the matches of several Codex
  pages up to `limit` and cuts them to it.
  No `cwd` lists every thread.
- Rows are ordered by last user activity, `lastPromptAt ?? updatedAt`, newest first, ties in the Codex order:
  Codex sorts by `recency_at`, which it moves when a turn starts.
- `title` is the first non-blank of `Thread.name`, `title`, `summary` and `preview`, collapsed to one line, as AIR's
  native Codex list resolves it. Current Codex threads carry only `name` and `preview`; the other two are read when
  Codex sends them. The title is not cut, as the native list does not cut it, and no transport limit asks for a
  cut: Codex already sends the whole `preview` to the adapter. `_session/rename` still cuts to 256 characters, and so
  does the `title` of `session_info_update` for a loaded session. When
  all four are blank, `title` is `null`, which ACP allows, and the client shows its own fallback: AIR shows the
  session id. A `session/list` without `sessionIndex` and a `_session/list/changes` row use the same title.
- `updatedAt` is `Thread.updatedAt`, the last activity of any kind: Codex moves it for every rollout write of the
  user or the agent, so it can be later than `lastPromptAt` while the agent works. Every row has it. A rename and
  an archive do not move it, but `thread/unarchive` does: Codex sets the rollout file time to now and copies it
  into `updated_at`. That is a known deviation from #2161, see below. The order does not change, as it uses
  `lastPromptAt`.
- The cursor is the adapter's own: the Codex cursor of each list it reads and the last rows the client got (their
  recency and ids), so rows that come or go before them do not shift the next page. It is tied to the scope of
  the list: `cwd` (resolved, so `/repo/` and `/repo` are the same; a relative `cwd` as sent), `archived` (an
  omitted or `null` value counts as `"unarchived"`) and `includeWorktrees`. A malformed cursor, a Codex cursor or
  a cursor of another scope, such as one of an `"all"` list sent with `"archived"`, fails with `-32602`.
  `limit` may change between pages.
- A page with `nextCursor` is not empty, with one exception. The adapter reads the next Codex pages while a page
  has no row left and the cursors advance, for at most 50 rounds and 300 ms. A relative-`cwd` list, which the
  adapter filters itself, can reach that budget, and then answers the rows it has, possibly none, with the cursor
  where it stopped. That is
  the only case: Codex filters every other list itself and does not answer empty pages for it. Clients follow
  `nextCursor` until it is `null`, whatever the page holds. A Codex cursor that Codex repeats ends that list.
- The list does not check the login, so it never fails with `auth_required`. `thread/list` reads the local state DB.

Every row carries these fields in `_meta.jetbrains.air`; all but `archived` only when known:

| Field | Value |
| --- | --- |
| `archived` | `true` for a thread from the archived Codex list, `false` otherwise, whatever the `archived` filter. Always present. |
| `lastPromptAt` | ISO time of `Thread.recencyAt`: Codex moves it when a turn starts and orders threads by it. |
| `model` | `Thread.model`. |
| `forkedFrom` | The thread it was forked from: `Thread.forkedFromId` when Codex gives it, which `thread/read` does and `thread/list` does not. Otherwise `payload.forked_from_id` of the first line of the rollout at `Thread.path`, `session_meta`, which the adapter reads in the background, once per thread, so a list never waits for it: the first row of a fork can come without `forkedFrom`. A subscription that runs when the read ends gets the row again; otherwise the next `session/list` has it. |
| `state` | Only for a thread that this adapter has loaded, see [Row state](#row-state): `requires_action`, `reviewing`, `running`, `error` or `idle`. Omitted otherwise, never `unknown`. |
| `lastTurnEndedAt` | ISO time of the last `turn/completed` that this adapter saw for a session of this connection. Forgotten when the thread is deleted. |

The adapter sends no `cost`: Codex reports none.

#### Row state

`state` is set only for a thread that this adapter's app-server has loaded, by the first that holds:

1. `requires_action`: the thread waits for an approval or for user input (`Thread.status` active with flags).
2. `reviewing`: a turn runs in Codex review mode (`/review`), from an `enteredReviewMode` item to its
   `exitedReviewMode` item. A turn that ends, or a new one that starts, ends it as well.
3. `running`: a turn runs (`Thread.status` active).
4. `error`: the thread is not running and its last turn ended with an error, not a user cancel: `turn/completed`
   with status `failed`, or with an `error` and a status other than `interrupted`; or `Thread.status` is
   `systemError`. A new turn clears it, and so does a close or unload of the thread here or a restart of the
   app-server, which also ends review mode.
5. `idle`: otherwise.

A thread that is not loaded here has no `state`. A change of `state` is a row change for a subscription.

### Requests

| Method | Params | Codex call |
| --- | --- | --- |
| `_session/rename` | `{sessionId, title}` | `thread/name/set`. |
| `_session/archive` | `{sessionId}` | `thread/archive`. A loaded session closes first. |
| `_session/unarchive` | `{sessionId}` | `thread/unarchive`. |
| `session/delete` | `{sessionId}` | `thread/delete`. A loaded session closes first. |

- Each request answers `{}` and works for a thread that is not loaded.
- The writes of one session run one after another: rename, archive, unarchive, delete and the automatic title.
- `title` is collapsed to one line and cut to 256 characters with an ellipsis. A blank title fails with `-32602`.
  A renamed session that is loaded gets `session_info_update {title}` and never gets an automatic title afterwards.
  A rename waits until an automatic title that Codex is writing has completed, so the explicit title is the last
  one. This holds across `session/close` and reload too, and a late `thread/name/updated` that carries exactly the
  automatic title does not replace the explicit one on the client. A later rename of the thread from elsewhere, as
  in the Codex TUI, is shown. A rename that fails leaves automatic titles on, also for a title that was generated
  while the rename ran.
- Codex does not rename an archived thread. The rename then fails with `-32600` and `data.reason: "archived"`,
  and does not unarchive the thread.
- Archiving a session stops it, as `thread/archive` unloads a loaded thread. Unarchive loads nothing.
  - Archive of a session that is open here closes it first, as `session/close` does: it interrupts the running
    turn, ends the pending prompt and its interactions, and unsubscribes the thread. Then it sends `thread/archive`. An open of the session that starts meanwhile fails.
  - The session is then closed: a later `session/prompt` fails as for a closed session. To work in it again, the
    client unarchives it and loads it.
  - If `thread/archive` then fails, the session stays closed and unarchived.
  - Codex does not load an archived thread, so a session open here is not archived and unarchive just succeeds.
    It keeps running.
  - Both are idempotent. Codex fails them for a thread already in the target state, so the adapter reads
    `Thread.path` with `thread/read`: an archived rollout is under `<CODEX_HOME>/archived_sessions/`.
  - After a change of a session that was open on this connection, the adapter sends `session_info_update` with
    `_meta.jetbrains.air.archived`. For an archive it comes after the close, as the last update of the session.
  - `session/load` and `session/resume` of an archived thread fail, and do not unarchive it.
- Errors:
  - A thread that another Codex process holds fails with the `thread_active_writer` reason in `data.reason`.
  - A thread that Codex does not have, or has deleted, fails with `-32002`, as does a thread that `thread/read`
    shows without a rollout. Unarchive never brings back a deleted thread.
- Without `sessionIndex` the three `_session/*` methods answer method-not-found, and `session/delete` keeps
  archiving the thread: old AIR builds send `session/delete` for "Done". Threads they closed that way show as
  archived to a `sessionIndex` client.

### Session list subscription

The client subscribes to the rows of a cwd and the agent pushes the rows that change. It is best effort: the client
still re-reads the list now and then, and a lost change shows up there.

```json
{ "method": "_session/list/subscribe", "params": { "cwd": "/repo" } }
{ "result": { "subscriptionId": "6f1c…" } }
{ "method": "_session/list/changes", "params": { "subscriptionId": "6f1c…", "sessions": [SessionInfo, …], "removed": ["<sessionId>", …] } }
{ "method": "_session/list/unsubscribe", "params": { "subscriptionId": "6f1c…" } }
{ "result": {} }
```

- `_session/list/subscribe {cwd}` answers `{subscriptionId}`. `cwd` is required and absolute; a missing `cwd`, one
  that is not a string and a relative one fail with `-32602`. The request has no other parameters.
- Scope: the threads whose cwd is `cwd`, its canonical path, or the same subdirectory in the primary checkout and
  in each linked Git worktree, as `includeWorktrees: true` resolves it; from the interactive sources, as the list;
  archived or not. The agent applies no archive filter: the client filters by the `archived` field of the row.
  The agent resolves the worktrees of a subscription again every 10 s, and at most once a second for a changed
  thread whose cwd is not in its scope. A thread of a worktree created less than a second before its change can
  show only with its next change.
- `_session/list/changes` carries, for each thread in scope that appeared or changed, its whole row exactly as
  `session/list` answers it. A row counts as changed when `title`, `lastPromptAt`, `state`, `lastTurnEndedAt`,
  `model`, `forkedFrom` or `archived` differs from the row the subscription last got. A change of `updatedAt` alone
  sends nothing; the new `updatedAt` comes with the next change. Archive and unarchive are row changes.
  `removed` lists the ids of deleted threads, to every subscription whose scope has the cwd of the thread. A
  deleted thread whose cwd the agent does not know is listed to every subscription; a client ignores an id it does
  not have. Both arrays are always present, and one
  of them is not empty.
- Subscribing reads no rows: the agent only notes the newest `updatedAt` of the threads, with one small
  `thread/list` per archive state for the first subscription of the connection. After subscribing, the first
  change of each session is sent in full even if only `updatedAt` changed; later changes of it are compared with
  the row sent last. A thread whose `updatedAt` is no later than when the subscription started counts as
  unchanged for a scan, so its first change after subscribing within that same second can show only with its
  next change.
- A change never goes out before the answer to `_session/list/subscribe`: the changes of that time follow it.
- A thread is sent at most once a second; a later change of it waits and goes out with its row of that time. One
  delivery sends one notification per subscription, with all its rows.
- There is no resync and no sequence number. Changes made while the Codex app-server was down can be missed;
  the agent does not replay them.
- `_session/list/unsubscribe {subscriptionId}` answers `{}` and is idempotent: an unknown id is not an error. A
  subscription lives until it is unsubscribed or the connection closes; it has no time limit.
- A connection has at most 128 subscriptions. One more fails with `-32602` and `data.reason: "too_many_subscriptions"`.
- Subscriptions of the same cwd each have their own id, their own unsubscribe and their own notification. The
  agent watches the cwd once for all of them.

How the agent sees changes:

- Threads of its own Codex app-server: at once, from the app-server notifications `thread/started`,
  `thread/status/changed`, `thread/name/updated`, `thread/archived`, `thread/unarchived`, `thread/deleted`,
  `thread/closed`, `turn/started` and `turn/completed`. The agent reads the thread with `thread/read`.
- Threads of other Codex processes: every change of a thread writes the state DB WAL,
  `<CODEX_HOME>/state_<n>.sqlite-wal`. The agent watches the WAL files and CODEX_HOME for WAL files that appear or
  go, and checks the WAL size and time every 30 s in case the file system drops an event. 150 ms after the last
  write, and at most 1 s after the first, it sends one `thread/list` without `cwd`, with `sortKey: "updated_at"`,
  for unarchived threads and one for archived threads, and reads newest first until the threads are older than
  the newest one it saw before. Threads of the same second as that one are read again. A scan reads at most
  920 threads per archive state; one that stops there goes on where it stopped with the next scan, 150 ms later,
  and the newest one it saw counts only once it reached the old one; a scan from the top follows when a write came
  meanwhile.
- A rename moves no `updated_at`. The agent watches `<CODEX_HOME>/session_index.jsonl`, to which any process
  appends its renames, reads what was appended with the next scan, and reads those threads with `thread/read`. Archive moves no `updated_at`
  either: the agent watches `<CODEX_HOME>/archived_sessions/` and reads each thread whose rollout appears or goes
  there.
- A thread that another process deletes is not seen unless it was archived. Clients re-read the list now and then
  for what the agent misses.

### Relation to the ACP RFDs

The names and the semantics are the RFDs'. The transport differs:

| Extension | RFD |
| --- | --- |
| capability `sessionIndex` in `_meta.jetbrains.air.capabilities` | `sessionCapabilities.list.limit` |
| agent capability `sessionArchive` | agent capability `archive` (#2161): `sessionCapabilities.archive`, `capabilities.session.archive` in v2 |
| agent capability `sessionRename` | the rename capability of RFD #1987, which it spells `sessionCapabilities.setTitle` |
| `_meta.jetbrains.air.list.limit` | `session/list` `limit` |
| `_meta.jetbrains.air.list.includeWorktrees` | `session/list` `includeWorktrees` |
| `_meta.jetbrains.air.list.archived`: `"unarchived"`, `"archived"` or `"all"` | `session/list` `archived` (#2161) |
| `SessionInfo.updatedAt` = `Thread.updatedAt` | `SessionInfo.updatedAt`, the last activity of any kind |
| `SessionInfo._meta.jetbrains.air.lastPromptAt` = `Thread.recencyAt`, the order key | `SessionInfo.lastPromptAt`; the list order `lastPromptAt ?? updatedAt` |
| `SessionInfo._meta.jetbrains.air.{model, forkedFrom, state, lastTurnEndedAt}` | the `SessionInfo` fields of the same names |
| `SessionInfo._meta.jetbrains.air.archived` | `SessionInfo.archived` (#2161) |
| `session_info_update._meta.jetbrains.air.archived` | `SessionInfoUpdate.archived` (#2161) |
| `_session/archive`, `_session/unarchive` | `session/archive`, `session/unarchive` (#2161) |
| `_session/rename` | `session/set_title`, client-set titles (#1987) |

Remaining differences:

- One client capability string, `sessionIndex`, gates everything. The agent lists `sessionArchive` and
  `sessionRename` with it, never alone.
- An AIR client without `sessionIndex` deletes as "Done", so the adapter keeps archiving on its `session/delete`.
  #2161 forbids that substitution for clients of the RFD; here it only keeps old AIR builds from losing threads.
- `archived` of the list is a string with three values; #2161 has a boolean. `"unarchived"` is #2161's `false`
  or omitted, and `"all"` is its `true`. `"archived"`, archived sessions only, has no #2161 counterpart.
- The relative-`cwd` list can answer an empty page with `nextCursor` at its scan budget, see above.
- `cost` is never sent.
- `state` has two values of its own: `reviewing` (Codex review mode) and `error` (the last turn failed).
- The RFD's `session/list_changed {cwd}` asks the client to read page 1 again. Here the agent pushes the changed
  rows themselves through the [session list subscription](#session-list-subscription).
- `updatedAt` moves on unarchive, because Codex touches the rollout file then; #2161 says it should not. The order
  is not affected.
- Archive stops a session that is open here, as `session/close` does; #2161 leaves execution alone. The ACP session
  list extensions RFD proposes this change to #2161.

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
- A `$skill` command carries `_meta.jetbrains.air.skillPath`, the absolute path of its `SKILL.md` from `skills/list`.
  The path is an OS-native absolute path, such as `C:\repo\SKILL.md` on Windows. It is not a URI.
  AIR opens this file on a click on the skill chip.

## Removed keys

These keys moved into the AIR namespace.
AIR gets only the new key. A client that is not AIR gets neither the old key nor the new key.

| Old key | New key |
| --- | --- |
| `agent_message_chunk._meta.codex.phase` | `_meta.jetbrains.air.phase`, same values |
| mode `_meta.kind`, config option value `_meta.kind` | `_meta.jetbrains.air.kind` |
| available command `_meta.commandAction` | `_meta.jetbrains.air.commandAction` |
| tool call `_meta.contextCompaction` | `_meta.jetbrains.air.contextCompaction` |

The adapter does not send these keys to any client:

- `_meta.codex.subagent` and `_meta.codex.collaboration`;
- the plan review `_meta.codex.kind` and `_meta.codex.planItemId`;
- the permission `_meta.permission`, replaced by `_meta.jetbrains.air.permission`;
- the diff `_meta.jetbrains.air.diffStats`.

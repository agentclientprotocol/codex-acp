# Permission presentation extension

For a user-facing summary of behavior changes, see
[`permission-changes.ru.md`](permission-changes.ru.md).

This document defines the provider-neutral permission presentation implemented by `codex-acp`. Permission decisions use the standard ACP `session/request_permission` method. The optional `_meta.permission` extension adds display text only; it never changes which actions a client may approve.

## Protocol contract

Every permission request contains:

- a `toolCall` describing the action that needs approval;
- an ordered `options` array containing every decision the user may select;
- optional request-level and option-level `_meta.permission` presentation data.

Clients make a decision by returning one of the advertised `optionId` values. They must not derive a decision from the option label, `kind`, or metadata. `codex-acp` keeps the exact Codex decision associated with each option and returns that original value to Codex.

```json
{
  "sessionId": "session-1",
  "toolCall": {
    "toolCallId": "command-7",
    "kind": "execute",
    "status": "pending",
    "title": "Run command",
    "rawInput": {
      "command": "npm test",
      "cwd": "/workspace"
    }
  },
  "options": [
    {
      "optionId": "allow_once",
      "name": "Yes, proceed",
      "kind": "allow_once"
    },
    {
      "optionId": "cancel",
      "name": "No, and tell Codex what to do differently",
      "kind": "reject_once"
    }
  ],
  "_meta": {
    "permission": {
      "version": 1,
      "title": "Run command?",
      "description": "The test suite needs to run outside the current sandbox."
    }
  }
}
```

The standard ACP fields are the compatibility contract. A client that ignores `_meta.permission` can still render the action, present every option, and return a correct decision.

## Presentation metadata

Request-level metadata has this shape:

```json
{
  "_meta": {
    "permission": {
      "version": 1,
      "title": "Allow network access?",
      "description": "Download the requested dependency."
    }
  }
}
```

`version` and `title` are required. `description` is optional and contains the non-blank reason supplied by Codex. Action payloads are not copied into metadata.

An individual option may provide a description:

```json
{
  "optionId": "allow_session",
  "name": "Allow for this session",
  "kind": "allow_always",
  "_meta": {
    "permission": {
      "version": 1,
      "description": "Run the tool and remember this choice for this session."
    }
  }
}
```

No capability negotiation is required. The metadata is optional, additive, and safe for clients to ignore.

## Action presentation

The `toolCall` remains the authoritative description of the action:

- `rawInput` contains structured command, working-directory, server, URL, or permission-profile data.
- `locations` contains affected filesystem paths when Codex provides them.
- `content` carries details that do not fit a location, such as a network host, filesystem glob, special Codex scope, or MCP message.
- `title`, `kind`, and `status` provide the standard ACP summary.

Command approvals use `kind: execute`. File changes use `kind: edit`. Additional sandbox permissions use `kind: other`. URL authorization fallback uses `kind: fetch`.

For file changes, locations come from the correlated Codex `fileChange` item. `grantRoot` is not presented as though every file below it will be modified.

## Command and network decisions

When Codex sends `availableDecisions`, that ordered list is authoritative. Older Codex versions that omit it use the native Codex fallback decision set.

| Codex decision | ACP option kind | Meaning |
| --- | --- | --- |
| `accept` | `allow_once` | Approve this execution once. |
| `acceptForSession` | `allow_always` | Approve the command, host, or requested permissions for this session. |
| `acceptWithExecpolicyAmendment` | `allow_always` | Approve and install the exact proposed command-prefix rule. |
| network amendment with `allow` | `allow_always` | Approve and install the exact proposed allow rule. |
| network amendment with `deny` | `reject_always` | Reject and install the exact proposed deny rule. |
| `decline` | `reject_once` | Reject this execution and continue the turn. |
| `cancel` | `reject_once` | Reject this execution and abort the pending operation. |

Exec-policy and network amendments are returned as the exact structured values supplied by Codex. An amendment is rejected if it does not match the corresponding proposal. An exec-policy option whose rendered prefix contains a line break is not shown, matching the native Codex UI.

Unknown, malformed, empty, or internally inconsistent authoritative decision sets fail closed with `cancel`; the adapter does not invent replacement choices.

## File changes

File-change approvals expose the native Codex choices:

| ACP option | Kind | Codex decision |
| --- | --- | --- |
| `Yes, proceed` | `allow_once` | `accept` |
| `Yes, and don't ask again for these files` | `allow_always` | `acceptForSession` |
| `No, and tell Codex what to do differently` | `reject_once` | `cancel` |

Although the protocol decision enum also contains `decline`, the native Codex file-change prompt does not currently advertise it.

## Additional sandbox permissions

Codex may request a structured network and filesystem permission profile. `codex-acp` returns only permissions from that requested profile; Codex intersects the response with the original request before applying it.

| User choice | Scope | `strictAutoReview` |
| --- | --- | --- |
| Grant for this turn | `turn` | `false` |
| Grant for this turn with strict auto review | `turn` | `true` |
| Grant for this session | `session` | `false` |
| Continue without permissions | `turn` | `false` |

Strict auto review is intentionally turn-scoped. It causes subsequent actions in that turn to pass through Codex review even when ordinary sandbox policy would allow them. It is never combined with a session-scoped grant.

Cancellation, an unknown option, a stale turn, or a missing handler returns an empty permission profile with turn scope and `strictAutoReview: false`.

## MCP elicitation approvals

Message-only MCP elicitations use `session/request_permission` so clients receive the same decision matrix as the native Codex UI. Codex advertises durable choices through request `_meta.persist`; `codex-acp` never creates a persistence scope that the server did not offer.

| Advertised condition | ACP option | MCP response |
| --- | --- | --- |
| Always | `Allow` | `action: accept` |
| `persist` contains `session` | `Allow for this session` | `action: accept`, `_meta.persist: session` |
| `persist` contains `always` | `Always allow` | `action: accept`, `_meta.persist: always` |
| Non-tool request | `Deny` | `action: decline` |
| Always | `Cancel` | `action: cancel` |

Tool-call approvals deliberately have no `Deny` choice: cancellation stops the tool call. For an ordinary MCP request, `Deny` declines the request while allowing the surrounding turn to continue, whereas `Cancel` aborts the request.

Structured form and URL elicitations use the corresponding ACP elicitation capability when the client advertises it. A structured form that the client cannot render is cancelled rather than replaced with an approval that would omit required input. A message-only or URL request may use permission fallback because no structured field values are lost.

The Codex app-server currently omits the MCP request identity from form-mode elicitation parameters. `codex-acp` correlates the request with an existing MCP tool call only when exactly one pending call for that thread and server is available. Ambiguous requests receive a unique standalone `toolCallId` and include the full message and schema.

## Lifecycle and safety

Permission prompts belong to the active Codex turn. Requests for a stale or interrupted turn are rejected without opening client UI. Cancelling an ACP request, returning an unadvertised `optionId`, transport failure, and malformed client responses all fail closed.

The adapter does not reconstruct provider effects from ACP `kind` values. In particular, `allow_always` describes presentation intent but does not itself create a policy rule; only the exact Codex decision associated with the selected `optionId` can do that.

The app-server v2 request methods are the active permission surface:

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/permissions/requestApproval`
- `mcpServer/elicitation/request`

Deprecated `execCommandApproval` and `applyPatchApproval` methods are not exposed as a second permission pipeline.

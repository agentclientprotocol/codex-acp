# Child-Thread Request Routing in `codex-acp`

## Problem

`codex-acp` registers approval and elicitation handlers under the root Codex thread ID that ACP exposes as its session ID. Codex subagents run in separate child threads. When a child sends its first server request, `CodexAppServerClient` looks up the child thread ID directly, finds no handler, and returns the fail-closed cancellation response. Codex then interrupts the child turn.

Codex emits a typed `thread/started` notification for every thread. Its `Thread` payload contains:

- `id`: the new thread ID;
- `sessionId`: the root ID shared by the complete thread tree;
- `parentThreadId`: non-null for a subagent.

The adapter already uses the root thread ID as the ACP session ID. The notification therefore supplies the exact relationship needed to route descendant requests to the existing ACP session handlers.

## Goals

- Allow Codex child and nested-child threads to use the approval handler registered for their root ACP session.
- Apply the same session ownership rule to elicitation and `request_user_input`, which currently use the same exact-thread lookup and cancellation behavior.
- Preserve fail-closed behavior for stale turns, unknown threads, and thread trees without a registered root handler.
- Remove recorded descendant relationships when the ACP session closes.
- Keep the change inside `@agentclientprotocol/codex-acp`; Buzz, Codex-generated types, Rez, and deployment automation remain unchanged.

## Considered Approaches

### 1. Record the server-provided session relationship (recommended)

Observe `thread/started`, store `thread.id -> thread.sessionId`, and resolve handlers by exact thread ID first, then by the recorded session ID.

This is narrow, supports arbitrary nesting, works with multiple simultaneous ACP sessions, and retains cancellation for an unobserved or unrelated thread.

### 2. Walk `parentThreadId` ancestry

Store child-to-parent links and walk upward until a registered handler is found.

This is safe but more complex. It requires every intermediate notification to be present and adds cycle/depth handling even though Codex already supplies the root session ID directly.

### 3. Fall back to the only registered handler

If an exact lookup fails and only one handler exists, use it.

This would unblock the current single-session host but is rejected because an unknown thread could be routed across security or user-session boundaries.

## Design

### Thread ownership registry

Add a private `threadSessionIds: Map<string, string>` to `CodexAppServerClient`.

When the existing unhandled-notification callback receives `thread/started`, record:

```text
thread.id -> thread.sessionId
```

The notification remains available to the existing event pipeline; recording ownership must not consume or suppress it.

### Handler resolution

Add a small private resolver that accepts a handler map and an incoming thread ID:

1. Return an exact handler when one is registered for the incoming thread ID.
2. Otherwise, read the recorded root session ID for that thread and return the handler registered under that ID.
3. Otherwise, return no handler.

Use this resolver for all five server-request entry points that are scoped by thread:

- command execution approval;
- file-change approval;
- permissions approval;
- MCP elicitation;
- tool `request_user_input`.

Existing stale-turn checks and each request type's current cancellation response remain unchanged.

### Cleanup

When `clearThreadHandlers(rootThreadId)` runs, delete the root handlers as it does today and remove every ownership entry whose recorded session ID equals `rootThreadId`. This prevents closed sessions from retaining child IDs.

No child handler is copied into the maps, so there is only one handler instance and no per-child registration lifecycle.

## Test Strategy

Add focused unit coverage using the existing mock app-server fixture:

1. Register a root prompt/session, emit `thread/started` for a child, send a command approval for that child, and prove ACP's selected response reaches the child request rather than returning `cancel`.
2. Repeat through a nested child whose `sessionId` is still the root, proving nesting does not depend on an intermediate handler.
3. Cover file-change and permissions approval resolution through the same child ownership mapping.
4. Cover MCP elicitation and `request_user_input` through the same mapping.
5. Preserve existing tests that unknown thread IDs receive fail-closed responses.
6. Clear the root session handlers, then prove the previously recorded child again receives the fail-closed response.

Run the repository's complete required sequence on the exact implementation commit:

```text
npm run typecheck
npm test
npm run build
```

## Deployment Boundary

This change produces an upstream `codex-acp` commit and verified package artifact. Installing it on the Rez host and restarting `VOIA Buzz - rez-release-engineer` are separate production mutations. They require explicit approval after the artifact and exact host diff are available. No Rez, rclone, mount, repository, worktree, cache, credential, or conversation state is part of this implementation.

## Acceptance Criteria

- A child Terra thread's first approval request reaches the same ACP permission flow as its root session and is not automatically interrupted.
- Nested child threads resolve to that same root session.
- Unknown, stale, or closed-session child threads continue to fail closed.
- Root-thread behavior is unchanged.
- The implementation changes only `codex-acp` source, tests, and this design documentation.

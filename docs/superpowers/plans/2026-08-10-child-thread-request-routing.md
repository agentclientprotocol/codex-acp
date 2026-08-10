# Child-Thread Request Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route server requests from Codex child threads to the handlers registered for their root ACP session without weakening unknown-thread cancellation.

**Architecture:** `CodexAppServerClient` records the typed `thread.id -> thread.sessionId` relationship from `thread/started`. A single resolver keeps exact-root behavior first, then resolves only recorded descendants to the existing root handler. Session cleanup removes recorded descendants.

**Tech Stack:** TypeScript, vscode-jsonrpc, Vitest, Node.js, esbuild.

## Global Constraints

- Change only `@agentclientprotocol/codex-acp` source, tests, and design/plan documentation.
- Do not edit generated app-server types.
- Unknown, stale, and closed-session threads must keep their current fail-closed responses.
- Do not modify Buzz, Codex core, Rez, rclone, deployment automation, credentials, caches, worktrees, or conversation state.
- Production deployment is outside this implementation plan.

---

### Task 1: Route approval requests for recorded descendants

**Files:**
- Modify: `src/__tests__/CodexACPAgent/approval-events.test.ts`
- Modify: `src/CodexAppServerClient.ts`

**Interfaces:**
- Consumes: v2 `thread/started` notifications whose `params.thread` includes `id` and `sessionId`.
- Produces: `resolveThreadHandler<T>(handlers: Map<string, T>, threadId: string): T | undefined` and a private `threadSessionIds: Map<string, string>`.

- [ ] **Step 1: Add a complete typed thread-started fixture**

Add a test helper returning a complete `ServerNotification` without modifying generated types:

```ts
function threadStarted(threadId: string, rootSessionId: string, parentThreadId: string): ServerNotification {
    return {
        method: 'thread/started',
        params: {
            thread: {
                id: threadId,
                sessionId: rootSessionId,
                forkedFromId: null,
                parentThreadId,
                preview: '',
                ephemeral: false,
                section: null,
                sectionEnteredAt: null,
                modelProvider: 'openai',
                createdAt: 0,
                updatedAt: 0,
                recencyAt: null,
                status: { type: 'idle' },
                path: null,
                cwd: '/workspace',
                cliVersion: 'test',
                source: 'unknown',
                threadSource: null,
                agentNickname: null,
                agentRole: null,
                gitInfo: null,
                name: null,
                turns: [],
            },
        },
    };
}
```

- [ ] **Step 2: Add the failing command-approval test**

Start a real mock-fixture ACP prompt to register the root handler, emit `thread/started` for `child-thread`, submit `item/commandExecution/requestApproval` with `threadId: 'child-thread'`, select `allow_once`, and assert the literal response `{ decision: 'accept' }`.

- [ ] **Step 3: Verify the command test fails for the diagnosed reason**

Run:

```text
npx vitest run src/__tests__/CodexACPAgent/approval-events.test.ts -t "routes a child command approval to its root ACP session"
```

Expected: FAIL because the response is `{ decision: 'cancel' }`.

- [ ] **Step 4: Implement ownership recording and command handler resolution**

In `CodexAppServerClient`:

```ts
private readonly threadSessionIds = new Map<string, string>();

private resolveThreadHandler<T>(handlers: Map<string, T>, threadId: string): T | undefined {
    const exactHandler = handlers.get(threadId);
    if (exactHandler) {
        return exactHandler;
    }
    const sessionId = this.threadSessionIds.get(threadId);
    return sessionId ? handlers.get(sessionId) : undefined;
}
```

Record `thread.id -> thread.sessionId` when `serverNotification.method === 'thread/started'`, before request routing can occur. Replace only the command approval's direct lookup with the resolver.

- [ ] **Step 5: Verify the command test passes**

Run the same focused command and expect one passing selected test.

- [ ] **Step 6: Add failing coverage for nested, file-change, and permissions requests**

Add literal behavior assertions:

- a nested child with `sessionId` equal to the root returns `{ decision: 'accept' }` for command approval;
- a recorded child returns `{ decision: 'accept' }` for file-change approval;
- a recorded child returns the ACP-selected permissions response rather than `{ permissions: {}, scope: 'turn', strictAutoReview: true }`.

- [ ] **Step 7: Verify the new approval tests fail**

Run the full approval test file. Expected: nested command passes through the shared resolver, while file-change and permissions fail on their remaining direct lookups.

- [ ] **Step 8: Route the remaining approval request types**

Replace the direct `approvalHandlers.get(params.threadId)` calls for file-change and permissions requests with `resolveThreadHandler(...)`. Do not change stale-turn guards or cancellation payloads.

- [ ] **Step 9: Verify the approval file passes**

Run:

```text
npx vitest run src/__tests__/CodexACPAgent/approval-events.test.ts
```

Expected: all tests in the file pass.

- [ ] **Step 10: Commit the approval slice**

Stage only `src/CodexAppServerClient.ts` and `src/__tests__/CodexACPAgent/approval-events.test.ts`, then commit with the repository-required human trailers.

---

### Task 2: Route elicitation requests and clean session ownership

**Files:**
- Modify: `src/__tests__/CodexACPAgent/elicitation-events.test.ts`
- Modify: `src/__tests__/CodexACPAgent/approval-events.test.ts`
- Modify: `src/CodexAppServerClient.ts`

**Interfaces:**
- Consumes: `resolveThreadHandler<T>()` and `threadSessionIds` from Task 1.
- Produces: descendant routing for MCP elicitation and `request_user_input`; cleanup of every mapping owned by a closed root.

- [ ] **Step 1: Add failing elicitation tests**

Using the same complete `thread/started` notification shape, start a root prompt and prove:

- a recorded child MCP elicitation returns the configured ACP elicitation response instead of `{ action: 'cancel', content: null, _meta: null }`;
- a recorded child `request_user_input` returns the configured form answers instead of `{ answers: {} }`.

- [ ] **Step 2: Verify both elicitation tests fail**

Run:

```text
npx vitest run src/__tests__/CodexACPAgent/elicitation-events.test.ts -t "child"
```

Expected: both new cases fail on the current direct `elicitationHandlers` lookup.

- [ ] **Step 3: Route both elicitation entry points**

Replace the two direct `elicitationHandlers.get(params.threadId)` calls with `resolveThreadHandler(...)`. Preserve stale-turn guards and empty/cancel responses.

- [ ] **Step 4: Verify the elicitation file passes**

Run the entire `elicitation-events.test.ts` file and expect all tests to pass.

- [ ] **Step 5: Add the failing closed-session test**

Record an old child, clear the root handlers, register a replacement root handler under the same root ID, and submit approval from the old child ID. Assert the old child receives `{ decision: 'cancel' }`; without ownership cleanup it would reach the replacement handler.

- [ ] **Step 6: Verify the closed-session test fails**

Run the selected cleanup test and expect the stale child to receive the replacement handler's accepted response.

- [ ] **Step 7: Remove session-owned mappings during cleanup**

Extend `clearThreadHandlers(rootThreadId)`:

```ts
for (const [threadId, sessionId] of this.threadSessionIds) {
    if (sessionId === rootThreadId) {
        this.threadSessionIds.delete(threadId);
    }
}
```

- [ ] **Step 8: Verify both focused files pass**

Run both approval and elicitation test files together and expect zero failures.

- [ ] **Step 9: Commit the elicitation and cleanup slice**

Stage only the three modified source/test files and commit with the repository-required human trailers.

---

### Task 3: Verify, review, and package the upstream fix

**Files:**
- Modify only if review identifies a valid issue: files already listed above.
- Generate locally, do not commit: `dist/index.js` and npm package artifact.

**Interfaces:**
- Consumes: Tasks 1-2 commits.
- Produces: exact verified commit SHA, clean diff, reviewer result, and installable npm tarball metadata.

- [ ] **Step 1: Run exact-HEAD repository verification**

In one shell, print `git rev-parse HEAD` immediately before:

```text
npm run typecheck
npm test
npm run build
git diff --check
```

All commands must exit zero and the full test run must report zero failures.

- [ ] **Step 2: Self-review the diff**

Inspect `git diff main...HEAD`, `git status --short`, generated/debug artifacts, fail-closed branches, cleanup, and exact repository scope.

- [ ] **Step 3: Request independent code review**

Give a fresh reviewer only the approved design, base SHA `54987e1c4a4f878af9afad96ec8b6b0b48c7045e`, implementation HEAD, and the upstream diff. Fix every Critical or Important issue and re-run the full verification sequence.

- [ ] **Step 4: Create the package artifact**

Run `npm pack --json --pack-destination <workspace scratch directory>`. Record the tarball filename, package version, size, integrity, and SHA-256. Do not install it on any host.

- [ ] **Step 5: Report the implementation boundary**

Publish the exact commit, tests/build evidence, review result, artifact metadata, and unchanged/excluded systems. Ask separately for approval to install that exact artifact and restart only `VOIA Buzz - rez-release-engineer`.

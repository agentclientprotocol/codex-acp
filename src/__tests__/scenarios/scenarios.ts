/**
 * Scripted app-server traffic for each tool kind.
 *
 * The scenarios use only the app-server wire shapes, so the same list drives any adapter version.
 * `scenario-harness.ts` runs them and records the outbound ACP messages.
 */

export const SESSION_ID = "session-1";
export const TURN_ID = "turn-1";
const CHILD_THREAD_ID = "child-thread";

export type ScenarioStep =
    | {notify: Record<string, unknown>}
    /** Waits longer than the throttle of the plan stream. */
    | {waitMs: number}
    | {request: {method: string; params: unknown}; permissionOptionId?: string; elicitation?: unknown};

export type Scenario = {
    name: string;
    /** Live events during one prompt turn. */
    steps?: ScenarioStep[];
    /** Thread items that `session/load` replays. */
    history?: Record<string, unknown>[];
    /** MCP servers that fail at startup. */
    mcpStartup?: {failed: {server: string; error: string}[]; cancelled: string[]};
    /** The session starts in the Codex plan collaboration mode. */
    planMode?: boolean;
    /** The option id the client selects in the plan review permission request. */
    planReviewOptionId?: string;
};

function item(method: "item/started" | "item/completed", value: Record<string, unknown>, threadId = SESSION_ID) {
    return {
        notify: {
            method,
            params: {
                threadId,
                turnId: TURN_ID,
                ...(method === "item/started" ? {startedAtMs: 0} : {completedAtMs: 0}),
                item: value,
            },
        },
    };
}

const started = (value: Record<string, unknown>, threadId?: string) => item("item/started", value, threadId);
const completed = (value: Record<string, unknown>, threadId?: string) => item("item/completed", value, threadId);

function notify(method: string, params: Record<string, unknown>): ScenarioStep {
    return {notify: {method, params: {threadId: SESSION_ID, turnId: TURN_ID, ...params}}};
}

function command(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
        type: "commandExecution",
        id: "cmd-1",
        pluginId: null,
        scriptPath: null,
        command: "/bin/zsh -lc 'npm test'",
        cwd: "/workspace",
        processId: "pid-1",
        source: "agent",
        status: "inProgress",
        commandActions: [{type: "unknown", command: "npm test"}],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
        ...overrides,
    };
}

function mcpCall(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
        type: "mcpToolCall",
        id: "mcp-1",
        server: "docs",
        tool: "search",
        status: "inProgress",
        arguments: {query: "acp"},
        appContext: null,
        pluginId: null,
        readOnlyHint: null,
        result: null,
        error: null,
        durationMs: null,
        ...overrides,
    };
}

function fileChange(id: string, changes: unknown[], status: string): Record<string, unknown> {
    return {type: "fileChange", id, changes, status};
}

const ADD_CHANGE = {path: "/workspace/new.txt", kind: {type: "add"}, diff: "hello\nworld\n"};
const UPDATE_CHANGE = {
    path: "/workspace/src/app.ts",
    kind: {type: "update", move_path: null},
    diff: "@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n export {a};\n",
};
const DELETE_CHANGE = {path: "/workspace/old.txt", kind: {type: "delete"}, diff: "bye\n"};
const RENAME_CHANGE = {
    path: "/workspace/before.ts",
    kind: {type: "update", move_path: "/workspace/after.ts"},
    diff: "@@ -1 +1 @@\n-export const name = \"before\";\n+export const name = \"after\";\n",
};

function turnCompleted(threadId = SESSION_ID, turnId = TURN_ID): Record<string, unknown> {
    return {
        method: "turn/completed",
        params: {
            threadId,
            turn: {
                id: turnId, items: [], itemsView: "notLoaded", status: "completed", error: null,
                startedAt: null, completedAt: null, durationMs: null,
            },
        },
    };
}

const NESTED_CHILD_THREAD_ID = "grandchild-thread";

/** A Codex collaboration tool call of `senderThreadId` that addresses `receiverThreadId`. */
function collab(
    id: string,
    tool: string,
    status: "inProgress" | "completed",
    agentState: "running" | "completed",
    senderThreadId = SESSION_ID,
    receiverThreadId = CHILD_THREAD_ID,
    prompt: string | null = "Find the weather in Paris.",
): Record<string, unknown> {
    return {
        type: "collabAgentToolCall", id, tool, status, senderThreadId, receiverThreadIds: [receiverThreadId], prompt,
        model: null, reasoningEffort: null, agentsStates: {[receiverThreadId]: {status: agentState, message: null}},
    };
}

/** The activity item that announces the session of a spawned subagent. */
function spawnActivity(id: string, agentThreadId: string, agentPath: string, threadId = SESSION_ID): ScenarioStep {
    return started({type: "subAgentActivity", id, kind: "started", agentThreadId, agentPath}, threadId);
}

/** An event of a subagent thread. */
function childNotify(threadId: string, method: string, params: Record<string, unknown>): ScenarioStep {
    return {notify: {method, params: {threadId, turnId: `${threadId}-turn`, ...params}}};
}

export const SCENARIOS: Scenario[] = [
    {
        name: "command-output-stdin",
        steps: [
            started(command({})),
            notify("item/commandExecution/outputDelta", {itemId: "cmd-1", delta: "Running tests\n"}),
            notify("item/commandExecution/terminalInteraction", {itemId: "cmd-1", processId: "pid-1", stdin: "y"}),
            notify("item/commandExecution/outputDelta", {itemId: "cmd-1", delta: "1 passed\n"}),
            completed(command({
                status: "completed", aggregatedOutput: "Running tests\n1 passed\n", exitCode: 0, durationMs: 12,
            })),
        ],
    },
    {
        name: "command-without-streamed-output",
        steps: [
            started(command({id: "cmd-2", command: "ls -la", commandActions: []})),
            completed(command({
                id: "cmd-2", command: "ls -la", commandActions: [], status: "completed",
                aggregatedOutput: "a.txt\nb.txt\n", exitCode: 0, durationMs: 3,
            })),
        ],
    },
    {
        name: "command-failed",
        steps: [
            started(command({id: "cmd-3", command: "cat missing.txt", commandActions: []})),
            notify("item/commandExecution/outputDelta", {itemId: "cmd-3", delta: "cat: missing.txt: No such file\n"}),
            completed(command({
                id: "cmd-3", command: "cat missing.txt", commandActions: [], status: "failed",
                aggregatedOutput: "cat: missing.txt: No such file\n", exitCode: 1, durationMs: 2,
            })),
        ],
    },
    {
        name: "read-search-list",
        steps: [
            started(command({
                id: "read-1", command: "cat src/app.ts",
                commandActions: [{type: "read", command: "cat src/app.ts", name: "app.ts", path: "/workspace/src/app.ts"}],
            })),
            notify("item/commandExecution/outputDelta", {itemId: "read-1", delta: "export const a = 1;\n"}),
            completed(command({
                id: "read-1", command: "cat src/app.ts", status: "completed",
                commandActions: [{type: "read", command: "cat src/app.ts", name: "app.ts", path: "/workspace/src/app.ts"}],
                aggregatedOutput: "export const a = 1;\n", exitCode: 0, durationMs: 1,
            })),
            started(command({
                id: "search-1", command: "rg -n TODO src",
                commandActions: [{type: "search", command: "rg -n TODO src", query: "TODO", path: "src"}],
            })),
            completed(command({
                id: "search-1", command: "rg -n TODO src", status: "completed",
                commandActions: [{type: "search", command: "rg -n TODO src", query: "TODO", path: "src"}],
                aggregatedOutput: "src/app.ts:3: // TODO\n", exitCode: 0, durationMs: 1,
            })),
            started(command({
                id: "list-1", command: "ls src",
                commandActions: [{type: "listFiles", command: "ls src", path: "src"}],
            })),
            completed(command({
                id: "list-1", command: "ls src", status: "completed",
                commandActions: [{type: "listFiles", command: "ls src", path: "src"}],
                aggregatedOutput: "app.ts\n", exitCode: 0, durationMs: 1,
            })),
        ],
    },
    {
        name: "file-changes",
        steps: [
            started(fileChange("fc-add", [ADD_CHANGE], "inProgress")),
            completed(fileChange("fc-add", [ADD_CHANGE], "completed")),
            started(fileChange("fc-update", [UPDATE_CHANGE], "inProgress")),
            completed(fileChange("fc-update", [UPDATE_CHANGE], "completed")),
            started(fileChange("fc-delete", [DELETE_CHANGE], "inProgress")),
            completed(fileChange("fc-delete", [DELETE_CHANGE], "completed")),
            started(fileChange("fc-rename", [RENAME_CHANGE], "inProgress")),
            completed(fileChange("fc-rename", [RENAME_CHANGE], "failed")),
        ],
    },
    {
        name: "mcp-tool",
        steps: [
            started(mcpCall({})),
            notify("item/mcpToolCall/progress", {itemId: "mcp-1", message: "  fetching page 1\n"}),
            notify("item/mcpToolCall/progress", {itemId: "mcp-1", message: "fetching page 2"}),
            completed(mcpCall({
                status: "completed", durationMs: 5,
                result: {content: [{type: "text", text: "3 hits"}], structuredContent: {hits: 3}, _meta: null},
            })),
            started(mcpCall({id: "mcp-2", tool: "fail"})),
            completed(mcpCall({id: "mcp-2", tool: "fail", status: "failed", error: {message: "server exploded"}})),
        ],
    },
    {
        name: "dynamic-tool",
        steps: [
            started({
                type: "dynamicToolCall", id: "dyn-1", namespace: null, tool: "list_apps", arguments: {filter: "all"},
                status: "inProgress", contentItems: null, success: null, durationMs: null,
            }),
            completed({
                type: "dynamicToolCall", id: "dyn-1", namespace: null, tool: "list_apps", arguments: {filter: "all"},
                status: "completed", contentItems: [{type: "inputText", text: "Found 2 apps"}], success: true,
                durationMs: 4,
            }),
        ],
    },
    {
        name: "web-search",
        steps: [
            started({type: "webSearch", id: "web-1", query: "", action: null, results: null}),
            completed({
                type: "webSearch", id: "web-1", query: "acp protocol",
                action: {type: "search", query: "acp protocol", queries: null}, results: null,
            }),
            started({type: "webSearch", id: "web-2", query: "", action: null, results: null}),
            completed({
                type: "webSearch", id: "web-2", query: "",
                action: {type: "openPage", url: "https://example.com/acp"}, results: null,
            }),
        ],
    },
    {
        name: "image-view",
        steps: [
            started({type: "imageView", id: "img-1", path: "/workspace/screen.png"}),
            completed({type: "imageView", id: "img-1", path: "/workspace/screen.png"}),
        ],
    },
    {
        name: "image-generation",
        steps: [
            started({
                type: "imageGeneration", id: "gen-1", status: "in_progress", revisedPrompt: null, result: "",
                failure: null,
            }),
            completed({
                type: "imageGeneration", id: "gen-1", status: "completed", revisedPrompt: "A red square",
                result: "iVBORw0KGgo=", failure: null, savedPath: "/workspace/square.png",
            }),
        ],
    },
    {
        name: "collab-agent",
        steps: [
            started({
                type: "collabAgentToolCall", id: "collab-1", tool: "spawnAgent", status: "inProgress",
                senderThreadId: SESSION_ID, receiverThreadIds: [CHILD_THREAD_ID], prompt: "Find the weather in Paris.",
                model: null, reasoningEffort: null,
                agentsStates: {[CHILD_THREAD_ID]: {status: "running", message: "Checking"}},
            }),
            completed({
                type: "collabAgentToolCall", id: "collab-1", tool: "spawnAgent", status: "completed",
                senderThreadId: SESSION_ID, receiverThreadIds: [CHILD_THREAD_ID], prompt: "Find the weather in Paris.",
                model: null, reasoningEffort: null,
                agentsStates: {[CHILD_THREAD_ID]: {status: "completed", message: "Sunny"}},
            }),
        ],
    },
    {
        name: "subagent-activity",
        steps: [
            started({
                type: "subAgentActivity", id: "act-1", kind: "started", agentThreadId: CHILD_THREAD_ID,
                agentPath: "/root/weather",
            }),
            completed({
                type: "subAgentActivity", id: "act-1", kind: "started", agentThreadId: CHILD_THREAD_ID,
                agentPath: "/root/weather",
            }),
            {notify: {
                method: "item/agentMessage/delta",
                params: {threadId: CHILD_THREAD_ID, turnId: "child-turn", itemId: "child-msg", delta: "Sunny"},
            }},
            {notify: turnCompleted(CHILD_THREAD_ID, "child-turn")},
            started({
                type: "subAgentActivity", id: "act-2", kind: "completed", agentThreadId: CHILD_THREAD_ID,
                agentPath: "/root/weather",
            }),
            completed({
                type: "subAgentActivity", id: "act-2", kind: "completed", agentThreadId: CHILD_THREAD_ID,
                agentPath: "/root/weather",
            }),
        ],
    },
    {
        name: "fuzzy-file-search",
        steps: [
            {notify: {method: "fuzzyFileSearch/sessionUpdated", params: {
                sessionId: "search-1", query: "handler",
                files: [{
                    root: "/workspace", path: "src/Handler.ts", match_type: "file", file_name: "Handler.ts",
                    score: 0.9, indices: [0],
                }],
            }}},
            {notify: {method: "fuzzyFileSearch/sessionUpdated", params: {
                sessionId: "search-1", query: "handler",
                files: [{
                    root: "/workspace", path: "src/OtherHandler.ts", match_type: "file", file_name: "OtherHandler.ts",
                    score: 0.8, indices: null,
                }],
            }}},
            {notify: {method: "fuzzyFileSearch/sessionUpdated", params: {sessionId: "search-1", query: "handlr", files: []}}},
            {notify: {method: "fuzzyFileSearch/sessionCompleted", params: {sessionId: "search-1"}}},
        ],
    },
    {
        name: "guardian-review",
        steps: [
            notify("item/autoApprovalReview/started", {
                startedAtMs: 1000, reviewId: "review-1", targetItemId: "cmd-9",
                review: {status: "inProgress", riskLevel: "medium", userAuthorization: "unknown", rationale: "Checking."},
                action: {type: "command", source: "shell", command: "rm -rf build", cwd: "/workspace"},
            }),
            notify("item/autoApprovalReview/completed", {
                startedAtMs: 1000, completedAtMs: 1500, reviewId: "review-1", targetItemId: "cmd-9",
                decisionSource: "agent",
                review: {status: "denied", riskLevel: "high", userAuthorization: "low", rationale: "Deletes files."},
                action: {type: "command", source: "shell", command: "rm -rf build", cwd: "/workspace"},
            }),
        ],
    },
    {
        name: "context-compaction",
        steps: [
            started({type: "contextCompaction", id: "compact-1"}),
            completed({type: "contextCompaction", id: "compact-1"}),
        ],
    },
    {
        name: "plan-deltas-and-turn-plan",
        steps: [
            notify("item/plan/delta", {itemId: "plan-1", delta: "# Plan\n\n"}),
            notify("item/plan/delta", {itemId: "plan-1", delta: "1. Do the thing."}),
            completed({type: "plan", id: "plan-1", text: "# Plan\n\n1. Do the thing."}),
            notify("turn/plan/updated", {
                explanation: "Working",
                plan: [{step: "Read code", status: "completed"}, {step: "Change code", status: "inProgress"}],
            }),
        ],
    },
    {
        name: "plan-stream",
        steps: [
            notify("item/plan/delta", {itemId: "plan-3", delta: "# Plan\n\n"}),
            {waitMs: 250},
            notify("item/plan/delta", {itemId: "plan-3", delta: "1. Read."}),
            {waitMs: 250},
            notify("item/plan/delta", {itemId: "plan-3", delta: "\n2. Write."}),
            completed({type: "plan", id: "plan-3", text: "# Plan\n\n1. Read.\n2. Write."}),
        ],
    },
    {
        name: "goal-update",
        steps: [
            notify("thread/goal/updated", {goal: {
                threadId: SESSION_ID, objective: "Ship it", status: "active", tokenBudget: null, tokensUsed: 5,
                timeUsedSeconds: 1, createdAt: 1710000000, updatedAt: 1710000001,
            }}),
            notify("thread/goal/cleared", {}),
        ],
    },
    {
        name: "plan-review-permission",
        planMode: true,
        planReviewOptionId: "revise_plan",
        steps: [
            notify("item/plan/delta", {itemId: "plan-2", delta: "# Plan\n\n1. Make the change."}),
            completed({type: "plan", id: "plan-2", text: "# Plan\n\n1. Make the change."}),
        ],
    },
    {
        name: "command-approval",
        steps: [
            started(command({id: "cmd-a", command: "npm install", commandActions: []})),
            {
                request: {method: "item/commandExecution/requestApproval", params: {
                    threadId: SESSION_ID, turnId: TURN_ID, itemId: "cmd-a", startedAtMs: 0, environmentId: "local",
                    command: "npm install", cwd: "/workspace", reason: "Install the dependencies.",
                    availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
                }},
                permissionOptionId: "allow_once",
            },
            completed(command({
                id: "cmd-a", command: "npm install", commandActions: [], status: "completed",
                aggregatedOutput: "added 1 package\n", exitCode: 0, durationMs: 9,
            })),
        ],
    },
    {
        name: "network-and-sandbox-approval",
        steps: [
            {
                request: {method: "item/commandExecution/requestApproval", params: {
                    threadId: SESSION_ID, turnId: TURN_ID, itemId: "cmd-net", startedAtMs: 0, environmentId: "local",
                    command: "curl https://example.com", cwd: "/workspace", reason: null,
                    networkApprovalContext: {host: "example.com", protocol: "https"},
                    commandActions: [{type: "read", command: "cat a.txt", name: "a.txt", path: "/workspace/a.txt"}],
                    availableDecisions: ["accept", "decline", "cancel"],
                }},
                permissionOptionId: "decline",
            },
            {
                request: {method: "item/permissions/requestApproval", params: {
                    threadId: SESSION_ID, turnId: TURN_ID, itemId: "perm-1", environmentId: null, startedAtMs: 0,
                    cwd: "/workspace", reason: "Needs the cache.",
                    permissions: {network: {enabled: true}, fileSystem: {read: ["/workspace/cache"], write: null}},
                }},
                permissionOptionId: "reject_permissions",
            },
        ],
    },
    {
        name: "file-change-approval",
        steps: [
            started(fileChange("fc-a", [UPDATE_CHANGE], "inProgress")),
            {
                request: {method: "item/fileChange/requestApproval", params: {
                    threadId: SESSION_ID, turnId: TURN_ID, itemId: "fc-a", startedAtMs: 0,
                    reason: "Update the constant.", grantRoot: null,
                }},
                permissionOptionId: "decline",
            },
            completed(fileChange("fc-a", [UPDATE_CHANGE], "declined")),
        ],
    },
    {
        name: "mcp-elicitation",
        steps: [
            {
                request: {method: "mcpServer/elicitation/request", params: {
                    threadId: SESSION_ID, turnId: TURN_ID, serverName: "docs", mode: "form", _meta: null,
                    message: "Pick a color",
                    requestedSchema: {
                        type: "object", properties: {color: {type: "string", enum: ["red", "blue"]}},
                        required: ["color"],
                    },
                }},
                permissionOptionId: "accept",
                elicitation: {action: "accept", content: {color: "red"}},
            },
        ],
    },
    {
        name: "mcp-tool-approval",
        steps: [
            started(mcpCall({id: "mcp-3", tool: "write"})),
            {
                request: {method: "mcpServer/elicitation/request", params: {
                    threadId: SESSION_ID, turnId: TURN_ID, serverName: "docs", mode: "form",
                    _meta: {codex_approval_kind: "mcp_tool_call", persist: ["session"]},
                    message: "Allow the docs server to run write?",
                    requestedSchema: {type: "object", properties: {}},
                }},
                permissionOptionId: "allow_once",
            },
            completed(mcpCall({
                id: "mcp-3", tool: "write", status: "completed", durationMs: 2,
                result: {content: [{type: "text", text: "written"}], structuredContent: null, _meta: null},
            })),
        ],
    },
    {
        name: "mcp-url-elicitation",
        steps: [
            {
                request: {method: "mcpServer/elicitation/request", params: {
                    threadId: SESSION_ID, turnId: TURN_ID, serverName: "docs", mode: "url", _meta: null,
                    message: "Sign in to the docs server", url: "https://example.com/login", elicitationId: "el-1",
                }},
                permissionOptionId: "accept",
                elicitation: {action: "accept"},
            },
        ],
    },
    {
        name: "mcp-startup-failure",
        mcpStartup: {failed: [{server: "db", error: "boom"}], cancelled: ["slow"]},
    },
    {
        name: "background-terminal",
        steps: [
            started(command({
                id: "bg-1", command: "npm run dev", commandActions: [], source: "unifiedExecStartup",
            })),
            notify("item/commandExecution/outputDelta", {itemId: "bg-1", delta: "listening on 3000\n"}),
            {notify: turnCompleted()},
        ],
    },
    {
        name: "agent-message-and-reasoning",
        steps: [
            notify("item/reasoning/summaryTextDelta", {itemId: "rs-1", delta: "Thinking about it", summaryIndex: 0}),
            notify("item/reasoning/summaryPartAdded", {itemId: "rs-1", summaryIndex: 1}),
            notify("item/reasoning/textDelta", {itemId: "rs-1", delta: "raw reasoning", contentIndex: 0}),
            completed({type: "reasoning", id: "rs-1", summary: ["Thinking about it"], content: ["raw reasoning"]}),
            started({
                type: "agentMessage", id: "msg-1", text: "", phase: "final_answer", memoryCitation: null,
                delivery: null, questions: null,
            }),
            notify("item/agentMessage/delta", {itemId: "msg-1", delta: "Hello "}),
            notify("item/agentMessage/delta", {itemId: "msg-1", delta: "world"}),
            completed({
                type: "agentMessage", id: "msg-1", text: "Hello world", phase: "final_answer", memoryCitation: null,
                delivery: null, questions: null,
            }),
        ],
    },
    {
        name: "native-subagent-session",
        steps: [
            started(collab("spawn-1", "spawnAgent", "inProgress", "running")),
            spawnActivity("act-1", CHILD_THREAD_ID, "/root/weather"),
            started(command({id: "child-cmd", command: "curl wttr.in", commandActions: []}), CHILD_THREAD_ID),
            childNotify(CHILD_THREAD_ID, "item/commandExecution/outputDelta", {itemId: "child-cmd", delta: "Sunny\n"}),
            completed(command({
                id: "child-cmd", command: "curl wttr.in", commandActions: [], status: "completed",
                aggregatedOutput: "Sunny\n", exitCode: 0, durationMs: 3,
            }), CHILD_THREAD_ID),
            started(mcpCall({id: "child-mcp"}), CHILD_THREAD_ID),
            completed(mcpCall({
                id: "child-mcp", status: "completed", durationMs: 2,
                result: {content: [{type: "text", text: "1 hit"}], structuredContent: null, _meta: null},
            }), CHILD_THREAD_ID),
            childNotify(CHILD_THREAD_ID, "item/agentMessage/delta", {itemId: "child-msg", delta: "Sunny in Paris"}),
            {notify: turnCompleted(CHILD_THREAD_ID, `${CHILD_THREAD_ID}-turn`)},
            completed(collab("spawn-1", "spawnAgent", "completed", "completed")),
        ],
    },
    {
        name: "nested-subagent-session",
        steps: [
            started(collab("spawn-1", "spawnAgent", "inProgress", "running")),
            spawnActivity("act-1", CHILD_THREAD_ID, "/root/weather"),
            started(collab(
                "spawn-2", "spawnAgent", "inProgress", "running", CHILD_THREAD_ID, NESTED_CHILD_THREAD_ID, "Check Lyon.",
            ), CHILD_THREAD_ID),
            spawnActivity("act-2", NESTED_CHILD_THREAD_ID, "/root/weather/lyon", CHILD_THREAD_ID),
            started(command({id: "grandchild-cmd", command: "curl wttr.in/Lyon", commandActions: []}), NESTED_CHILD_THREAD_ID),
            completed(command({
                id: "grandchild-cmd", command: "curl wttr.in/Lyon", commandActions: [], status: "completed",
                aggregatedOutput: "Rain\n", exitCode: 0, durationMs: 3,
            }), NESTED_CHILD_THREAD_ID),
            childNotify(NESTED_CHILD_THREAD_ID, "item/agentMessage/delta", {itemId: "grandchild-msg", delta: "Rain in Lyon"}),
            {notify: turnCompleted(NESTED_CHILD_THREAD_ID, `${NESTED_CHILD_THREAD_ID}-turn`)},
            completed(collab(
                "spawn-2", "spawnAgent", "completed", "completed", CHILD_THREAD_ID, NESTED_CHILD_THREAD_ID, "Check Lyon.",
            ), CHILD_THREAD_ID),
            {notify: turnCompleted(CHILD_THREAD_ID, `${CHILD_THREAD_ID}-turn`)},
            completed(collab("spawn-1", "spawnAgent", "completed", "completed")),
        ],
    },
    {
        name: "late-subagent-update",
        steps: [
            started(collab("spawn-1", "spawnAgent", "inProgress", "running")),
            spawnActivity("act-1", CHILD_THREAD_ID, "/root/weather"),
            started(command({id: "child-cmd", command: "curl wttr.in", commandActions: []}), CHILD_THREAD_ID),
            {notify: turnCompleted(CHILD_THREAD_ID, `${CHILD_THREAD_ID}-turn`)},
            completed(collab("spawn-1", "spawnAgent", "completed", "completed")),
            childNotify(CHILD_THREAD_ID, "item/commandExecution/outputDelta", {itemId: "child-cmd", delta: "Late\n"}),
            completed(command({
                id: "child-cmd", command: "curl wttr.in", commandActions: [], status: "completed",
                aggregatedOutput: "Late\n", exitCode: 0, durationMs: 3,
            }), CHILD_THREAD_ID),
            childNotify(CHILD_THREAD_ID, "item/agentMessage/delta", {itemId: "child-msg", delta: "Too late"}),
        ],
    },
    {
        name: "collab-controls",
        steps: [
            started(collab("spawn-1", "spawnAgent", "inProgress", "running")),
            spawnActivity("act-1", CHILD_THREAD_ID, "/root/weather"),
            started(collab("wait-1", "wait", "inProgress", "running", SESSION_ID, CHILD_THREAD_ID, null)),
            completed(collab("wait-1", "wait", "completed", "running", SESSION_ID, CHILD_THREAD_ID, null)),
            started(collab("send-1", "sendInput", "inProgress", "running", SESSION_ID, CHILD_THREAD_ID, "Use Celsius.")),
            completed(collab("send-1", "sendInput", "completed", "running", SESSION_ID, CHILD_THREAD_ID, "Use Celsius.")),
            started(collab("resume-1", "resumeAgent", "inProgress", "running", SESSION_ID, CHILD_THREAD_ID, null)),
            completed(collab("resume-1", "resumeAgent", "completed", "running", SESSION_ID, CHILD_THREAD_ID, null)),
            started(collab("close-1", "closeAgent", "inProgress", "running", SESSION_ID, CHILD_THREAD_ID, null)),
            completed(collab("close-1", "closeAgent", "completed", "completed", SESSION_ID, CHILD_THREAD_ID, null)),
            completed(collab("spawn-1", "spawnAgent", "completed", "completed")),
        ],
    },
    {
        name: "history-replay",
        history: [
            {type: "userMessage", id: "u-1", clientId: null, content: [{type: "text", text: "Run the tests", text_elements: []}]},
            command({
                id: "h-cmd", status: "completed", aggregatedOutput: "1 passed\n", exitCode: 0, durationMs: 7,
            }),
            fileChange("h-fc", [UPDATE_CHANGE], "completed"),
            command({
                id: "h-read", command: "cat src/app.ts", status: "completed",
                commandActions: [{type: "read", command: "cat src/app.ts", name: "app.ts", path: "/workspace/src/app.ts"}],
                aggregatedOutput: "const a = 2;\n", exitCode: 0, durationMs: 1,
            }),
            mcpCall({
                id: "h-mcp", status: "completed", durationMs: 3,
                result: {content: [{type: "text", text: "1 hit"}], structuredContent: null, _meta: null},
            }),
            {
                type: "dynamicToolCall", id: "h-dyn", namespace: "apps", tool: "list_apps", arguments: {},
                status: "completed", contentItems: [{type: "inputText", text: "No apps"}], success: true, durationMs: 1,
            },
            {
                type: "collabAgentToolCall", id: "h-collab", tool: "spawnAgent", status: "completed",
                senderThreadId: SESSION_ID, receiverThreadIds: ["h-child"], prompt: "Check the build.",
                model: null, reasoningEffort: null, agentsStates: {"h-child": {status: "completed", message: null}},
            },
            {
                type: "webSearch", id: "h-web", query: "acp",
                action: {type: "search", query: "acp", queries: null}, results: null,
            },
            {type: "imageView", id: "h-img", path: "/workspace/screen.png"},
            {
                type: "imageGeneration", id: "h-gen", status: "completed", revisedPrompt: null, result: "iVBORw0KGgo=",
                failure: null,
            },
            {type: "contextCompaction", id: "h-compact"},
            {type: "plan", id: "h-plan", text: "# Plan\n\n1. Ship."},
            {type: "reasoning", id: "h-rs", summary: ["Thought about it"], content: []},
            {
                type: "agentMessage", id: "h-msg", text: "Done.", phase: null, memoryCitation: null,
                delivery: null, questions: null,
            },
        ],
    },
];

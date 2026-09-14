import {describe, expect, it, vi} from "vitest";
import type {SessionState} from "../CodexAcpServer";
import {CodexElicitationHandler} from "../CodexElicitationHandler";
import type {AcpClientConnection} from "../ACPSessionConnection";
import type {ServerNotification} from "../app-server";
import {PermissionLifecycleContext} from "../permissions/lifecycle";

function sessionState(): SessionState {
    return {
        sessionId: "session",
        currentTurnId: "turn-1",
    } as SessionState;
}

function mcpStarted(id: string, turnId: string, threadId = "thread"): ServerNotification {
    return {
        method: "item/started",
        params: {
            threadId,
            turnId,
            startedAtMs: 0,
            item: {
                type: "mcpToolCall",
                id,
                server: "server",
                tool: "tool",
                status: "inProgress",
                arguments: {},
                appContext: null,
                readOnlyHint: null,
                pluginId: null,
                result: null,
                error: null,
                durationMs: null,
            },
        },
    };
}

function fileChangeStarted(id: string, threadId: string): ServerNotification {
    return {
        method: "item/started",
        params: {
            threadId,
            turnId: `turn-${threadId}`,
            startedAtMs: 0,
            item: {
                type: "fileChange",
                id,
                changes: [{path: `/${threadId}.txt`, kind: {type: "add"}, diff: "+content"}],
                status: "inProgress",
            },
        },
    };
}

function turnCompleted(threadId: string): ServerNotification {
    return {
        method: "turn/completed",
        params: {
            threadId,
            turn: {
                id: `turn-${threadId}`,
                items: [],
                itemsView: "full",
                status: "completed",
                error: null,
                startedAt: 0,
                completedAt: 1,
                durationMs: 1_000,
            },
        },
    };
}

describe("PermissionLifecycleContext", () => {
    it("clears MCP correlation at the turn boundary", () => {
        const lifecycle = new PermissionLifecycleContext(sessionState());
        const prompt = lifecycle.beginPrompt();
        prompt.handleNotification(mcpStarted("stale-call", "turn-1"));
        prompt.handleNotification({
            method: "turn/completed",
            params: {
                threadId: "thread",
                turn: {
                    id: "turn-1",
                    items: [],
                    itemsView: "full",
                    status: "completed",
                    error: null,
                    startedAt: 0,
                    completedAt: 1,
                    durationMs: 1_000,
                },
            },
        });
        prompt.handleNotification(mcpStarted("current-call", "turn-2"));

        expect(prompt.popPendingMcpApproval("thread", "server")).toBe("current-call");
    });

    it("keeps synthetic IDs session-scoped across prompt contexts", () => {
        const lifecycle = new PermissionLifecycleContext(sessionState());
        expect(lifecycle.beginPrompt().nextStandaloneMcpToolCallId("server"))
            .toBe("elicitation:session:server:1");
        expect(lifecycle.beginPrompt().nextStandaloneMcpToolCallId("server"))
            .toBe("elicitation:session:server:2");
    });

    it("isolates MCP correlation between prompt generations", () => {
        const lifecycle = new PermissionLifecycleContext(sessionState());
        const stalePrompt = lifecycle.beginPrompt();
        const currentPrompt = lifecycle.beginPrompt();
        currentPrompt.handleNotification(mcpStarted("current-call", "turn-2"));

        expect(stalePrompt.popPendingMcpApproval("thread", "server")).toBeUndefined();
        expect(currentPrompt.popPendingMcpApproval("thread", "server")).toBe("current-call");
    });

    it("clears only the completed thread's permission correlation", () => {
        const prompt = new PermissionLifecycleContext(sessionState()).beginPrompt();
        prompt.handleNotification(mcpStarted("call-a", "turn-a", "child-a"));
        prompt.handleNotification(mcpStarted("call-b", "turn-b", "child-b"));
        prompt.handleNotification(fileChangeStarted("shared-file-change", "child-a"));
        prompt.handleNotification(fileChangeStarted("shared-file-change", "child-b"));

        prompt.handleNotification(turnCompleted("child-b"));

        expect(prompt.popPendingMcpApproval("child-a", "server")).toBe("call-a");
        expect(prompt.popPendingMcpApproval("child-b", "server")).toBeUndefined();
        expect(prompt.fileChange("child-a", "shared-file-change")?.changes[0]?.path).toBe("/child-a.txt");
        expect(prompt.fileChange("child-b", "shared-file-change")).toBeUndefined();
    });

    it("does not allocate a synthetic ID for native ACP elicitation", async () => {
        const state = sessionState();
        const lifecycle = new PermissionLifecycleContext(state);
        const prompt = lifecycle.beginPrompt();
        const connection = {
            request: vi.fn().mockResolvedValue({action: "decline"}),
        } as unknown as AcpClientConnection;
        const handler = new CodexElicitationHandler(
            connection,
            prompt,
            {elicitation: {form: {}}},
        );

        await handler.handleElicitation({
            threadId: "thread",
            turnId: "turn-1",
            serverName: "server",
            mode: "form",
            _meta: null,
            message: "Collect a value",
            requestedSchema: {type: "object", properties: {value: {type: "string"}}},
        });

        expect(prompt.nextStandaloneMcpToolCallId("server")).toBe("elicitation:session:server:1");
    });

    it("does not allocate a synthetic ID for a correlated permission fallback", async () => {
        const state = sessionState();
        const prompt = new PermissionLifecycleContext(state).beginPrompt();
        const requests: Array<{toolCall: {toolCallId: string}}> = [];
        const connection = {
            request: vi.fn().mockImplementation((_method, request) => {
                requests.push(request);
                return Promise.resolve({outcome: {outcome: "selected", optionId: "cancel"}});
            }),
            notify: vi.fn(),
        } as unknown as AcpClientConnection;
        const handler = new CodexElicitationHandler(connection, prompt);
        const approval = {
            threadId: "thread",
            turnId: "turn-1",
            serverName: "server",
            mode: "form" as const,
            _meta: {codex_approval_kind: "mcp_tool_call"},
            message: "Allow?",
            requestedSchema: {type: "object" as const, properties: {}},
        };

        prompt.handleNotification(mcpStarted("correlated-call", "turn-1"));
        await handler.handleElicitation(approval);
        await handler.handleElicitation(approval);

        expect(requests.map(request => request.toolCall.toolCallId)).toEqual([
            "correlated-call",
            "elicitation:session:server:1",
        ]);
    });
});

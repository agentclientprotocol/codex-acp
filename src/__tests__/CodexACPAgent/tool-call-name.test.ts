import {describe, expect, it} from "vitest";
import type {ServerNotification} from "../../app-server";
import type {CommandExecutionSource, ThreadItem} from "../../app-server/v2";
import {
    createCodexMockTestFixture,
    createTestSessionState,
    setupPromptAndSendNotifications,
} from "../acp-test-utils";

const sessionId = "tool-names-session";

function commandItem(source: CommandExecutionSource, read: boolean): Extract<ThreadItem, {type: "commandExecution"}> {
    return {
        type: "commandExecution",
        id: `${source}-${read ? "read" : "execute"}`,
        source,
        pluginId: null,
        scriptPath: null,
        command: read ? "cat /repo/config.json" : "npm test",
        cwd: "/repo",
        processId: null,
        status: "inProgress",
        commandActions: read
            ? [{type: "read", command: "cat /repo/config.json", name: "cat", path: "/repo/config.json"}]
            : [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
    };
}

function started(item: ThreadItem): ServerNotification {
    return {
        method: "item/started",
        params: {threadId: sessionId, turnId: "turn-id", startedAtMs: 0, item},
    };
}

describe("tool call names", () => {
    it("reports known execution tools independently of command titles and kinds", async () => {
        const fixture = createCodexMockTestFixture();
        const sources: CommandExecutionSource[] = [
            "unifiedExecStartup", "unifiedExecInteraction", "agent", "userShell",
        ];
        await setupPromptAndSendNotifications(
            fixture,
            sessionId,
            createTestSessionState({sessionId}),
            sources.flatMap(source => [started(commandItem(source, false)), started(commandItem(source, true))]),
        );

        await expect(fixture.getAcpConnectionDump([])).toMatchFileSnapshot("data/tool-call-command-names.json");
    });

    it("reports dynamic tool identity on the first event and leaves it unchanged on completion", async () => {
        const fixture = createCodexMockTestFixture();
        const items: Extract<ThreadItem, {type: "dynamicToolCall"}>[] = [null, "functions.", "tools"].map(namespace => ({
            type: "dynamicToolCall",
            id: namespace === null ? "plain-tool" : `${namespace}tool`,
            namespace,
            tool: "read_file",
            arguments: {path: "/repo/config.json"},
            status: "inProgress",
            contentItems: null,
            success: null,
            durationMs: null,
        }));
        const notifications = items.flatMap((item): ServerNotification[] => [
            started(item),
            {
                method: "item/completed",
                params: {
                    threadId: sessionId,
                    turnId: "turn-id",
                    completedAtMs: 0,
                    item: {...item, status: "completed", success: true},
                },
            },
        ]);
        await setupPromptAndSendNotifications(fixture, sessionId, createTestSessionState({sessionId}), notifications);

        await expect(fixture.getAcpConnectionDump([])).toMatchFileSnapshot("data/tool-call-dynamic-names.json");
    });

    it("includes known names when completion is the first available report", async () => {
        const fixture = createCodexMockTestFixture();
        const notifications: ServerNotification[] = [{
            method: "item/completed",
            params: {
                threadId: sessionId,
                turnId: "turn-id",
                completedAtMs: 0,
                item: {...commandItem("unifiedExecStartup", false), status: "completed"},
            },
        }];
        await setupPromptAndSendNotifications(fixture, sessionId, createTestSessionState({sessionId}), notifications);
        await expect(fixture.getAcpConnectionDump([])).toMatchFileSnapshot("data/tool-call-completed-name.json");
    });
});

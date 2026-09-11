import {describe, expect, it, vi} from "vitest";
import type {ServerNotification} from "../../app-server";
import type {ThreadItem} from "../../app-server/v2";
import {createCommandExecutionCompleteUpdate} from "../../CodexToolCallMapper";
import {
    createCodexMockTestFixture,
    createTestSessionState,
    setupPromptAndSendNotifications,
} from "../acp-test-utils";

type CommandExecutionItem = Extract<ThreadItem, {type: "commandExecution"}>;

describe("command execution status mapping", () => {
    it("maps a standalone ripgrep no-match exit as completed in replay", () => {
        expect(createCommandExecutionCompleteUpdate(command({
            command: 'rg -n "__definitely_absent_token__" README.md',
            status: "failed",
            exitCode: 1,
            aggregatedOutput: "",
        }), "terminal_output_delta")).toMatchObject({
            sessionUpdate: "tool_call_update",
            toolCallId: "command-1",
            status: "completed",
            rawOutput: {
                formatted_output: "",
                exit_code: 1,
            },
        });
    });

    it("maps a standalone ripgrep no-match exit as completed in live events", async () => {
        const fixture = createCodexMockTestFixture();
        const sessionId = "thread-1";
        const sessionState = createTestSessionState({sessionId});

        await setupPromptAndSendNotifications(fixture, sessionId, sessionState, [
            completed(command({
                command: "/bin/zsh -lc 'rg -n \"__definitely_absent_token__\" README.md'",
                status: "failed",
                exitCode: 1,
                aggregatedOutput: "",
            }), sessionId),
        ]);

        expect(fixture.getAcpConnectionEvents([])
            .filter(event => event.method === "sessionUpdate")
            .map(event => event.args[0].update)
        ).toContainEqual(expect.objectContaining({
            sessionUpdate: "tool_call_update",
            toolCallId: "command-1",
            status: "completed",
            rawOutput: {
                formatted_output: "",
                exit_code: 1,
            },
        }));
    });

    it("keeps ripgrep diagnostics and compound shell failures failed", () => {
        expect(createCommandExecutionCompleteUpdate(command({
            command: "rg -n '[' README.md",
            status: "failed",
            exitCode: 2,
            aggregatedOutput: "regex parse error",
        }), "terminal_output_delta")).toMatchObject({status: "failed"});

        expect(createCommandExecutionCompleteUpdate(command({
            command: "printf ok && rg -n absent README.md",
            status: "failed",
            exitCode: 1,
            aggregatedOutput: "ok",
        }), "terminal_output_delta")).toMatchObject({status: "failed"});
    });
});

function command(overrides: Partial<CommandExecutionItem> = {}): CommandExecutionItem {
    return {
        type: "commandExecution",
        id: "command-1",
        pluginId: null,
        scriptPath: null,
        command: "rg -n absent README.md",
        cwd: "/workspace",
        processId: "42",
        source: "unifiedExecStartup",
        status: "inProgress",
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
        ...overrides,
    };
}

function completed(item: ThreadItem, threadId: string): ServerNotification {
    return {
        method: "item/completed",
        params: {
            threadId,
            turnId: "turn-id",
            completedAtMs: 0,
            item,
        },
    };
}

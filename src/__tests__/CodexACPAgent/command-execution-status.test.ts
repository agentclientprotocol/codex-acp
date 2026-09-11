import {describe, expect, it} from "vitest";
import type {ServerNotification} from "../../app-server";
import type {ThreadItem} from "../../app-server/v2";
import {AcpToolCallRenderer} from "../../tool-calls/AcpToolCallRenderer";
import {ClientCapabilities} from "../../tool-calls/ClientCapabilities";
import {CommandReporter} from "../../tool-calls/reporters/CommandReporter";
import {
    createCodexMockTestFixture,
    createTestSessionState,
    setupPromptAndSendNotifications,
} from "../acp-test-utils";

type CommandExecutionItem = Extract<ThreadItem, {type: "commandExecution"}>;

const DELTA_CLIENT = ClientCapabilities.from({_meta: {terminal_output_delta: true, jetbrains: {air: {version: 1}}}});

describe("command execution status mapping", () => {
    it("maps a standalone ripgrep no-match exit as completed in replay", () => {
        expect(completeUpdate(command({
            command: 'rg -n "__definitely_absent_token__" README.md',
            status: "failed",
            exitCode: 1,
            aggregatedOutput: "",
        }))).toMatchObject({
            sessionUpdate: "tool_call_update",
            toolCallId: "command-1",
            status: "completed",
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
        }));
    });

    it("keeps ripgrep diagnostics and compound shell failures failed", () => {
        expect(completeUpdate(command({
            command: "rg -n '[' README.md",
            status: "failed",
            exitCode: 2,
            aggregatedOutput: "regex parse error",
        }))).toMatchObject({status: "failed"});

        expect(completeUpdate(command({
            command: "printf ok && rg -n absent README.md",
            status: "failed",
            exitCode: 1,
            aggregatedOutput: "ok",
        }))).toMatchObject({status: "failed"});
    });
});

function completeUpdate(item: CommandExecutionItem) {
    const reporter = new CommandReporter();
    reporter.started({...item, status: "inProgress", aggregatedOutput: null, exitCode: null});
    return new AcpToolCallRenderer(DELTA_CLIENT).render(reporter.completed(item));
}

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

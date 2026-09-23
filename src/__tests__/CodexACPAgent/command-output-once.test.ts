import {describe, expect, it} from "vitest";
import type {ServerNotification} from "../../app-server";
import type {ThreadItem} from "../../app-server/v2";
import {AcpToolCallRenderer} from "../../tool-calls/AcpToolCallRenderer";
import {ClientCapabilities} from "../../tool-calls/ClientCapabilities";
import {CommandReporter} from "../../tool-calls/reporters/CommandReporter";
import {McpStartupReporter} from "../../tool-calls/reporters/McpStartupReporter";
import {parseResponseItemHistoryFallback} from "../../ResponseItemHistoryFallback";
import {createCodexMockTestFixture, createTestSessionState, setupPromptAndSendNotifications} from "../acp-test-utils";

type CommandItem = ThreadItem & {type: "commandExecution"};

function command(overrides: Partial<CommandItem> = {}): CommandItem {
    return {
        type: "commandExecution",
        id: "cmd-1",
        pluginId: null,
        scriptPath: null,
        command: "ls",
        cwd: "/workspace",
        processId: null,
        source: "agent",
        status: "completed",
        commandActions: [],
        aggregatedOutput: "a.txt\nb.txt\n",
        exitCode: 0,
        durationMs: 1,
        ...overrides,
    };
}

function occurrences(value: unknown, text: string): number {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    return serialized.split(JSON.stringify(text).slice(1, -1)).length - 1;
}

const DELTA_CLIENT = ClientCapabilities.DEFAULT.with({airClient: true, terminalOutputDelta: true});
const ZED_CLIENT = ClientCapabilities.DEFAULT.with({terminalOutput: true});

function completion(item: CommandItem, capabilities: ClientCapabilities) {
    const reporter = new CommandReporter();
    reporter.started({...item, status: "inProgress"});
    return new AcpToolCallRenderer(capabilities).render(reporter.completed(item));
}

describe("command output is sent once", () => {
    it("sends the output as terminal_output_delta to AIR", () => {
        expect(completion(command(), DELTA_CLIENT)).toEqual({
            sessionUpdate: "tool_call_update",
            toolCallId: "cmd-1",
            status: "completed",
            _meta: {
                terminal_output_delta: {data: "a.txt\nb.txt\n", terminal_id: "cmd-1"},
                terminal_exit: {exit_code: 0, signal: null, terminal_id: "cmd-1"},
            },
        });
    });

    it("keeps the Zed terminal conventions for a client without output deltas", () => {
        const renderer = new AcpToolCallRenderer(ZED_CLIENT);
        const reporter = new CommandReporter();
        const start = renderer.render(reporter.started(command({status: "inProgress", aggregatedOutput: null, exitCode: null})));
        const chunk = renderer.render(reporter.outputDelta("cmd-1", "a.txt\nb.txt\n")!);
        const end = renderer.render(reporter.completed(command()));

        expect(start).toMatchObject({
            content: [{type: "terminal", terminalId: "cmd-1"}],
            _meta: {terminal_info: {cwd: "/workspace", terminal_id: "cmd-1"}},
        });
        expect(chunk).toEqual({
            sessionUpdate: "tool_call_update",
            toolCallId: "cmd-1",
            _meta: {terminal_output: {data: "a.txt\nb.txt\n", terminal_id: "cmd-1"}},
        });
        expect(end).toEqual({
            sessionUpdate: "tool_call_update",
            toolCallId: "cmd-1",
            status: "completed",
            rawOutput: {formatted_output: "a.txt\nb.txt\n", exit_code: 0},
            _meta: {terminal_exit: {exit_code: 0, signal: null, terminal_id: "cmd-1"}},
        });
    });

    it("sends the output of a read command once in the content to AIR", () => {
        const update = completion(command({
            commandActions: [{type: "read", command: "cat a.txt", name: "a.txt", path: "/workspace/a.txt"}],
        }), DELTA_CLIENT);

        expect(update).toEqual({
            sessionUpdate: "tool_call_update",
            toolCallId: "cmd-1",
            status: "completed",
            content: [{type: "content", content: {type: "text", text: "a.txt\nb.txt\n"}}],
        });
    });

    it("sends the output of a read command to Zed in rawOutput, as before the AIR contract", () => {
        const update = completion(command({
            commandActions: [{type: "read", command: "cat a.txt", name: "a.txt", path: "/workspace/a.txt"}],
        }), ZED_CLIENT);

        expect(update).toEqual({
            sessionUpdate: "tool_call_update",
            toolCallId: "cmd-1",
            status: "completed",
            rawOutput: {formatted_output: "a.txt\nb.txt\n", exit_code: 0},
        });
    });

    it("sends stdin as terminal_input and not as output", () => {
        const renderer = new AcpToolCallRenderer(DELTA_CLIENT);
        const reporter = new CommandReporter();
        reporter.started(command({status: "inProgress"}));

        expect(renderer.render(reporter.terminalInput("cmd-1", "yes")!)).toEqual({
            sessionUpdate: "tool_call_update",
            toolCallId: "cmd-1",
            _meta: {terminal_input: {data: "yes", terminal_id: "cmd-1"}},
        });
    });

    it("sends the live output only as streamed deltas", async () => {
        const fixture = createCodexMockTestFixture();
        const sessionId = "command-once";
        await setupPromptAndSendNotifications(
            fixture,
            sessionId,
            createTestSessionState({sessionId, clientCapabilities: DELTA_CLIENT}),
            liveCommand(sessionId),
        );

        const dump = fixture.getAcpConnectionDump([]);
        expect(occurrences(dump, "a.txt\nb.txt\n")).toBe(1);
        expect(dump).toContain("terminal_output_delta");
        expect(dump).not.toContain("formatted_output");
        expect(dump).not.toContain("exit_code\": 0,\n        \"formatted");
    });

    it("sends the live output of Zed as terminal_output chunks and the whole output in rawOutput", async () => {
        const fixture = createCodexMockTestFixture();
        const sessionId = "command-once-zed";
        await setupPromptAndSendNotifications(
            fixture,
            sessionId,
            createTestSessionState({sessionId, clientCapabilities: ZED_CLIENT}),
            liveCommand(sessionId),
        );

        const dump = fixture.getAcpConnectionDump([]);
        expect(occurrences(dump, "a.txt\nb.txt\n")).toBe(2);
        expect(dump).toContain("\"terminal_output\"");
        expect(dump).toContain("terminal_exit");
        expect(dump).toContain("formatted_output");
        expect(dump).not.toContain("terminal_output_delta");
    });

    it("sends the streamed output of a read command once in the content", async () => {
        const fixture = createCodexMockTestFixture();
        const sessionId = "read-once";
        const read = {commandActions: [{type: "read" as const, command: "cat a.txt", name: "a.txt", path: "/workspace/a.txt"}]};
        await setupPromptAndSendNotifications(
            fixture,
            sessionId,
            createTestSessionState({sessionId}),
            liveCommand(sessionId, read),
        );

        const dump = fixture.getAcpConnectionDump([]);
        expect(occurrences(dump, "a.txt\nb.txt\n")).toBe(1);
        expect(dump).not.toContain("terminal_output_delta");
        expect(dump).toContain("\"content\"");
    });

    it("replays fallback history output only in the terminal channel for AIR, and also in rawOutput for Zed", () => {
        const jsonl = [
            {type: "response_item", payload: {type: "function_call", name: "exec_command", call_id: "call-1", arguments: JSON.stringify({cmd: "npm test", workdir: "/workspace", yield_time_ms: 1000})}},
            {type: "response_item", payload: {type: "function_call_output", call_id: "call-1", output: "Process exited with code 0\nOutput:\nfallback-output\n"}},
        ].map(line => JSON.stringify(line)).join("\n");

        const air = parseResponseItemHistoryFallback(jsonl, DELTA_CLIENT)
            ?.find(update => update.sessionUpdate === "tool_call_update");
        expect(air).not.toHaveProperty("rawOutput");
        expect(occurrences(air, "fallback-output")).toBe(1);
        expect(air).toHaveProperty("_meta.terminal_exit");

        const zed = parseResponseItemHistoryFallback(jsonl, ZED_CLIENT)
            ?.find(update => update.sessionUpdate === "tool_call_update");
        expect(occurrences(zed, "fallback-output")).toBe(2);
        expect(zed).toHaveProperty("rawOutput.formatted_output");
        expect(zed).toHaveProperty("_meta.terminal_output");
        expect(zed).toHaveProperty("_meta.terminal_exit");
    });
});

function liveCommand(sessionId: string, overrides: Partial<CommandItem> = {}): ServerNotification[] {
    return [
        {
            method: "item/started",
            params: {threadId: sessionId, turnId: "turn-1", startedAtMs: 0, item: command({status: "inProgress", aggregatedOutput: null, exitCode: null, ...overrides})},
        },
        {
            method: "item/commandExecution/outputDelta",
            params: {threadId: sessionId, turnId: "turn-1", itemId: "cmd-1", delta: "a.txt\nb.txt\n"},
        },
        {
            method: "item/completed",
            params: {threadId: sessionId, turnId: "turn-1", completedAtMs: 1, item: command(overrides)},
        },
    ];
}

describe("late output deltas", () => {
    it("drops command and MCP output that arrives after completion", async () => {
        const fixture = createCodexMockTestFixture();
        const sessionId = "late-output";
        const notifications: ServerNotification[] = [
            {
                method: "item/started",
                params: {threadId: sessionId, turnId: "turn-1", startedAtMs: 0, item: command({status: "inProgress", aggregatedOutput: null, exitCode: null})},
            },
            {
                method: "item/completed",
                params: {threadId: sessionId, turnId: "turn-1", completedAtMs: 1, item: command()},
            },
            {
                method: "item/commandExecution/outputDelta",
                params: {threadId: sessionId, turnId: "turn-1", itemId: "cmd-1", delta: "late-command-output"},
            },
            {
                method: "item/mcpToolCall/progress",
                params: {threadId: sessionId, turnId: "turn-1", itemId: "cmd-1", message: "late-mcp-output"},
            },
        ];

        await setupPromptAndSendNotifications(fixture, sessionId, createTestSessionState({sessionId}), notifications);

        const dump = fixture.getAcpConnectionDump([]);
        expect(dump).not.toContain("late-command-output");
        expect(dump).not.toContain("late-mcp-output");
    });
});

describe("MCP startup tool call ids", () => {
    it("gives each startup report a unique tool call id", () => {
        const event = {ready: [], failed: [{server: "broken", error: "boom", failureReason: null}], cancelled: ["slow"]};
        const first = McpStartupReporter.failures(event as never);
        const second = McpStartupReporter.failures(event as never);
        const ids = [...first, ...second].map(facts => facts.toolCallId);

        expect(new Set(ids).size).toBe(4);
        expect(ids[0]).toMatch(/^mcp_startup\.broken\./);
        expect(ids[1]).toMatch(/^mcp_startup\.slow\./);
    });
});

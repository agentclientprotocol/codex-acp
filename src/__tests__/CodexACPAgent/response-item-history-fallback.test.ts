import { describe, expect, it } from "vitest";
import type { UpdateSessionEvent } from "../../ACPSessionConnection";
import { parseResponseItemHistoryFallback } from "../../ResponseItemHistoryFallback";

type ToolCallUpdate = Extract<UpdateSessionEvent, { sessionUpdate: "tool_call_update" }>;

describe("ResponseItemHistoryFallback", () => {
    it("recovers only missing function calls for mixed parsed histories", () => {
        const updates = parseResponseItemHistoryFallback(jsonl([
            functionCall("call-existing", "rg \"Existing\" src"),
            functionCallOutput("call-existing", "Chunk ID: existing\nProcess exited with code 0\nOutput:\nsrc/existing.ts\n"),
            functionCall("call-missing", "rg \"Missing\" src"),
            functionCallOutput("call-missing", "Chunk ID: missing\nProcess exited with code 0\nOutput:\nsrc/missing.ts\n"),
        ]), "terminal_output", new Set(["call-existing"]));

        expect(toolCallIds(updates)).toEqual(["call-missing"]);
        expect(toolCallUpdateStatuses(updates)).toEqual([
            { toolCallId: "call-missing", status: "completed" },
        ]);
    });

    it("does not recover function calls when all parsed tool call ids already exist", () => {
        const updates = parseResponseItemHistoryFallback(jsonl([
            functionCall("call-existing-a", "rg \"ExistingA\" src"),
            functionCallOutput("call-existing-a", "Chunk ID: existing-a\nProcess exited with code 0\nOutput:\nsrc/a.ts\n"),
            functionCall("call-existing-b", "rg \"ExistingB\" src"),
            functionCallOutput("call-existing-b", "Chunk ID: existing-b\nProcess exited with code 0\nOutput:\nsrc/b.ts\n"),
        ]), "terminal_output", new Set(["call-existing-a", "call-existing-b"]));

        expect(toolCallIds(updates)).toEqual([]);
        expect(toolCallUpdateStatuses(updates)).toEqual([]);
    });

    it("recovers scripted tool calls recorded as custom_tool_call", () => {
        const updates = parseResponseItemHistoryFallback(jsonl([
            customToolCall(
                "call-scripted",
                'const r = await tools.exec_command({"cmd":"echo hello"});\ntext(r.output);\n',
            ),
            customToolCallOutput("call-scripted", "Script completed\nOutput:\n", "hello\n"),
        ]), "terminal_output", new Set());

        expect(toolCallIds(updates)).toEqual(["call-scripted"]);
        expect(toolCallUpdateStatuses(updates)).toEqual([
            { toolCallId: "call-scripted", status: "completed" },
        ]);
    });

    it("surfaces the script itself, since what a script ran is not recorded", () => {
        const script = 'for (const cmd of ["echo alpha", "echo beta"]) { await tools.exec_command({cmd}); }';
        const updates = parseResponseItemHistoryFallback(jsonl([
            customToolCall("call-loop", script),
        ]), "terminal_output", new Set());

        const serialized = JSON.stringify(updates);
        expect(serialized).toContain("echo alpha");
        expect(serialized).toContain("echo beta");
    });

    it("maps a scripted call to the execute kind", () => {
        const updates = parseResponseItemHistoryFallback(jsonl([
            customToolCall("call-kind", 'await tools.exec_command({"cmd":"ls"});'),
        ]), "terminal_output", new Set());

        const toolCall = (updates ?? []).find((update) => update.sessionUpdate === "tool_call");
        expect(toolCall && "kind" in toolCall ? toolCall.kind : null).toBe("execute");
    });

    it("carries the combined script output through", () => {
        const updates = parseResponseItemHistoryFallback(jsonl([
            customToolCall("call-out", 'await tools.exec_command({"cmd":"ls"});'),
            customToolCallOutput("call-out", "Output:\n", "1: alpha\n", "2: beta\n"),
        ]), "terminal_output", new Set());

        const serialized = JSON.stringify(updates);
        expect(serialized).toContain("1: alpha");
        expect(serialized).toContain("2: beta");
    });

    it("skips scripted calls already present in the parsed thread", () => {
        const updates = parseResponseItemHistoryFallback(jsonl([
            customToolCall("call-existing", 'await tools.exec_command({"cmd":"ls"});'),
            customToolCallOutput("call-existing", "Output:\n", "ok\n"),
        ]), "terminal_output", new Set(["call-existing"]));

        expect(toolCallIds(updates)).toEqual([]);
        expect(toolCallUpdateStatuses(updates)).toEqual([]);
    });

    it("reports a failing script as failed", () => {
        const updates = parseResponseItemHistoryFallback(jsonl([
            customToolCall("call-fail", 'await tools.exec_command({"cmd":"false"});'),
            customToolCallOutput("call-fail", "Permission denied\n"),
        ]), "terminal_output", new Set());

        expect(toolCallUpdateStatuses(updates)).toEqual([
            { toolCallId: "call-fail", status: "failed" },
        ]);
    });

    it("still recovers a scripted call whose tool name is unfamiliar", () => {
        const updates = parseResponseItemHistoryFallback(jsonl([
            {
                type: "response_item",
                payload: {
                    type: "custom_tool_call",
                    call_id: "call-other",
                    name: "some_other_sandbox",
                    input: 'await tools.exec_command({"cmd":"ls"});',
                },
            },
        ]), "terminal_output", new Set());

        expect(toolCallIds(updates)).toEqual(["call-other"]);
        expect(JSON.stringify(updates)).toContain("tools.exec_command");
    });

    it("does not duplicate adjacent reasoning from event and response item records", () => {
        const updates = parseResponseItemHistoryFallback(jsonl([
            {
                type: "event_msg",
                payload: {
                    type: "agent_reasoning",
                    text: "Need to inspect the directory.",
                },
            },
            {
                type: "response_item",
                payload: {
                    type: "reasoning",
                    summary: [{ type: "summary_text", text: "Need to inspect the directory." }],
                    content: [],
                },
            },
            functionCall("call-search", "rg \"Needle\" src"),
            functionCallOutput("call-search", "Chunk ID: search\nProcess exited with code 0\nOutput:\nsrc/index.ts\n"),
        ]), "terminal_output");

        expect(thoughtTexts(updates)).toEqual(["Need to inspect the directory."]);
    });

    it("preserves assistant message phase metadata from response items", () => {
        const updates = parseResponseItemHistoryFallback(jsonl([
            {
                type: "response_item",
                payload: {
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: "Final answer text." }],
                    phase: "final_answer",
                },
            },
            functionCall("call-missing", "ls"),
            functionCallOutput("call-missing", "Chunk ID: missing\nProcess exited with code 0\nOutput:\nREADME.md\n"),
        ]), "terminal_output");

        expect(agentMessageMetas(updates)).toEqual([
            { codex: { phase: "final_answer" } },
        ]);
    });

    it("marks exec command outputs without exit footers failed when they report command errors", () => {
        const updates = parseResponseItemHistoryFallback(jsonl([
            functionCall("call-read-failed", "cat missing.txt"),
            functionCallOutput("call-read-failed", "Error: No such file or directory\n"),
        ]), "terminal_output");

        expect(toolCallUpdateStatuses(updates)).toEqual([
            { toolCallId: "call-read-failed", status: "failed" },
        ]);
    });

    it("marks exec command outputs without exit footers completed when they do not report errors", () => {
        const updates = parseResponseItemHistoryFallback(jsonl([
            functionCall("call-read-ok", "cat existing.txt"),
            functionCallOutput("call-read-ok", "existing file contents\n"),
        ]), "terminal_output");

        expect(toolCallUpdateStatuses(updates)).toEqual([
            { toolCallId: "call-read-ok", status: "completed" },
        ]);
    });
});

function jsonl(records: unknown[]): string {
    return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function functionCall(callId: string, cmd: string): unknown {
    return {
        type: "response_item",
        payload: {
            type: "function_call",
            name: "exec_command",
            arguments: JSON.stringify({
                cmd,
                workdir: "/workspace",
                yield_time_ms: 1000,
            }),
            call_id: callId,
        },
    };
}

function functionCallOutput(callId: string, output: string): unknown {
    return {
        type: "response_item",
        payload: {
            type: "function_call_output",
            call_id: callId,
            output,
        },
    };
}

function customToolCall(callId: string, input: string): unknown {
    return {
        type: "response_item",
        payload: { type: "custom_tool_call", call_id: callId, name: "exec", input },
    };
}

function customToolCallOutput(callId: string, ...texts: string[]): unknown {
    return {
        type: "response_item",
        payload: {
            type: "custom_tool_call_output",
            call_id: callId,
            output: texts.map((text) => ({ type: "input_text", text })),
        },
    };
}

function toolCallIds(updates: UpdateSessionEvent[] | null): string[] {
    return (updates ?? [])
        .filter((update): update is Extract<UpdateSessionEvent, { sessionUpdate: "tool_call" }> => (
            update.sessionUpdate === "tool_call"
        ))
        .map((update) => update.toolCallId);
}

function toolCallUpdateStatuses(updates: UpdateSessionEvent[] | null): Array<Pick<ToolCallUpdate, "toolCallId" | "status">> {
    return (updates ?? [])
        .filter((update): update is ToolCallUpdate => update.sessionUpdate === "tool_call_update")
        .map((update) => ({
            toolCallId: update.toolCallId,
            status: update.status ?? null,
        }));
}

function thoughtTexts(updates: UpdateSessionEvent[] | null): string[] {
    return (updates ?? [])
        .filter((update): update is Extract<UpdateSessionEvent, { sessionUpdate: "agent_thought_chunk" }> => (
            update.sessionUpdate === "agent_thought_chunk"
        ))
        .flatMap((update) => update.content.type === "text" ? [update.content.text] : []);
}

function agentMessageMetas(updates: UpdateSessionEvent[] | null): unknown[] {
    return (updates ?? [])
        .filter((update): update is Extract<UpdateSessionEvent, { sessionUpdate: "agent_message_chunk" }> => (
            update.sessionUpdate === "agent_message_chunk"
        ))
        .map((update) => update._meta);
}

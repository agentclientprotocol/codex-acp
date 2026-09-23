import {describe, expect, it} from "vitest";
import {AcpToolCallRenderer} from "../../tool-calls/AcpToolCallRenderer";
import {ClientCapabilities} from "../../tool-calls/ClientCapabilities";
import type {ToolFacts} from "../../tool-calls/ToolFacts";
import {CollabAgentReporter} from "../../tool-calls/reporters/CollabAgentReporter";
import {CommandReporter} from "../../tool-calls/reporters/CommandReporter";
import {CompactionReporter} from "../../tool-calls/reporters/CompactionReporter";
import {DynamicToolReporter} from "../../tool-calls/reporters/DynamicToolReporter";
import {ElicitationReporter} from "../../tool-calls/reporters/ElicitationReporter";
import {FuzzySearchReporter} from "../../tool-calls/reporters/FuzzySearchReporter";
import {GuardianReporter} from "../../tool-calls/reporters/GuardianReporter";
import {ImageGenerationReporter} from "../../tool-calls/reporters/ImageGenerationReporter";
import {ImageViewReporter} from "../../tool-calls/reporters/ImageViewReporter";
import {McpStartupReporter} from "../../tool-calls/reporters/McpStartupReporter";
import {McpToolReporter} from "../../tool-calls/reporters/McpToolReporter";
import {SubagentActivityReporter} from "../../tool-calls/reporters/SubagentActivityReporter";
import {WebSearchReporter} from "../../tool-calls/reporters/WebSearchReporter";

const AIR = ClientCapabilities.from({
    _meta: {
        terminal_output_delta: true,
        jetbrains: {air: {version: 1, capabilities: ["rawInputRendering", "planContentDelta", "diffPatch"]}},
    },
});
const ZED = ClientCapabilities.from({_meta: {terminal_output: true}});
const AIR_WITHOUT_RAW_INPUT_RENDERING = ClientCapabilities.from({
    _meta: {terminal_output_delta: true, jetbrains: {air: {version: 1, capabilities: []}}},
});

const command = {
    type: "commandExecution", id: "cmd", pluginId: null, scriptPath: null, command: "/bin/zsh -lc 'npm test'",
    cwd: "/w", processId: null, source: "agent", status: "completed", commandActions: [],
    aggregatedOutput: "ok\n", exitCode: 0, durationMs: 1,
} as const;
const read = {
    ...command, id: "read", command: "cat a.txt",
    commandActions: [{type: "read", command: "cat a.txt", name: "a.txt", path: "/w/a.txt"}],
} as const;
const mcp = {
    type: "mcpToolCall", id: "mcp", server: "docs", tool: "search", status: "completed", arguments: {q: "acp"},
    appContext: null, readOnlyHint: null, pluginId: null, durationMs: 1,
    result: {content: [{type: "text", text: "hit"}], structuredContent: {hits: 1}, _meta: null}, error: null,
} as const;
const collab = {
    type: "collabAgentToolCall", id: "collab", tool: "spawnAgent", status: "completed", senderThreadId: "root",
    receiverThreadIds: ["child"], prompt: "Find the weather.", model: null, reasoningEffort: null,
    agentsStates: {child: {status: "completed", message: null}},
} as const;
const guardianEvent = {
    threadId: "s", turnId: "t", startedAtMs: 0, completedAtMs: 1, reviewId: "r", targetItemId: null,
    decisionSource: "agent",
    review: {status: "approved", riskLevel: "low", userAuthorization: null, rationale: "Safe."},
    action: {type: "command", source: "shell", command: "ls", cwd: "/w"},
} as const;

/** One report of each tool kind, as the reporters produce it. */
function reportsOfEachKind(): Record<string, ToolFacts[]> {
    const commands = new CommandReporter();
    const reads = new CommandReporter();
    return {
        command: [
            commands.started({...command, status: "inProgress", aggregatedOutput: null, exitCode: null} as never),
            commands.outputDelta("cmd", "ok\n")!,
            commands.terminalInput("cmd", "y")!,
            commands.completed(command as never),
        ],
        read: [reads.started({...read, status: "inProgress"} as never), reads.completed(read as never)],
        mcp: [McpToolReporter.started({...mcp, status: "inProgress", result: null} as never),
            McpToolReporter.progress("mcp", "line 1\n"), McpToolReporter.completed(mcp as never)],
        dynamicTool: [DynamicToolReporter.completed({
            type: "dynamicToolCall", id: "dyn", tool: "list_apps", namespace: null, status: "completed",
            arguments: {}, contentItems: [{type: "inputText", text: "Done"}], success: true, durationMs: 1,
        } as never)],
        webSearch: [WebSearchReporter.history({type: "webSearch", id: "web", query: "acp", action: null} as never)],
        imageView: [ImageViewReporter.viewed({type: "imageView", id: "img", path: "/w/a.png"} as never)],
        imageGeneration: [ImageGenerationReporter.whole({
            type: "imageGeneration", id: "gen", status: "completed", revisedPrompt: "A square", result: "AAAA",
            savedPath: "/w/square.png", failure: null,
        } as never)],
        collab: [CollabAgentReporter.started(collab as never)],
        subagentActivity: [SubagentActivityReporter.activity({
            type: "subAgentActivity", id: "act", kind: "started", agentThreadId: "child", agentPath: "/root/child",
        } as never, "in_progress", "start")],
        fuzzySearch: [new FuzzySearchReporter().updated({sessionId: "f", query: "App", files: []} as never)],
        guardian: [new GuardianReporter().completed(guardianEvent as never)],
        compaction: [CompactionReporter.history({type: "contextCompaction", id: "compact"} as never)],
        elicitation: [ElicitationReporter.answered("ask", "accept")],
        mcpStartup: McpStartupReporter.failures({ready: [], failed: [{server: "db", error: "boom", failureReason: null}], cancelled: []} as never)
            .map(facts => ({...facts, toolCallId: "mcp_startup.db"})),
    };
}

function render(capabilities: ClientCapabilities): string {
    const renderer = new AcpToolCallRenderer(capabilities);
    const rendered = Object.fromEntries(Object.entries(reportsOfEachKind())
        .map(([kind, reports]) => [kind, reports.map(facts => renderer.render(facts))]));
    return `${JSON.stringify(rendered, null, 2)}\n`;
}

describe("ACP tool call contract", () => {
    it("renders each tool kind for AIR", async () => {
        await expect(render(AIR)).toMatchFileSnapshot("data/tool-calls-air.json");
    });

    it("renders each tool kind for a Zed-like client", async () => {
        await expect(render(ZED)).toMatchFileSnapshot("data/tool-calls-zed.json");
    });

    it("never sends the pre-contract keys to AIR", () => {
        const text = render(AIR);
        expect(text).not.toContain("formatted_output");
        expect(text).not.toContain("\"codex\"");
    });

    it("never sends an AIR key to Zed", () => {
        expect(render(ZED)).not.toContain("jetbrains");
    });

    it("keeps the Zed terminal conventions and the command output in rawOutput", () => {
        const text = render(ZED);
        expect(text).toContain("terminal_info");
        expect(text).toContain("\"terminal_output\"");
        expect(text).toContain("terminal_exit");
        expect(text).toContain("formatted_output");
        expect(text).not.toContain("\"terminal_input\"");
        expect(text).not.toContain("terminal_output_delta");
    });

    it("sends one display copy of readable input only to AIR without rawInputRendering", () => {
        const facts = CollabAgentReporter.started(collab as never);
        const zed = new AcpToolCallRenderer(ZED).render(facts);
        const air = new AcpToolCallRenderer(AIR).render(facts);
        const airWithoutRendering = new AcpToolCallRenderer(AIR_WITHOUT_RAW_INPUT_RENDERING).render(facts);

        expect(airWithoutRendering.content).toEqual([{type: "content", content: {type: "text", text: "Find the weather."}}]);
        expect(air).not.toHaveProperty("content");
        expect(air.rawInput).toMatchObject({prompt: "Find the weather."});
        expect(zed).not.toHaveProperty("content");
        expect(zed.rawInput).toMatchObject({prompt: "Find the weather.", status: "completed"});
    });

    it("shows the question of a standalone elicitation only once for AIR", () => {
        const facts = ElicitationReporter.permission({
            threadId: "s", turnId: "t", serverName: "srv", mode: "form", _meta: null,
            message: "Pick a value", requestedSchema: {type: "object", properties: {}},
        } as never, false, undefined, () => "ask");

        expect(new AcpToolCallRenderer(AIR).renderPermissionToolCall(facts)).not.toHaveProperty("content");
        expect(new AcpToolCallRenderer(ZED).renderPermissionToolCall(facts).content)
            .toEqual([{type: "content", content: {type: "text", text: "Pick a value"}}]);
    });

    it("sends trimmed MCP progress text to a client that is not AIR, and none to AIR", () => {
        const zed = new AcpToolCallRenderer(ZED).render(McpToolReporter.progress("mcp", "  line 1\n"));
        expect(zed._meta).toEqual({mcp_output_delta: {data: "line 1"}});
        const air = new AcpToolCallRenderer(AIR).render(McpToolReporter.progress("mcp", "  line 1\n"));
        expect(air).toEqual({sessionUpdate: "tool_call_update", toolCallId: "mcp"});
    });
});

describe("ClientCapabilities", () => {
    it("reads the AIR client and the AIR capabilities only from _meta.jetbrains.air", () => {
        expect(AIR.airClient).toBe(true);
        expect(ZED.airClient).toBe(false);
        expect(AIR.air).toEqual({rawInputRendering: true, planContentDelta: true, diffPatch: true});
        expect(ClientCapabilities.from({_meta: {rawInputRendering: true, planContentDelta: true}}).air)
            .toEqual({rawInputRendering: false, planContentDelta: false, diffPatch: false});
    });

    it("selects the terminal channel that the client declares, and terminal_output_delta for any other client", () => {
        expect(AIR.terminalOutputKey(true)).toBe("terminal_output_delta");
        expect(AIR.terminalOutputKey(false)).toBe("terminal_output_delta");
        expect(ZED.terminalOutputKey(true)).toBe("terminal_output");
        expect(ZED.terminalOutputKey(false)).toBe("terminal_output_delta");
        expect(ClientCapabilities.from(null).terminalOutputKey(true)).toBe("terminal_output_delta");
        expect(ClientCapabilities.from(null).terminalOutputKey(false)).toBe("terminal_output_delta");
        expect(ClientCapabilities.from({_meta: {terminal_output_delta: true}}).terminalOutputKey(false))
            .toBe("terminal_output_delta");
        expect(ClientCapabilities.from({_meta: {jetbrains: {air: {version: 1}}}}).terminalOutputKey(true)).toBeNull();
    });
});

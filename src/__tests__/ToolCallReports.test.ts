import {describe, expect, it} from "vitest";
import {ToolCallReports} from "../ToolCallReports";

describe("ToolCallReports", () => {
    it("removes fields that did not change since the start", () => {
        const reports = new ToolCallReports();
        reports.prepare("s", {
            sessionUpdate: "tool_call",
            toolCallId: "web-1",
            kind: "search",
            title: "Web search: acp",
            status: "in_progress",
            rawInput: {query: "acp"},
            _meta: {codex: {tool: "web"}},
        });

        expect(reports.prepare("s", {
            sessionUpdate: "tool_call_update",
            toolCallId: "web-1",
            title: "Web search: acp",
            status: "completed",
            rawInput: {query: "acp"},
            _meta: {codex: {tool: "web"}},
        })).toEqual({
            sessionUpdate: "tool_call_update",
            toolCallId: "web-1",
            status: "completed",
        });
    });

    it("keeps every _meta key for a client that is not AIR, because ACP defines no merge for _meta", () => {
        const reports = new ToolCallReports();
        reports.compareMeta = false;
        reports.prepare("s", {
            sessionUpdate: "tool_call",
            toolCallId: "cmd-1",
            title: "npm test",
            status: "in_progress",
            _meta: {terminal_info: {cwd: "/w", terminal_id: "cmd-1"}, codex: {tool: "exec"}},
        });

        expect(reports.prepare("s", {
            sessionUpdate: "tool_call_update",
            toolCallId: "cmd-1",
            title: "npm test",
            status: "completed",
            _meta: {terminal_info: {cwd: "/w", terminal_id: "cmd-1"}, codex: {tool: "exec"}},
        })).toEqual({
            sessionUpdate: "tool_call_update",
            toolCallId: "cmd-1",
            status: "completed",
            _meta: {terminal_info: {cwd: "/w", terminal_id: "cmd-1"}, codex: {tool: "exec"}},
        });
        expect(reports.prepare("s", {
            sessionUpdate: "tool_call_update",
            toolCallId: "cmd-1",
            _meta: {codex: {tool: "exec"}},
        })).toEqual({sessionUpdate: "tool_call_update", toolCallId: "cmd-1", _meta: {codex: {tool: "exec"}}});
    });

    it("keeps fields that changed since the start", () => {
        const reports = new ToolCallReports();
        reports.prepare("s", {
            sessionUpdate: "tool_call",
            toolCallId: "web-1",
            title: "Web search",
            status: "in_progress",
            rawInput: {query: ""},
            _meta: {codex: {tool: "web"}, other: 1},
        });

        expect(reports.prepare("s", {
            sessionUpdate: "tool_call_update",
            toolCallId: "web-1",
            title: "Web search: acp",
            status: "completed",
            rawInput: {query: "acp"},
            _meta: {codex: {tool: "web"}, other: 2},
        })).toEqual({
            sessionUpdate: "tool_call_update",
            toolCallId: "web-1",
            title: "Web search: acp",
            status: "completed",
            rawInput: {query: "acp"},
            _meta: {other: 2},
        });
    });

    it("drops an update that carries no change", () => {
        const reports = new ToolCallReports();
        reports.prepare("s", {
            sessionUpdate: "tool_call",
            toolCallId: "search-1",
            title: "Search",
            status: "in_progress",
            locations: [{path: "/a"}],
        });

        expect(reports.prepare("s", {
            sessionUpdate: "tool_call_update",
            toolCallId: "search-1",
            title: "Search",
            status: "in_progress",
            locations: [{path: "/a"}],
        })).toBeNull();
    });

    it("never compares appended output chunks", () => {
        const reports = new ToolCallReports();
        reports.prepare("s", {sessionUpdate: "tool_call", toolCallId: "cmd-1", title: "ls", status: "in_progress"});
        const chunk = {
            sessionUpdate: "tool_call_update" as const,
            toolCallId: "cmd-1",
            _meta: {terminal_output_delta: {data: "same\n", terminal_id: "cmd-1"}},
        };

        expect(reports.prepare("s", chunk)).toEqual(chunk);
        expect(reports.prepare("s", chunk)).toEqual(chunk);
    });

    it("sends every field of a tool call that it does not know", () => {
        const reports = new ToolCallReports();
        const update = {
            sessionUpdate: "tool_call_update" as const,
            toolCallId: "unknown",
            name: "exec_command",
            status: "completed" as const,
        };

        expect(reports.prepare("s", update)).toEqual(update);
    });

    it("keeps only the small fields of a finished tool call and separates sessions", () => {
        const reports = new ToolCallReports();
        const start = {
            sessionUpdate: "tool_call" as const,
            toolCallId: "t",
            title: "A",
            status: "in_progress" as const,
            rawInput: {command: "ls"},
        };
        reports.prepare("s", start);
        reports.prepare("s", {sessionUpdate: "tool_call_update", toolCallId: "t", status: "completed"});

        expect(reports.prepare("s", {sessionUpdate: "tool_call_update", toolCallId: "t", title: "A"})).toBeNull();
        const input = {sessionUpdate: "tool_call_update" as const, toolCallId: "t", rawInput: {command: "ls"}};
        expect(reports.prepare("s", input)).toEqual(input);
        reports.prepare("s", start);
        const repeated = {sessionUpdate: "tool_call_update" as const, toolCallId: "t", title: "A"};
        expect(reports.prepare("other", repeated)).toEqual(repeated);
    });
});

describe("ToolCallReports turn end", () => {
    it("forgets open tool calls of the ended session only", () => {
        const reports = new ToolCallReports();
        const start = (sessionId: string) => reports.prepare(sessionId, {
            sessionUpdate: "tool_call",
            toolCallId: "tool-1",
            title: "Run",
            status: "in_progress",
        });
        const repeat = (sessionId: string) => reports.prepare(sessionId, {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool-1",
            title: "Run",
        });
        start("ended");
        start("other");

        reports.releaseOpen("ended");

        expect(repeat("ended")).toEqual({sessionUpdate: "tool_call_update", toolCallId: "tool-1", title: "Run"});
        expect(repeat("other")).toBeNull();
    });
});

describe("ToolCallReports late output", () => {
    it("drops output chunks that arrive after the tool call finished", () => {
        const reports = new ToolCallReports();
        reports.prepare("s", {sessionUpdate: "tool_call", toolCallId: "cmd-1", title: "ls", status: "in_progress"});
        reports.prepare("s", {sessionUpdate: "tool_call_update", toolCallId: "cmd-1", status: "completed"});

        expect(reports.prepare("s", {
            sessionUpdate: "tool_call_update",
            toolCallId: "cmd-1",
            _meta: {terminal_output_delta: {data: "late\n", terminal_id: "cmd-1"}},
        })).toBeNull();
        expect(reports.prepare("s", {
            sessionUpdate: "tool_call_update",
            toolCallId: "cmd-1",
            _meta: {mcp_output_delta: {data: "late"}},
        })).toBeNull();
    });

    it("keeps the output of a completion report after a start with the final status, without the status", () => {
        const reports = new ToolCallReports();
        reports.prepare("s", {sessionUpdate: "tool_call", toolCallId: "cmd-1", title: "ls", status: "completed"});
        const output = {terminal_output_delta: {data: "a.txt\n", terminal_id: "cmd-1"}};

        expect(reports.prepare("s", {
            sessionUpdate: "tool_call_update",
            toolCallId: "cmd-1",
            status: "completed",
            _meta: output,
        })).toEqual({sessionUpdate: "tool_call_update", toolCallId: "cmd-1", _meta: output});
    });

    it("accepts output again when the tool call id starts a new tool call", () => {
        const reports = new ToolCallReports();
        reports.prepare("s", {sessionUpdate: "tool_call", toolCallId: "cmd-1", title: "ls", status: "completed"});
        reports.prepare("s", {sessionUpdate: "tool_call", toolCallId: "cmd-1", title: "ls", status: "in_progress"});
        const chunk = {
            sessionUpdate: "tool_call_update" as const,
            toolCallId: "cmd-1",
            _meta: {terminal_output_delta: {data: "new\n", terminal_id: "cmd-1"}},
        };

        expect(reports.prepare("s", chunk)).toEqual(chunk);
    });
});

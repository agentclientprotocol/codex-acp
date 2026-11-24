import {describe, expect, it} from "vitest";
import {attributeMcpRequest, type McpAttributionSessions} from "../mcp/McpRequestAttribution";
import {ToolCallReports} from "../ToolCallReports";

const WAIT_MS = 20;
const report = {sessionUpdate: "tool_call", toolCallId: "call", title: "mcp.tools.echo", status: "in_progress"} as const;

/** One open root session `root`. `childSessionId` is the session of every subagent thread. */
function sessions(reports: ToolCallReports, childSessionId: string | null = "child-session"): McpAttributionSessions & {open: boolean} {
    return {
        open: true,
        isOpenRootSession(sessionId) { return this.open && sessionId === "root"; },
        subagentSessionId: () => childSessionId,
        toolCallSent: (sessionId, toolCallId, signal) => reports.whenSent(sessionId, toolCallId, signal),
    };
}

function attribute(meta: Record<string, unknown> | undefined, known: McpAttributionSessions, signal = new AbortController().signal) {
    return attributeMcpRequest({name: "echo", ...(meta ? {_meta: meta} : {})}, known, signal, WAIT_MS);
}

describe("attributeMcpRequest", () => {
    const rootCall = {sessionId: "root", threadId: "root", callId: "call"};
    const childCall = {sessionId: "root", threadId: "child", callId: "call"};

    it.each([
        ["a root tool call", rootCall, "root", {sessionId: "root", toolCallId: "call"}],
        ["a subagent tool call", childCall, "child-session", {sessionId: "child-session", toolCallId: "call"}],
        ["a root tool call reported on another session", rootCall, "child-session", {sessionId: "root"}],
        ["a subagent tool call reported on the root session", childCall, "root", undefined],
        ["a root call without a tool call, as the app-server API makes it", {threadId: "root"}, "root", {sessionId: "root"}],
        ["a request without Codex IDs, such as tools/list", {progressToken: 0}, "root", undefined],
        ["a request without _meta", undefined, "root", undefined],
        ["a thread of a session that is not on this connection", {...rootCall, sessionId: "elsewhere"}, "root", undefined],
    ])("names the session and the reported tool call of %s", async (_name, meta, reportedOn, expected) => {
        const reports = new ToolCallReports();
        reports.sent(reportedOn, report);
        await expect(attribute(meta, sessions(reports))).resolves.toEqual(expected);
    });

    it("names the root session at once for a subagent that has no session of its own", async () => {
        const known = sessions(new ToolCallReports(), null);
        known.toolCallSent = () => { throw new Error("must not wait for a report"); };
        await expect(attribute(childCall, known)).resolves.toEqual({sessionId: "root"});
    });

    it("waits for a report that is sent after the request arrived", async () => {
        const reports = new ToolCallReports();
        const attribution = attribute(childCall, sessions(reports));
        reports.sent("child-session", report);
        await expect(attribution).resolves.toEqual({sessionId: "child-session", toolCallId: "call"});
    });

    it("stops waiting when the request is abandoned", async () => {
        const abandoned = new AbortController();
        const attribution = attributeMcpRequest({_meta: rootCall}, sessions(new ToolCallReports()), abandoned.signal, 60_000);
        abandoned.abort();
        await expect(attribution).resolves.toEqual({sessionId: "root"});
    });

    it("names nothing when the root session closes during the wait", async () => {
        const reports = new ToolCallReports();
        const known = sessions(reports);
        const attribution = attribute(rootCall, known);
        known.open = false;
        reports.sent("root", report);
        await expect(attribution).resolves.toBeUndefined();
    });
});

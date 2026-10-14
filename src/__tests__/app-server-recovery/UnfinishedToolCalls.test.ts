import {describe, expect, it} from "vitest";
import {ToolCallReports} from "../../ToolCallReports";

describe("ToolCallReports.unfinished", () => {
    it("names the running tool calls, also after a cancelled permission request forgot their fields", () => {
        const reports = new ToolCallReports();
        reports.prepare("s", {sessionUpdate: "tool_call", toolCallId: "a", title: "a", status: "in_progress"});
        reports.prepare("s", {sessionUpdate: "tool_call", toolCallId: "b", title: "b", status: "pending"});
        reports.prepare("s", {sessionUpdate: "tool_call_update", toolCallId: "b", status: "completed"});
        reports.forgetOpen("s", "a");

        expect(reports.unfinished("s")).toEqual(["a"]);
        expect(reports.unfinished("other")).toEqual([]);
    });

    it("forgets them when the turn of the session ends", () => {
        const reports = new ToolCallReports();
        reports.prepare("s", {sessionUpdate: "tool_call", toolCallId: "a", title: "a", status: "in_progress"});
        reports.releaseOpen("s");
        expect(reports.unfinished("s")).toEqual([]);
    });

    it("does not start tracking on an update without a status", () => {
        const reports = new ToolCallReports();
        reports.prepare("s", {sessionUpdate: "tool_call_update", toolCallId: "late", content: []});
        expect(reports.unfinished("s")).toEqual([]);
    });
});

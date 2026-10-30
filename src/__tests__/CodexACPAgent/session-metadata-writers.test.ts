import * as acp from "@agentclientprotocol/sdk/unstable";
import {describe, expect, it, vi} from "vitest";
import {ACPSessionConnection, AcpV2Connection} from "../../ACPSessionConnection";
import {publishAirSessionMetadata} from "../../AirExtension";
import {CodexEventHandler} from "../../CodexEventHandler";
import {SESSION_ARCHIVE_METHOD} from "../../SessionIndex";
import {connectSession, createThread, sessionId, type PromptSession} from "./v2-prompt-harness";

const airCapabilities = {_meta: {jetbrains: {air: {
    version: 1, capabilities: ["sessionFailure", "agentFileChangeReport", "sessionIndex"],
}}}};
const goal = {threadId: sessionId, objective: "Current goal", status: "active" as const,
    tokenBudget: null, tokensUsed: 1, timeUsedSeconds: 1, createdAt: 100, updatedAt: 101};

function metadata(h: PromptSession): Record<string, any> {
    let current: Record<string, unknown> = {};
    for (const {sessionId: id, update} of h.scopedUpdates) {
        if (id !== sessionId || update.sessionUpdate !== "session_info_update") continue;
        if (update._meta === null) current = {};
        else if (update._meta && typeof update._meta === "object") {
            for (const [key, value] of Object.entries(update._meta)) {
                if (value === null) delete current[key];
                else current[key] = value;
            }
        }
    }
    return current;
}

async function flush(h: PromptSession) {
    await h.waitForNotifications();
    await h.request("session/list", {});
}

describe.each([1, 2] as const)("ACP v%s owned session metadata", version => {
    it("composes goals, reports, failures and archive without changing v1 payloads", async () => {
        const h = await connectSession(version, {clientCapabilities: airCapabilities, v1ClientCapabilities: airCapabilities});
        try {
            // @ts-expect-error - seed unrelated metadata through the shared client path
            const outbound = h.agent.connection as acp.AgentContext;
            await outbound.notify(acp.methods.client.session.update, {sessionId, update: {
                sessionUpdate: "session_info_update",
                _meta: {unrelated: true, jetbrains: {other: {literal: null}, air: {version: 1, sibling: true}}},
            }});
            h.emit({method: "thread/goal/updated", params: {threadId: sessionId, turnId: null, goal}});
            await flush(h);
            if (version === 2) {
                expect(metadata(h)["jetbrains"]).toMatchObject({other: {literal: null}, air: {sibling: true, goal: {objective: goal.objective}}});
            } else {
                expect(metadata(h)["jetbrains"].air.sibling).toBeUndefined();
            }
            const publishedGoal = metadata(h)["jetbrains"].air.goal;
            await h.request("session/prompt", {sessionId, prompt: [{type: "text", text: "/plan"}],
                _meta: {jetbrains: {air: {agentFileChangeReportRequest: {version: 1, requestId: "report"}}}},
            });
            await h.promptRunFinished();
            await flush(h);
            const report = metadata(h)["jetbrains"].air.agentFileChangeReport;
            expect(report).toMatchObject({requestId: "report"});
            if (version === 2) expect(metadata(h)["jetbrains"].air.goal).toEqual(publishedGoal);
            else expect(metadata(h)["jetbrains"].air.goal).toBeUndefined();

            h.emit({method: "error", params: {threadId: sessionId, turnId: "background-turn", willRetry: true,
                error: {message: "Retrying", codexErrorInfo: null, additionalDetails: null, misalignment: null}}});
            await flush(h);
            expect(metadata(h)["jetbrains"].air.sessionFailure).toMatchObject({severity: "warning"});
            if (version === 2) expect(metadata(h)["jetbrains"].air.agentFileChangeReport).toEqual(report);
            else expect(metadata(h)["jetbrains"].air.agentFileChangeReport).toBeUndefined();
            const failure = metadata(h)["jetbrains"].air.sessionFailure;

            h.emit({method: "thread/goal/cleared", params: {threadId: sessionId}});
            await flush(h);
            expect(metadata(h)["jetbrains"].air.goal).toBeNull();
            if (version === 2) expect(metadata(h)["jetbrains"].air.sessionFailure).toEqual(failure);
            else expect(metadata(h)["jetbrains"].air.sessionFailure).toBeUndefined();

            h.setCodexResponse("thread/read", async () => ({thread: {...createThread(), path: "/codex/sessions/rollout.jsonl"}}));
            await h.request(SESSION_ARCHIVE_METHOD, {sessionId});
            const final = metadata(h);
            expect(final["jetbrains"].air.archived).toBe(true);
            if (version === 2) {
                expect(final["jetbrains"]).toMatchObject({other: {literal: null}, air: {sibling: true, goal: null}});
                expect(final["jetbrains"].air.agentFileChangeReport).toEqual(report);
                expect(final["jetbrains"].air.sessionFailure).toEqual(failure);
            } else {
                expect(final["jetbrains"]).toEqual({air: {version: 1, archived: true}});
            }
            expect(final["unrelated"]).toBe(true);
            const boundary = h.scopedUpdates.length;
            await publishAirSessionMetadata(new ACPSessionConnection(outbound, sessionId), "late", true);
            await flush(h);
            expect(h.scopedUpdates).toHaveLength(boundary);
        } finally { h.connection.close(); }
    });

    it("preserves independent Codex fields across status and archive events on v2", async () => {
        const h = await connectSession(version);
        try {
            h.emit({method: "thread/archived", params: {threadId: sessionId}});
            h.emit({method: "thread/status/changed", params: {threadId: sessionId, status: {type: "idle"}}});
            await flush(h);
            expect(metadata(h)["codex"]).toEqual(version === 2
                ? {archived: true, threadStatus: {type: "idle"}} : {threadStatus: {type: "idle"}});
            h.emit({method: "thread/unarchived", params: {threadId: sessionId}});
            await flush(h);
            expect(metadata(h)["codex"]).toEqual(version === 2
                ? {archived: false, threadStatus: {type: "idle"}} : {archived: false});
        } finally { h.connection.close(); }
    });
});

describe("V2 namespace transactions", () => {
    it("composes concurrent AIR writers at publication time", async () => {
        const h = await connectSession(2);
        try {
            // @ts-expect-error - exercise the writer on the actual shared client connection
            const session = new ACPSessionConnection(h.agent.connection, sessionId);
            await Promise.all([
                publishAirSessionMetadata(session, "first", {literal: null}),
                publishAirSessionMetadata(session, "second", true),
            ]);
            await flush(h);
            expect(metadata(h)["jetbrains"]).toEqual({air: {version: 1, first: {literal: null}, second: true}});
        } finally { h.connection.close(); }
    });

    it("composes after routing without copying parent metadata into a child", async () => {
        const h = await connectSession(2);
        try {
            // @ts-expect-error - seed both metadata scopes through the shared connection
            const outbound = h.agent.connection as acp.AgentContext;
            const v2 = AcpV2Connection.of(outbound)!;
            await v2.client.notify("session/update", {sessionId, update: {sessionUpdate: "session_info_update", _meta: {codex: {parent: true}}}});
            await v2.client.notify("session/update", {sessionId: "child", update: {sessionUpdate: "session_info_update", _meta: {codex: {child: true}}}});
            const state = h.agent.getSessionState(sessionId);
            vi.spyOn(state.subagents, "notificationSessionId").mockReturnValue("child");
            const handler = new CodexEventHandler(outbound, state, false, "epoch", state.subagents, undefined, false, false, false);
            await handler.handleNotification({method: "thread/status/changed", params: {threadId: sessionId, status: {type: "idle"}}});
            await flush(h);
            const child = h.scopedUpdates.filter(entry => entry.sessionId === "child").at(-1)?.update;
            expect(child?._meta).toEqual({codex: {child: true, threadStatus: {type: "idle"}}});
            expect(metadata(h)["codex"]).toEqual({parent: true});
        } finally { h.connection.close(); }
    });
});

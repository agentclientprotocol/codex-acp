import * as acp from "@agentclientprotocol/sdk/unstable";
import {describe, expect, it, vi} from "vitest";
import {AcpV2Connection} from "../../ACPSessionConnection";
import {AIR_NATIVE_SUBAGENT_SESSIONS_KEY, withAirMeta} from "../../AirExtension";
import {connectSession, cwd, itemCompleted, itemStarted, sessionId, turnStarted, userMessageItem} from "./v2-prompt-harness";

describe("Post-close session delivery", () => {
    it("sends final idle before close but permits an inserted prompt response after it", async () => {
        const h = await connectSession();
        let release!: () => void;
        const responseGate = new Promise<void>(resolve => { release = resolve; });
        const promptV2 = h.agent.promptV2.bind(h.agent);
        vi.spyOn(h.agent, "promptV2").mockImplementationOnce(async (...args) => {
            const response = await promptV2(...args);
            await responseGate;
            return response;
        });
        const start = h.wireMessages.length;
        const prompt = h.sendPrompt([{type: "text", text: "Run"}]);
        try {
            await vi.waitFor(() => expect(h.turnStartParams).toHaveLength(1));
            h.emit(turnStarted());
            h.emit(itemCompleted(userMessageItem(h.turnStartParams[0]!["clientUserMessageId"] as string)));
            await vi.waitFor(() => expect(h.transcript.some(entry =>
                "sessionUpdate" in entry && entry.sessionUpdate.sessionUpdate === "user_message_chunk")).toBe(true));
            await h.request("session/close", {sessionId});
            release();
            const accepted = await prompt;
            const frames = h.wireMessages.slice(start);
            const closeIndex = frames.findIndex(frame => "result" in frame && !(frame.result as {messageId?: unknown}).messageId);
            const promptIndex = frames.findIndex(frame => "result" in frame
                && (frame.result as {messageId?: unknown}).messageId === accepted.messageId);
            const idleIndex = frames.findIndex(frame => "method" in frame && frame.method === "session/update"
                && (frame.params as {update: {state?: string}}).update.state === "idle");
            expect(idleIndex).toBeGreaterThanOrEqual(0);
            expect(closeIndex).toBeGreaterThan(idleIndex);
            expect(promptIndex).toBeGreaterThan(closeIndex);
            expect(frames.slice(closeIndex + 1).filter(frame => "method" in frame && frame.method === "session/update")).toEqual([]);
        } finally { release(); await prompt.catch(() => {}); h.connection.close(); }
    });

    it.each([
        {version: 1, air: false, method: "session/close"},
        {version: 2, air: false, method: "session/close"},
        {version: 1, air: true, method: "session/close"},
        {version: 2, air: true, method: "session/close"},
        {version: 1, air: false, method: "session/delete"},
        {version: 2, air: false, method: "session/delete"},
    ] as const)("fences root and child output on v$version after $method (AIR: $air)", async ({version, air, method}) => {
        const meta = air ? withAirMeta(undefined, "capabilities", [AIR_NATIVE_SUBAGENT_SESSIONS_KEY]) : {};
        const h = await connectSession(version, {
            clientCapabilities: {elicitation: {url: {}}, _meta: meta},
            v1ClientCapabilities: {subagents: {}, elicitation: {url: {}}, _meta: meta},
            onElicitation: async () => ({action: "accept"}),
        });
        const announce = () => h.emit(itemStarted({type: "subAgentActivity", id: "activity", model: null, reasoningEffort: null,
            agentThreadId: "child", agentPath: "/root/child", kind: "started"}));
        const childId = air ? "child" : `${sessionId}:subagent:child`;
        // @ts-expect-error - exercise stale producers through the real shared and native-v2 send paths
        const outbound = h.agent.connection as acp.AgentContext;
        const v2 = AcpV2Connection.of(outbound);
        try {
            announce();
            await h.waitForNotifications();
            await h.request("session/list", {});
            await outbound.request(acp.methods.client.elicitation.create, {
                sessionId, mode: "url", message: "Sign in", url: "https://example.com/login", elicitationId: "old",
            });
            await h.request(method, {sessionId});
            const start = h.wireMessages.length;
            for (const id of [sessionId, childId]) {
                await outbound.notify(acp.methods.client.session.update, {sessionId: id,
                    update: {sessionUpdate: "agent_message_chunk", messageId: "late", content: {type: "text", text: "Late"}}});
                await expect(outbound.request(acp.methods.client.session.requestPermission, {
                    sessionId: id, toolCall: {toolCallId: "late"}, options: [],
                })).rejects.toMatchObject({code: -32800});
                if (v2) {
                    await v2.updateState(id, {state: "running"});
                    await v2.replaySessionUpdate(id, {sessionUpdate: "agent_message_chunk", messageId: "late-replay",
                        content: {type: "text", text: "Late replay"}}, new Set());
                    await v2.client.notify("session/update", {sessionId: id, update: {sessionUpdate: "state_update", state: "idle"}});
                    await expect(v2.createElicitation({sessionId: id, mode: "url",
                        message: "Late", url: "https://example.com/late", elicitationId: `late-${id}`})).rejects.toMatchObject({code: -32800});
                }
            }
            await outbound.notify(acp.methods.client.elicitation.complete, {elicitationId: "old"});
            if (v2) {
                await v2.completeElicitation({elicitationId: "old"});
                await v2.client.notify("elicitation/complete", {elicitationId: "old"});
            }
            await h.request("session/list", {});
            expect(h.wireMessages.slice(start).filter(frame => "method" in frame
                && ["session/update", "session/request_permission", "elicitation/create", "elicitation/complete"].includes(frame.method))).toEqual([]);
            if (method === "session/delete") return;

            const resumed = h.wireMessages.length;
            await h.request("session/resume", {sessionId, cwd, mcpServers: []});
            if (v2) {
                const states = h.wireMessages.slice(resumed).flatMap(frame =>
                    "method" in frame && frame.method === "session/update"
                        ? [(frame.params as {update: {sessionUpdate: string; state?: string}}).update] : [])
                    .filter(update => update.sessionUpdate === "state_update");
                expect(states).toEqual([{sessionUpdate: "state_update", state: "idle"}]);
            }
            announce();
            await h.waitForNotifications();
            await h.request("session/list", {});
            const reopened = h.wireMessages.length;
            for (const id of [sessionId, childId]) {
                await outbound.notify(acp.methods.client.session.update, {sessionId: id,
                    update: {sessionUpdate: "agent_message_chunk", messageId: "current", content: {type: "text", text: "Current"}}});
            }
            await outbound.notify(acp.methods.client.elicitation.complete, {elicitationId: "old"});
            await h.request("session/list", {});
            const notifications = h.wireMessages.slice(reopened).filter(frame => "method" in frame
                && (frame.method === "session/update" || frame.method === "elicitation/complete"));
            expect(notifications).toHaveLength(2);
            const current: acp.CreateElicitationRequest = {
                sessionId, mode: "url", message: "Current", url: "https://example.com/current", elicitationId: "current",
            };
            if (v2) await v2.createElicitation(current);
            else await outbound.request(acp.methods.client.elicitation.create, current);
            const completionStart = h.wireMessages.length;
            if (v2) await v2.completeElicitation({elicitationId: "current"});
            else await outbound.notify(acp.methods.client.elicitation.complete, {elicitationId: "current"});
            await outbound.notify(acp.methods.client.elicitation.complete, {elicitationId: "current"});
            await h.request("session/list", {});
            expect(h.wireMessages.slice(completionStart).filter(frame =>
                "method" in frame && frame.method === "elicitation/complete")).toHaveLength(1);
        } finally { h.connection.close(); }
    });
});

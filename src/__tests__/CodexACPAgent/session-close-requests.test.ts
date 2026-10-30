import * as acp from "@agentclientprotocol/sdk/unstable";
import {describe, expect, it, vi} from "vitest";
import {connectSession, itemStarted, sessionId} from "./v2-prompt-harness";

describe.each([1, 2] as const)("ACP v%s session interaction teardown", version => {
    it.each(["session/close", "session/delete"])("withdraws idle session elicitations before %s responds", async method => {
        const aborted: boolean[] = [];
        const h = await connectSession(version, {
            clientCapabilities: {elicitation: {form: {}, url: {}}},
            v1ClientCapabilities: {subagents: {}, elicitation: {form: {}, url: {}}},
            onElicitation: async (_request, signal) => {
                const index = aborted.push(false) - 1;
                return await new Promise(resolve => {
                    signal.addEventListener("abort", () => {
                        aborted[index] = true;
                        resolve({action: "cancel"});
                    }, {once: true});
                });
            },
        });
        try {
            h.emit(itemStarted({type: "subAgentActivity", model: null, reasoningEffort: null, id: "activity",
                agentThreadId: "child-thread", agentPath: "/root/child", kind: "started"}));
            await h.waitForNotifications();
            const childSessionId = `${sessionId}:subagent:child-thread`;
            // An idle/background caller has no prompt cancellation signal.
            // @ts-expect-error - exercise the shared outbound path without starting foreground work
            const connection = h.agent.connection as acp.AgentContext;
            const requests = [
                {sessionId, mode: "form", message: "Background question", requestedSchema: {type: "object", properties: {}}},
                {sessionId, mode: "url", message: "Background login", url: "https://example.com/login", elicitationId: "login"},
                {sessionId: childSessionId, mode: "form", message: "Child question", requestedSchema: {type: "object", properties: {}}},
            ] as const;
            const pending = requests.map(params => connection.request(acp.methods.client.elicitation.create, params).catch(() => null));
            await vi.waitFor(() => expect(aborted).toEqual([false, false, false]));
            const frameStart = h.wireMessages.length;
            await h.request(method, {sessionId});
            await vi.waitFor(() => expect(aborted).toEqual([true, true, true]));
            await Promise.all(pending);
            const frames = h.wireMessages.slice(frameStart);
            const responseIndex = frames.findIndex(frame => "result" in frame);
            const cancels = frames.flatMap((frame, index) =>
                "method" in frame && frame.method === "$/cancel_request" ? [index] : []);
            expect(cancels).toHaveLength(3);
            expect(cancels.every(index => index < responseIndex)).toBe(true);
            expect(h.turnStartParams).toEqual([]);
        } finally { h.connection.close(); }
    });
});

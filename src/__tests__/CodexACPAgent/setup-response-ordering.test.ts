import * as acp from "@agentclientprotocol/sdk/unstable";
import {describe, expect, it, vi} from "vitest";
import {AcpV2Connection} from "../../ACPSessionConnection";
import type {CodexAcpServer} from "../../CodexAcpServer";
import {codexResponse, connectSession, createThread, cwd, itemStarted, sessionId, type PromptSession} from "./v2-prompt-harness";

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return {promise, resolve};
}

describe.each([1, 2] as const)("ACP v%s setup response ordering", version => {
    it("announces startup children only after the parent setup response", async () => {
        const reading = deferred();
        const release = deferred();
        let agent!: CodexAcpServer;
        const connecting = connectSession(version, {
            v1ClientCapabilities: {subagents: {}},
            onAgent: current => { agent = current; },
            codexResponses: {"skills/list": async () => {
                reading.resolve();
                await release.promise;
                return {data: []};
            }},
        });
        let h: PromptSession | null = null;
        try {
            await reading.promise;
            const activity = agent.getSessionState(sessionId).subagents.handle(itemStarted({
                type: "subAgentActivity", id: "activity", agentThreadId: "worker", agentPath: "/root/worker",
                kind: "started", model: null, reasoningEffort: null,
            }));
            await new Promise<void>(resolve => setImmediate(resolve));
            release.resolve();
            h = await connecting;
            await activity;
            const response = h.wireMessages.findIndex(frame => "result" in frame
                && typeof frame.result === "object" && frame.result !== null && "sessionId" in frame.result);
            const announcement = h.wireMessages.findIndex(frame => "method" in frame && frame.method === "session/update"
                && (frame.params as {update: {sessionUpdate: string}}).update.sessionUpdate === "subagent_update");
            expect(announcement).toBeGreaterThan(response);
        } finally {
            release.resolve();
            (h ?? await connecting).connection.close();
        }
    });

    it.each([undefined, 30_000])("starts MCP sign-in after the response write with startup wait %s", async timeout => {
        const writing = deferred();
        const release = deferred();
        const login = vi.fn(async () => ({authorizationUrl: "https://example.com/oauth"}));
        const elicitation = vi.fn(async () => ({action: "cancel" as const}));
        const connecting = connectSession(version, {
            clientCapabilities: {elicitation: {url: {}}},
            v1ClientCapabilities: {elicitation: {url: {}}},
            mcpServers: [{name: "docs", type: "stdio", command: "/usr/bin/docs-mcp", args: [], env: []}],
            mcpStartup: {ready: [], failed: [{
                server: "docs", error: "expired", failureReason: "reauthenticationRequired",
            }], cancelled: []},
            ...(timeout === undefined ? {} : {newSessionMeta: {mcpStartupAwaitTimeoutMs: timeout}}),
            codexResponses: {"mcpServer/oauth/login": login},
            onElicitation: elicitation,
            beforeSetupResponseWrite: async () => { writing.resolve(); await release.promise; },
        });
        let h: PromptSession | null = null;
        try {
            await writing.promise;
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(login).not.toHaveBeenCalled();
            expect(elicitation).not.toHaveBeenCalled();
            release.resolve();
            h = await connecting;
            await vi.waitFor(() => expect(elicitation).toHaveBeenCalledOnce());
            expect(login).toHaveBeenCalledOnce();
            const response = h.wireMessages.findIndex(frame => "result" in frame
                && typeof frame.result === "object" && frame.result !== null && "sessionId" in frame.result);
            const request = h.wireMessages.findIndex(frame => "method" in frame && frame.method === "elicitation/create");
            expect(response).toBeGreaterThanOrEqual(0);
            expect(request).toBeGreaterThan(response);
        } finally {
            release.resolve();
            (h ?? await connecting).connection.close();
        }
    });

    it("holds interactions for the new fork until its response is written", async () => {
        const writing = deferred();
        const release = deferred();
        let hold = false;
        const elicitation = vi.fn(async () => ({action: "cancel" as const}));
        const h = await connectSession(version, {
            clientCapabilities: {elicitation: {form: {}}},
            v1ClientCapabilities: {elicitation: {form: {}}},
            onElicitation: elicitation,
            beforeSetupResponseWrite: async () => {
                if (hold) { writing.resolve(); await release.promise; }
            },
        });
        try {
            const forkId = "forked-thread";
            h.setCodexResponse("thread/fork", async () => ({
                ...codexResponse("thread/start") as object, thread: {...createThread(), id: forkId},
            }));
            hold = true;
            const forked = h.request("session/fork", {sessionId, cwd, mcpServers: []});
            await writing.promise;
            // @ts-expect-error - exercise startup work through the server's client delivery
            const connection = h.agent.connection as acp.AgentContext;
            const params = {sessionId: forkId, mode: "form" as const, message: "Startup question",
                requestedSchema: {type: "object" as const, properties: {}}};
            const pending = version === 2
                ? AcpV2Connection.of(connection)!.client.request("elicitation/create", params)
                : connection.request(acp.methods.client.elicitation.create, params);
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(elicitation).not.toHaveBeenCalled();
            release.resolve();
            await forked;
            await pending;
            expect(elicitation).toHaveBeenCalledOnce();
        } finally {
            release.resolve();
            h.connection.close();
        }
    });
});

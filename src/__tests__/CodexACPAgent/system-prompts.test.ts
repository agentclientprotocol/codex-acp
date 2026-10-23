import {afterEach, describe, expect, it, vi} from "vitest";
import {
    codexResponse, connectSession, createThread, createTurn, cwd, sessionId, settle,
    type PromptSession,
    createReplacementCodexAcpClient,
} from "./v2-prompt-harness";
import type {Thread} from "../../app-server/v2";
import {stubGatewayModelListing} from "../acp-test-utils";

stubGatewayModelListing(["gpt-5"]);

const prompt = (text: string) => ({mode: "append", content: [{type: "text", text}]});
const air = {_meta: {jetbrains: {air: {customInstructions: "AIR instructions"}}}};

describe.each([1, 2] as const)("client system prompts over ACP v%s", (version) => {
    let client: PromptSession;
    afterEach(() => client?.connection.close());

    async function connect() {
        const calls: Array<{method: string; params: any}> = [];
        let thread: Thread = {...createThread(), path: "/workspace/rollout.jsonl"};
        let reportUnload = true;
        const methods = ["thread/start", "thread/resume", "thread/fork", "thread/read", "thread/unsubscribe"];
        client = await connectSession(version, {
            codexResponses: {
                "config/read": async () => ({config: {developer_instructions: "Configured instructions"}, origins: {}, layers: []}),
                "thread/backgroundTerminals/list": async () => ({data: [], nextCursor: null}),
                ...Object.fromEntries(methods.map(method => [method, async (params: any) => {
                    calls.push({method, params});
                    if (method === "thread/read") return {thread};
                    if (method === "thread/fork") {
                        return {...codexResponse("thread/start") as object, thread: {...thread, id: "fork-1"}};
                    }
                    if (method === "thread/resume" && reportUnload
                        && calls.at(-2)?.method === "thread/unsubscribe") {
                        client.emit({
                            method: "thread/status/changed",
                            params: {threadId: sessionId, status: {type: "notLoaded"}},
                        });
                    }
                    return codexResponse(method);
                }])),
            },
        });
        calls.length = 0;
        return {
            calls,
            setThread: (value: Thread) => { thread = value; },
            ignoreOverrides: () => { reportUnload = false; },
        };
    }

    it.each([false, true])("appends to the existing baseline (AIR: %s)", async (isAir) => {
        const {calls} = await connect();
        await client.request("session/new", {
            cwd, mcpServers: [], systemPrompt: {mode: "append", content: [
                {type: "text", text: "First instruction"}, {type: "text", text: "Second instruction"},
            ]},
            ...(isAir ? air : {}),
        });
        await expect(JSON.stringify(calls.map(({method, params}) => ({
            method, developerInstructions: params.developerInstructions,
        })), null, 2) + "\n").toMatchFileSnapshot(`data/system-prompt-v${version}-${isAir ? "air" : "configured"}.json`);
    });

    it("preserves the legacy AIR-only path", async () => {
        const {calls} = await connect();
        await client.request("session/new", {cwd, mcpServers: [], ...air});
        expect(calls[0]).toMatchObject({method: "thread/start", params: {developerInstructions: "AIR instructions"}});
    });

    it("reloads changed instructions without appending the previous client prompt", async () => {
        const {calls} = await connect();
        await client.request("session/new", {cwd, mcpServers: [], systemPrompt: prompt("Old"), ...air});
        calls.length = 0;
        await client.request("session/resume", {sessionId, cwd, mcpServers: [], systemPrompt: prompt("New")});
        expect(calls.map(call => call.method)).toEqual(["thread/read", "thread/unsubscribe", "thread/resume"]);
        expect(calls.at(-1)?.params.developerInstructions).toBe("AIR instructions\n\nNew");
        expect(client.agent.getSessionState(sessionId).instructions?.text).toBe("New");
        expect(client.turnInterruptCalls()).toEqual([]);
    });

    it("keeps known instructions on omitted, null, and identical prompts without detaching", async () => {
        const {calls} = await connect();
        await client.request("session/new", {cwd, mcpServers: [], systemPrompt: prompt("Keep")});
        calls.length = 0;
        for (const systemPrompt of [undefined, null, prompt("Keep")]) {
            await client.request("session/resume", {sessionId, cwd, mcpServers: [], ...(systemPrompt === undefined ? {} : {systemPrompt})});
        }
        expect(calls.map(call => call.method)).toEqual(["thread/resume", "thread/resume", "thread/resume"]);
        expect(calls.map(call => call.params.developerInstructions)).toEqual(Array(3).fill("Configured instructions\n\nKeep"));
    });

    it("applies instructions on the history replay path", async () => {
        const {calls} = await connect();
        await client.request(version === 1 ? "session/load" : "session/resume", {
            sessionId, cwd, mcpServers: [], systemPrompt: prompt("Replay"),
            ...(version === 2 ? {replayFrom: {type: "start"}} : {}),
        });
        expect(calls.find(call => call.method === "thread/resume")?.params.developerInstructions)
            .toBe("Configured instructions\n\nReplay");
        expect(client.agent.getSessionState(sessionId).instructions?.text).toBe("Replay");
    });

    it("passes instructions to a fork without changing the source", async () => {
        const {calls} = await connect();
        await client.request("session/new", {cwd, mcpServers: [], systemPrompt: prompt("Source"), ...air});
        calls.length = 0;
        await client.request("session/fork", {sessionId, cwd, mcpServers: [], systemPrompt: prompt("Fork")});
        expect(calls.map(call => call.method)).toEqual(["thread/fork"]);
        expect(calls[0]?.params.developerInstructions).toBe("AIR instructions\n\nFork");
        expect(client.agent.getSessionState(sessionId).instructions?.text).toBe("Source");
        expect(client.agent.getSessionState("fork-1").instructions?.text).toBe("Fork");
    });

    it.each([
        {mode: "override", content: [{type: "text", text: "x"}]},
        {mode: "_custom", content: [{type: "text", text: "x"}]},
        {mode: "append", content: [{type: "image", data: "", mimeType: "image/png"}]},
    ])("rejects unsupported system prompts before any lifecycle operation", async (systemPrompt) => {
        const {calls} = await connect();
        for (const method of ["session/new", "session/resume", "session/fork", ...(version === 1 ? ["session/load"] : [])]) {
            await expect(client.request(method, {sessionId, cwd, mcpServers: [], systemPrompt})).rejects.toMatchObject({code: -32602});
        }
        expect(calls).toEqual([]);
    });

    it("rejects a changed prompt while work is running without cancelling it", async () => {
        const {calls} = await connect();
        client.emit({method: "turn/started", params: {threadId: sessionId, turn: createTurn("inProgress")}} as any);
        await settle();
        await expect(client.request("session/resume", {sessionId, cwd, mcpServers: [], systemPrompt: prompt("Busy")}))
            .rejects.toMatchObject({code: -32602});
        expect(calls).toEqual([]);
        expect(client.turnInterruptCalls()).toEqual([]);
    });

    it("rejects changes to an unmaterialized session without detaching it", async () => {
        const {calls, setThread} = await connect();
        setThread(createThread());
        await expect(client.request("session/resume", {sessionId, cwd, mcpServers: [], systemPrompt: prompt("Unused")}))
            .rejects.toMatchObject({code: -32602});
        expect(calls.map(call => call.method)).toEqual(["thread/read"]);
        expect(client.agent.getSessionState(sessionId).instructions).toBeUndefined();
        client.emit({method: "turn/started", params: {threadId: sessionId, turn: createTurn("inProgress")}} as any);
        await settle();
        expect(client.agent.getSessionState(sessionId).codexReportedRunningTurnId).toBe("turn-1");
    });

    it("does not acknowledge an override the runtime ignored", async () => {
        const {calls, ignoreOverrides} = await connect();
        ignoreOverrides();
        await expect(client.request("session/resume", {sessionId, cwd, mcpServers: [], systemPrompt: prompt("Ignored")}))
            .rejects.toMatchObject({code: -32602});
        expect(calls.map(call => call.method)).toEqual(["thread/read", "thread/unsubscribe", "thread/resume"]);
        expect(client.agent.getSessionState(sessionId).instructions).toBeUndefined();
    });

    it("clears the client addition with empty content without clearing AIR instructions", async () => {
        const {calls} = await connect();
        await client.request("session/new", {cwd, mcpServers: [], systemPrompt: prompt("Old"), ...air});
        calls.length = 0;
        await client.request("session/resume", {sessionId, cwd, mcpServers: [], systemPrompt: {mode: "append", content: []}});
        expect(calls.at(-1)?.params.developerInstructions).toBe("AIR instructions");
        expect(client.agent.getSessionState(sessionId).instructions?.text).toBe("");
    });

    it("checks materialization rather than trusting a planned rollout path", async () => {
        const {calls} = await connect();
        client.setCodexResponse("thread/turns/list", async () => { throw new Error("thread is not materialized yet"); });
        await expect(client.request("session/resume", {sessionId, cwd, mcpServers: [], systemPrompt: prompt("Unused")}))
            .rejects.toMatchObject({code: -32602});
        expect(calls.map(call => call.method)).toEqual(["thread/read"]);
    });

    it("does not stop background terminals to reload instructions", async () => {
        const {calls} = await connect();
        client.setCodexResponse("thread/backgroundTerminals/list", async () => ({
            data: [{itemId: "background-1", processId: "42", command: "sleep 60"}], nextCursor: null,
        }));
        await expect(client.request("session/resume", {sessionId, cwd, mcpServers: [], systemPrompt: prompt("Background")}))
            .rejects.toMatchObject({code: -32602});
        expect(calls.map(call => call.method)).toEqual(["thread/read"]);
        expect(client.turnInterruptCalls()).toEqual([]);
    });

    it("blocks racing prompts, config changes, and resumes until the update finishes", async () => {
        await connect();
        let resolveConfig!: (config: unknown) => void;
        const config = new Promise(resolve => { resolveConfig = resolve; });
        const readConfig = vi.fn(async () => config);
        client.setCodexResponse("config/read", readConfig);
        const pending = client.request("session/resume", {sessionId, cwd, mcpServers: [], systemPrompt: prompt("Changed")});
        void pending.catch(() => {});
        await vi.waitFor(() => expect(readConfig).toHaveBeenCalled());
        await expect(client.sendPrompt([{type: "text", text: "Race"}])).rejects.toMatchObject({code: -32600});
        await expect(client.request("session/set_config_option", {
            sessionId, configId: "mode", value: "agent", ...(version === 2 ? {type: "id"} : {}),
        }))
            .rejects.toMatchObject({code: -32600});
        await expect(client.request("session/resume", {sessionId, cwd, mcpServers: []})).rejects.toMatchObject({code: -32600});
        resolveConfig({config: {}, origins: {}, layers: []});
        await pending;
        expect(client.agent.getSessionState(sessionId).instructions?.text).toBe("Changed");
    });

    it("restores the original subscription when a detached resume fails", async () => {
        const {calls} = await connect();
        let resumed = 0;
        client.setCodexResponse("thread/resume", async params => {
            calls.push({method: "thread/resume", params});
            if (++resumed === 1) throw new Error("Resume failed");
            return codexResponse("thread/resume");
        });
        await expect(client.request("session/resume", {sessionId, cwd, mcpServers: [], systemPrompt: prompt("Failed")}))
            .rejects.toMatchObject({code: -32603});
        expect(calls.map(call => call.method)).toEqual(["thread/read", "thread/unsubscribe", "thread/resume", "thread/resume"]);
        expect(calls.at(-1)?.params).toEqual({threadId: sessionId, excludeTurns: true});
        expect(client.agent.getSessionState(sessionId).instructions).toBeUndefined();
        client.emit({method: "turn/started", params: {threadId: sessionId, turn: createTurn("inProgress")}} as any);
        await settle();
        expect(client.agent.getSessionState(sessionId).codexReportedRunningTurnId).toBe("turn-1");
    });

    it("resends known instructions after a provider restart", async () => {
        await connect();
        await client.request("session/new", {cwd, mcpServers: [], systemPrompt: prompt("Keep after restart"), ...air});
        const replacement = createReplacementCodexAcpClient();
        vi.spyOn(client.agent as any, "restartCodexClient").mockResolvedValue(replacement.codexAcpClient);
        const resume = vi.spyOn(replacement.appServer, "threadResume");
        await client.request("providers/set", {providerId: "openai", apiType: "openai", baseUrl: "https://gateway.example/v1"});
        expect(resume.mock.calls[0]?.[0].developerInstructions).toBe("AIR instructions\n\nKeep after restart");
    });
});

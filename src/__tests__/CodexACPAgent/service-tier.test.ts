import {describe, expect, it, vi} from "vitest";
import * as acp from "@agentclientprotocol/sdk/unstable";
import {createCodexMockTestFixture, createTestModel, mockPromptTurn} from "../acp-test-utils";

describe.each(["new", "resume", "load", "fork"] as const)("Service tier after session/%s", (operation) => {
    it.each(["ultrafast", "flex", "default", null])("preserves the Codex tier %s across prompts", async (serviceTier) => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        const client = fixture.getCodexAcpClient();
        const appServer = fixture.getCodexAppServerClient();
        // A model need not support Fast to honor a different tier accepted by Codex.
        const model = createTestModel({id: "gpt-6-astra", additionalSpeedTiers: ["ultrafast"]});
        const thread = {id: "tier-session", historyMode: "paginated", status: {type: "idle"}, turns: []};
        const response = {
            thread, model: model.id, modelProvider: "openai", cwd: "/workspace",
            approvalPolicy: "never", sandbox: {type: "dangerFullAccess"},
            reasoningEffort: model.defaultReasoningEffort, serviceTier,
        };
        vi.spyOn(client, "readAuthRequirement").mockResolvedValue({required: false, account: null});
        vi.spyOn(client, "getAccount").mockResolvedValue({account: null, requiresOpenaiAuth: false});
        vi.spyOn(client, "listSkills").mockResolvedValue({data: []});
        appServer.listModels = vi.fn().mockResolvedValue({data: [model], nextCursor: null});
        appServer.threadStart = vi.fn().mockImplementation(async (params: {ephemeral?: boolean | null}) => ({
            ...response,
            thread: {...thread, id: params.ephemeral ? "title-session" : thread.id},
        }));
        appServer.threadResume = vi.fn().mockResolvedValue(response);
        appServer.threadFork = vi.fn().mockResolvedValue(response);
        const turnStartSpy = mockPromptTurn(fixture, thread.id);
        await agent.initialize({protocolVersion: acp.PROTOCOL_VERSION});

        const request = {sessionId: thread.id, cwd: "/workspace", mcpServers: []};
        switch (operation) {
            case "new": await agent.newSession({cwd: request.cwd, mcpServers: request.mcpServers}); break;
            case "resume": await agent.resumeSession(request); break;
            case "load": await agent.loadSession(request); break;
            case "fork": await agent.forkSession({...request, sessionId: "source-session"}); break;
        }
        for (const text of ["first prompt", "next prompt"]) {
            await agent.prompt({sessionId: thread.id, prompt: [{type: "text", text}]});
        }

        const promptTurns = turnStartSpy.mock.calls.map(([params]) => params).filter(params => params.threadId === thread.id);
        expect(promptTurns).toHaveLength(2);
        expect(promptTurns).toEqual([
            expect.objectContaining({serviceTier}),
            expect.objectContaining({serviceTier}),
        ]);
    });
});

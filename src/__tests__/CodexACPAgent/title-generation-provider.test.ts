import {describe, expect, it, vi} from "vitest";
import type {Turn} from "../../app-server/v2";
import {ModelId} from "../../ModelId";
import {createCodexMockTestFixture, createTestModel} from "../acp-test-utils";

const sessionId = "title-session";
const turnId = "title-turn";

describe("AI session title generation", () => {
    it.each([
        ["openai", 1],
        ["fleet-gateway", 0],
    ])("for a new session on the %s provider runs %i title turn(s)", async (modelProvider, titleTurns) => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        const client = fixture.getCodexAcpClient();
        const appServer = fixture.getCodexAppServerClient();
        const model = createTestModel();
        vi.spyOn(client, "readAuthRequirement").mockResolvedValue({required: false, account: null});
        vi.spyOn(client, "getAccount").mockResolvedValue({account: {type: "apiKey"}, requiresOpenaiAuth: false});
        vi.spyOn(client, "listSkills").mockResolvedValue({data: []});
        vi.spyOn(client, "newSession").mockResolvedValue({
            sessionId,
            currentModelId: ModelId.create(model.id, model.defaultReasoningEffort).toString(),
            models: [model],
            collaborationMode: "default",
            modelProvider,
            additionalDirectories: [],
        });
        vi.spyOn(appServer, "turnStart").mockResolvedValue({turn: createTurn("inProgress")});
        vi.spyOn(appServer, "awaitTurnCompleted").mockResolvedValue({threadId: sessionId, turn: createTurn("completed")});
        const threadStart = vi.spyOn(appServer, "threadStart")
            .mockResolvedValue({thread: {id: "title-thread"}} as Awaited<ReturnType<typeof appServer.threadStart>>);
        const runTurn = vi.spyOn(appServer, "runTurn");

        await agent.newSession({cwd: "/workspace", mcpServers: []});
        await agent.prompt({sessionId, prompt: [{type: "text", text: "Fix the failing build"}]});
        await agent.getSessionState(sessionId).titleGen?.waitForIdle(1_000);

        expect(threadStart).toHaveBeenCalledTimes(titleTurns);
        const titleTurnRequests = runTurn.mock.calls.filter(([params]) => params.threadId === "title-thread");
        expect(titleTurnRequests).toHaveLength(titleTurns);
        expect(titleTurnRequests.map(([params]) => params.model)).toEqual(titleTurns === 0 ? [] : ["gpt-5.6-luna"]);
    });
});

function createTurn(status: Turn["status"]): Turn {
    return {id: turnId, items: [], itemsView: "full", status, error: null, startedAt: null, completedAt: null, durationMs: null};
}

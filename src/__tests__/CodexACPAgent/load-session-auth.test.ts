import {describe, expect, it, vi} from "vitest";
import {createCodexMockTestFixture, createTestModel, type CodexMockTestFixture} from "../acp-test-utils";
import type {GetAccountResponse} from "../../app-server/v2";

const SESSION_ID = "session-1";
const SIGNED_IN: GetAccountResponse = {
    account: {type: "chatgpt", email: "user@example.com", planType: "plus"},
    requiresOpenaiAuth: true,
} as GetAccountResponse;

/** A fixture whose `thread/resume` answers a session with one history message. */
function loadFixture(): CodexMockTestFixture {
    const fixture = createCodexMockTestFixture();
    const client = fixture.getCodexAcpClient();
    const appServer = fixture.getCodexAppServerClient();
    client.listSkills = vi.fn().mockResolvedValue({data: []});
    const model = createTestModel();
    appServer.listModels = vi.fn().mockResolvedValue({data: [model], nextCursor: null});
    appServer.threadResume = vi.fn().mockResolvedValue({
        thread: {id: SESSION_ID, historyMode: "paginated", turns: [], cwd: "/test/project", name: null, preview: ""},
        itemsBackwardsCursor: "item:last",
        model: model.id,
        modelProvider: "openai",
        cwd: "/test/project",
        approvalPolicy: "never",
        sandbox: {type: "dangerFullAccess"},
        reasoningEffort: model.defaultReasoningEffort,
    });
    appServer.threadItemsList = vi.fn().mockResolvedValue({
        data: [{turnId: "turn-1", item: {type: "agentMessage", id: "m-1", text: "history", phase: null, memoryCitation: null, delivery: null, questions: null}}],
        nextCursor: null,
        backwardsCursor: null,
    });
    return fixture;
}

/** Initializes the agent and waits for the account read that `initialize` starts. */
async function initialize(fixture: CodexMockTestFixture): Promise<void> {
    await fixture.getCodexAcpAgent().initialize({protocolVersion: 1});
    for (let round = 0; round < 5; round += 1) {
        await new Promise<void>(resolve => setImmediate(resolve));
    }
    vi.mocked(fixture.getCodexAppServerClient().accountRead).mockClear();
}

describe("CodexACPAgent - loadSession auth", () => {
    it("resumes the thread while the account read runs, and reads the account once", async () => {
        const fixture = loadFixture();
        const appServer = fixture.getCodexAppServerClient();
        let answer: (response: GetAccountResponse) => void = () => {};
        appServer.accountRead = vi.fn()
            .mockResolvedValueOnce(SIGNED_IN)
            .mockImplementation(() => new Promise<GetAccountResponse>(resolve => answer = resolve));
        await initialize(fixture);

        const load = fixture.getCodexAcpAgent().loadSession({sessionId: SESSION_ID, cwd: "/test/project", mcpServers: []});
        await vi.waitFor(() => expect(appServer.threadResume).toHaveBeenCalledTimes(1));
        answer(SIGNED_IN);
        await load;

        expect(appServer.accountRead).toHaveBeenCalledTimes(1);
        expect(fixture.getCodexAcpAgent().getSessionState(SESSION_ID).account).toEqual(SIGNED_IN.account);
    });

    it("fails with auth_required and closes the resumed thread when the agent needs a login", async () => {
        const fixture = loadFixture();
        const client = fixture.getCodexAcpClient();
        const appServer = fixture.getCodexAppServerClient();
        appServer.accountRead = vi.fn().mockResolvedValue({account: null, requiresOpenaiAuth: true});
        const closeSpy = vi.spyOn(client, "closeSession").mockResolvedValue(undefined as never);
        await initialize(fixture);

        await expect(fixture.getCodexAcpAgent().loadSession({sessionId: SESSION_ID, cwd: "/test/project", mcpServers: []}))
            .rejects.toMatchObject({code: -32000});

        expect(closeSpy).toHaveBeenCalledWith(SESSION_ID);
        expect(appServer.threadItemsList).not.toHaveBeenCalled();
        expect(() => fixture.getCodexAcpAgent().getSessionState(SESSION_ID)).toThrow();
    });

    it("fails with auth_required when the resume also fails", async () => {
        const fixture = loadFixture();
        const appServer = fixture.getCodexAppServerClient();
        appServer.accountRead = vi.fn().mockResolvedValue({account: null, requiresOpenaiAuth: true});
        appServer.threadResume = vi.fn().mockRejectedValue(new Error("no rollout found for thread id session-1"));
        await initialize(fixture);

        await expect(fixture.getCodexAcpAgent().loadSession({sessionId: SESSION_ID, cwd: "/test/project", mcpServers: []}))
            .rejects.toMatchObject({code: -32000});
    });
});

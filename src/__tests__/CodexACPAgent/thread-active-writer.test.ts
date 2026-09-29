import {describe, expect, it, vi} from "vitest";
import * as acp from "@agentclientprotocol/sdk";
import {createCodexMockTestFixture, createTestModel} from "../acp-test-utils";
import type {Thread} from "../../app-server/v2";

const threadId = "01a0637c-5b99-7242-9064-04545d605fdb";

// The literal wording and code Codex 0.158 answers `thread/resume` with while
// another app-server holds the thread's writer lock, captured from a live
// app-server.
const ACTIVE_WRITER = Object.assign(new Error(`thread ${threadId} already has an active writer`), {code: -32600});

const expectedError = {
    code: -32600,
    message: "Invalid request: This Codex session is in use by another Codex client (the Codex app, the CLI or an IDE extension). Close the session there or quit that client, then try again.",
    data: {
        reason: "thread_active_writer",
        threadId,
        details: `thread ${threadId} already has an active writer`,
    },
};

function createThread(): Thread {
    return {
        id: threadId,
        sessionId: threadId,
        parentThreadId: null,
        threadSource: null,
        originator: null,
        forkedFromId: null,
        preview: "",
        ephemeral: false,
        modelProvider: "openai",
        model: "model-id",
        reasoningEffort: "medium",
        createdAt: 1,
        updatedAt: 1,
        recencyAt: null,
        status: {type: "idle"},
        path: null,
        cwd: "/test/cwd",
        cliVersion: "0",
        section: null,
        sectionEnteredAt: null,
        projectId: null,
        historyMode: "paginated",
        source: "cli",
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        name: null,
        turns: [],
    };
}

function createFixture() {
    const fixture = createCodexMockTestFixture();
    const client = fixture.getCodexAcpClient();
    const appServer = fixture.getCodexAppServerClient();
    client.authRequired = vi.fn().mockResolvedValue(false);
    client.getAccount = vi.fn().mockResolvedValue({account: null, requiresOpenaiAuth: false});
    client.listSkills = vi.fn().mockResolvedValue({data: []});
    appServer.listModels = vi.fn().mockResolvedValue({data: [createTestModel()], nextCursor: null});
    appServer.threadRead = vi.fn();
    appServer.threadUnsubscribe = vi.fn().mockResolvedValue({});
    return {fixture, agent: fixture.getCodexAcpAgent(), appServer};
}

function resumedThread() {
    return {
        thread: createThread(),
        model: "model-id",
        modelProvider: "openai",
        reasoningEffort: "medium",
        serviceTier: null,
        itemsBackwardsCursor: null,
    };
}

describe("a thread that another Codex client has loaded", () => {
    it("fails session/load with a clear, typed error and installs no session", async () => {
        const {agent, appServer} = createFixture();
        appServer.threadResume = vi.fn().mockRejectedValue(ACTIVE_WRITER);

        const load = agent.loadSession({sessionId: threadId, cwd: "/test/cwd", mcpServers: []});

        await expect(load).rejects.toBeInstanceOf(acp.RequestError);
        await expect(load).rejects.toMatchObject(expectedError);
        expect(appServer.threadRead).not.toHaveBeenCalled();
        expect(() => agent.getSessionState(threadId)).toThrow(`Session ${threadId} not found`);
    });

    it("fails session/resume with the same error and installs no session", async () => {
        const {agent, appServer} = createFixture();
        appServer.threadResume = vi.fn().mockRejectedValue(ACTIVE_WRITER);

        const resume = agent.resumeSession({sessionId: threadId, cwd: "/test/cwd", mcpServers: []});

        await expect(resume).rejects.toBeInstanceOf(acp.RequestError);
        await expect(resume).rejects.toMatchObject(expectedError);
        expect(appServer.threadRead).not.toHaveBeenCalled();
        expect(() => agent.getSessionState(threadId)).toThrow(`Session ${threadId} not found`);
    });

    it("loads the session on a retry after the other client lets the thread go", async () => {
        const {agent, appServer} = createFixture();
        appServer.threadResume = vi.fn()
            .mockRejectedValueOnce(ACTIVE_WRITER)
            .mockResolvedValueOnce(resumedThread());

        await expect(agent.loadSession({sessionId: threadId, cwd: "/test/cwd", mcpServers: []}))
            .rejects.toMatchObject({data: {reason: "thread_active_writer"}});
        await expect(agent.loadSession({sessionId: threadId, cwd: "/test/cwd", mcpServers: []}))
            .resolves.toBeDefined();

        expect(agent.getSessionState(threadId).sessionId).toBe(threadId);
    });

    it("still forks the thread, because a fork does not resume the source thread", async () => {
        const {agent, appServer} = createFixture();
        const forkId = "01a0637c-5b99-7242-9064-04545d605fdc";
        appServer.threadResume = vi.fn().mockRejectedValue(ACTIVE_WRITER);
        appServer.threadFork = vi.fn().mockResolvedValue({
            ...resumedThread(),
            thread: {...createThread(), id: forkId, sessionId: forkId, forkedFromId: threadId},
        });

        const response = await agent.forkSession({sessionId: threadId, cwd: "/test/cwd", mcpServers: []});

        expect(response.sessionId).toBe(forkId);
        expect(appServer.threadResume).not.toHaveBeenCalled();
    });
});

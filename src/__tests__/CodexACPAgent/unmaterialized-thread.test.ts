import {describe, expect, it, vi} from "vitest";
import {createCodexMockTestFixture, createTestModel} from "../acp-test-utils";
import type {Thread} from "../../app-server/v2";

// Codex materializes a thread's rollout file on the thread's first user
// message, so every rollout-backed call fails this way for a session that was
// created but never prompted -- the exact wording Codex 0.155 answers with.
const NO_ROLLOUT = (threadId: string) => new Error(`no rollout found for thread id ${threadId}`);
const INVALID_ID = new Error(
    "invalid session id: invalid character: expected an optional prefix of `urn:uuid:` followed by [0-9a-fA-F-], found `t` at 1"
);

const threadId = "01a0c48a-fc81-7b33-8d61-f4e2fd7c9b99";

function createLiveThread(): Thread {
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
    return {fixture, client, appServer};
}

describe("sessions Codex has not materialized on disk", () => {
    it("resumes from the live thread when thread/resume finds no rollout", async () => {
        const {fixture, appServer} = createFixture();
        appServer.threadResume = vi.fn().mockRejectedValue(NO_ROLLOUT(threadId));
        appServer.threadRead = vi.fn().mockResolvedValue({thread: createLiveThread()});

        const response = await fixture.getCodexAcpAgent().resumeSession({
            sessionId: threadId,
            cwd: "/test/cwd",
            mcpServers: [],
        });

        expect(appServer.threadRead).toHaveBeenCalledWith({threadId});
        expect(response.models?.currentModelId).toBe("model-id[medium]");
    });

    it("loads an unmaterialized thread with empty history instead of paging it", async () => {
        const {fixture, appServer} = createFixture();
        appServer.threadResume = vi.fn().mockRejectedValue(NO_ROLLOUT(threadId));
        appServer.threadRead = vi.fn().mockResolvedValue({thread: createLiveThread()});
        appServer.threadTurnsList = vi.fn();

        await expect(fixture.getCodexAcpAgent().loadSession({
            sessionId: threadId,
            cwd: "/test/cwd",
            mcpServers: [],
        })).resolves.toBeDefined();

        // `thread/turns/list` rejects an unmaterialized thread outright, and
        // there is no history to hydrate anyway.
        expect(appServer.threadTurnsList).not.toHaveBeenCalled();
    });

    it("keeps reporting a thread id Codex has genuinely never seen", async () => {
        const {fixture, appServer} = createFixture();
        appServer.threadResume = vi.fn().mockRejectedValue(NO_ROLLOUT(threadId));
        appServer.threadRead = vi.fn().mockRejectedValue(new Error(`thread not loaded: ${threadId}`));

        await expect(fixture.getCodexAcpAgent().resumeSession({
            sessionId: threadId,
            cwd: "/test/cwd",
            mcpServers: [],
        })).rejects.toThrow("no rollout found for thread id");
    });

    it("does not swallow an unrelated thread/resume failure", async () => {
        const {fixture, appServer} = createFixture();
        appServer.threadResume = vi.fn().mockRejectedValue(new Error("codex app-server transport closed"));
        appServer.threadRead = vi.fn();

        await expect(fixture.getCodexAcpAgent().resumeSession({
            sessionId: threadId,
            cwd: "/test/cwd",
            mcpServers: [],
        })).rejects.toThrow("transport closed");
        expect(appServer.threadRead).not.toHaveBeenCalled();
    });

    it("deletes a session that has no persisted rollout", async () => {
        const {fixture, appServer} = createFixture();
        appServer.threadArchive = vi.fn().mockRejectedValue(NO_ROLLOUT(threadId));

        await expect(fixture.getCodexAcpAgent().deleteSession({sessionId: threadId})).resolves.toEqual({});
    });

    it("deletes a session id Codex cannot even parse", async () => {
        const {fixture, appServer} = createFixture();
        appServer.threadArchive = vi.fn().mockRejectedValue(INVALID_ID);

        await expect(fixture.getCodexAcpAgent().deleteSession({
            sessionId: "tck-never-created-session",
        })).resolves.toEqual({});
    });

    it("still fails a delete that went wrong for any other reason", async () => {
        const {fixture, appServer} = createFixture();
        appServer.threadArchive = vi.fn().mockRejectedValue(new Error("disk is full"));

        await expect(fixture.getCodexAcpAgent().deleteSession({sessionId: threadId}))
            .rejects.toThrow("disk is full");
    });
});

describe("session/load and a title generation left over from an earlier turn", () => {
    it("waits for the rename to land before answering", async () => {
        const {fixture, appServer} = createFixture();
        appServer.threadResume = vi.fn().mockRejectedValue(NO_ROLLOUT(threadId));
        appServer.threadRead = vi.fn().mockResolvedValue({thread: createLiveThread()});
        appServer.threadStart = vi.fn().mockResolvedValue({
            thread: createLiveThread(),
            model: "model-id",
            modelProvider: "openai",
            reasoningEffort: "medium",
            serviceTier: null,
        });
        const agent = fixture.getCodexAcpAgent();
        await agent.newSession({cwd: "/test/cwd", mcpServers: []});

        let settled = false;
        const titleGeneration = new Promise<void>(resolve => {
            setTimeout(() => {
                settled = true;
                resolve();
            }, 20);
        });
        agent.getSessionState(threadId).titleGen = {
            waitForIdle: () => titleGeneration,
            markExistingTitle: () => {},
        } as unknown as NonNullable<ReturnType<typeof agent.getSessionState>["titleGen"]>;

        await agent.loadSession({sessionId: threadId, cwd: "/test/cwd", mcpServers: []});

        // The load response means "the replay is complete"; a rename echo from
        // a still-running generation would arrive after it.
        expect(settled).toBe(true);
    });
});

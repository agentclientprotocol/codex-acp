import {describe, expect, it, vi} from "vitest";
import type {CodexAcpServer} from "../../CodexAcpServer";
import {createCodexMockTestFixture, createTestModel} from "../acp-test-utils";

function setupSessionMocks() {
    const fixture = createCodexMockTestFixture();
    const client = fixture.getCodexAcpClient();
    const appServer = fixture.getCodexAppServerClient();

    vi.spyOn(appServer, "listSkills").mockResolvedValue({data: []});
    vi.spyOn(appServer, "listModels").mockResolvedValue({
        data: [createTestModel({id: "gpt-5"})],
        nextCursor: null,
    });
    const threadStart = vi.spyOn(appServer, "threadStart").mockResolvedValue({
        thread: {id: "new-thread"} as never,
        model: "gpt-5",
        reasoningEffort: "medium",
        serviceTier: null,
    } as never);
    const threadResume = vi.spyOn(appServer, "threadResume").mockImplementation(async ({threadId}) => ({
        thread: {id: threadId} as never,
        model: "gpt-5",
        reasoningEffort: "medium",
        serviceTier: null,
    }) as never);
    vi.spyOn(appServer, "threadRead").mockImplementation(async ({threadId}) => ({
        thread: {id: threadId} as never,
    }) as never);

    return {client, threadStart, threadResume};
}

function setupServerValidationMocks() {
    const fixture = createCodexMockTestFixture();
    const agent = fixture.getCodexAcpAgent();
    const client = fixture.getCodexAcpClient();
    const appServer = fixture.getCodexAppServerClient();

    const authRequired = vi.spyOn(client, "authRequired").mockResolvedValue(false);
    const getAccount = vi.spyOn(client, "getAccount");
    const clientNewSession = vi.spyOn(client, "newSession");
    const clientResumeSession = vi.spyOn(client, "resumeSession");
    const clientLoadSession = vi.spyOn(client, "loadSession");
    const listSkills = vi.spyOn(appServer, "listSkills").mockResolvedValue({data: []});
    const threadStart = vi.spyOn(appServer, "threadStart");
    const threadResume = vi.spyOn(appServer, "threadResume");
    const threadRead = vi.spyOn(appServer, "threadRead");

    return {
        agent,
        authRequired,
        getAccount,
        clientNewSession,
        clientResumeSession,
        clientLoadSession,
        listSkills,
        threadStart,
        threadResume,
        threadRead,
    };
}

function invokeSessionRoute(
    agent: CodexAcpServer,
    route: "new" | "resume" | "load",
    systemPrompt: unknown,
) {
    const _meta = {systemPrompt};
    switch (route) {
        case "new":
            return agent.newSession({cwd: "/workspace", mcpServers: [], _meta});
        case "resume":
            return agent.resumeSession({sessionId: "resume-thread", cwd: "/workspace", _meta});
        case "load":
            return agent.loadSession({sessionId: "load-thread", cwd: "/workspace", mcpServers: [], _meta});
    }
}

function getPendingSessionOpenCount(agent: CodexAcpServer): number {
    return (agent as unknown as {sessionOpenGenerations: Map<string, number>})
        .sessionOpenGenerations.size;
}

describe("persistent system prompt metadata", () => {
    it("installs systemPrompt as developer instructions when creating a session", async () => {
        const {client, threadStart} = setupSessionMocks();

        await client.newSession({
            cwd: "/workspace",
            mcpServers: [],
            _meta: {
                systemPrompt: "  [Base]\nOperate as the Buzz managed agent.  ",
            },
        });

        expect(threadStart).toHaveBeenCalledWith(expect.objectContaining({
            developerInstructions: "[Base]\nOperate as the Buzz managed agent.",
        }));
    });

    it("reapplies systemPrompt as developer instructions when resuming or loading a session", async () => {
        const {client, threadResume} = setupSessionMocks();
        const meta = {systemPrompt: "Buzz persistent instructions"};

        await client.resumeSession({
            sessionId: "resume-thread",
            cwd: "/workspace",
            _meta: meta,
        });
        await client.loadSession({
            sessionId: "load-thread",
            cwd: "/workspace",
            mcpServers: [],
            _meta: meta,
        });

        expect(threadResume).toHaveBeenNthCalledWith(1, expect.objectContaining({
            threadId: "resume-thread",
            developerInstructions: "Buzz persistent instructions",
        }));
        expect(threadResume).toHaveBeenNthCalledWith(2, expect.objectContaining({
            threadId: "load-thread",
            developerInstructions: "Buzz persistent instructions",
        }));
    });

    it("omits developer instructions when systemPrompt is absent or blank", async () => {
        const {client, threadStart} = setupSessionMocks();

        await client.newSession({cwd: "/workspace", mcpServers: []});
        await client.newSession({
            cwd: "/workspace",
            mcpServers: [],
            _meta: {systemPrompt: " \n\t "},
        });

        expect(threadStart.mock.calls[0]![0]).not.toHaveProperty("developerInstructions");
        expect(threadStart.mock.calls[1]![0]).not.toHaveProperty("developerInstructions");
    });

    it("rejects malformed or oversized systemPrompt metadata before starting a thread", async () => {
        const {client, threadStart} = setupSessionMocks();

        await expect(client.newSession({
            cwd: "/workspace",
            mcpServers: [],
            _meta: {systemPrompt: 42},
        })).rejects.toThrow("systemPrompt must be a string");

        await expect(client.newSession({
            cwd: "/workspace",
            mcpServers: [],
            _meta: {systemPrompt: "a".repeat(256 * 1024 + 1)},
        })).rejects.toThrow("systemPrompt must not exceed 262144 UTF-8 bytes");

        expect(threadStart).not.toHaveBeenCalled();
    });

    it("applies the byte limit to raw UTF-8 metadata before trimming", async () => {
        const {client, threadStart} = setupSessionMocks();
        const exactlyAtLimit = "é".repeat(128 * 1024);

        await client.newSession({
            cwd: "/workspace",
            mcpServers: [],
            _meta: {systemPrompt: exactlyAtLimit},
        });
        await expect(client.newSession({
            cwd: "/workspace",
            mcpServers: [],
            _meta: {systemPrompt: `${exactlyAtLimit}a`},
        })).rejects.toThrow("systemPrompt must not exceed 262144 UTF-8 bytes");
        await expect(client.newSession({
            cwd: "/workspace",
            mcpServers: [],
            _meta: {systemPrompt: `${" ".repeat(256 * 1024)}x`},
        })).rejects.toThrow("systemPrompt must not exceed 262144 UTF-8 bytes");

        expect(threadStart).toHaveBeenCalledTimes(1);
        expect(threadStart).toHaveBeenCalledWith(expect.objectContaining({
            developerInstructions: exactlyAtLimit,
        }));
    });

    it.each(["new", "resume", "load"] as const)(
        "rejects invalid metadata before public %s-session side effects",
        async (route) => {
            const invalidCases: Array<[unknown, string]> = [
                [42, "systemPrompt must be a string"],
                [`${" ".repeat(256 * 1024)}x`, "systemPrompt must not exceed 262144 UTF-8 bytes"],
            ];

            for (const [systemPrompt, expectedMessage] of invalidCases) {
                const mocks = setupServerValidationMocks();

                await expect(invokeSessionRoute(mocks.agent, route, systemPrompt))
                    .rejects.toThrow(expectedMessage);

                expect(mocks.authRequired).not.toHaveBeenCalled();
                expect(mocks.getAccount).not.toHaveBeenCalled();
                expect(mocks.clientNewSession).not.toHaveBeenCalled();
                expect(mocks.clientResumeSession).not.toHaveBeenCalled();
                expect(mocks.clientLoadSession).not.toHaveBeenCalled();
                expect(mocks.listSkills).not.toHaveBeenCalled();
                expect(mocks.threadStart).not.toHaveBeenCalled();
                expect(mocks.threadResume).not.toHaveBeenCalled();
                expect(mocks.threadRead).not.toHaveBeenCalled();
                expect(getPendingSessionOpenCount(mocks.agent)).toBe(0);
            }
        },
    );
});

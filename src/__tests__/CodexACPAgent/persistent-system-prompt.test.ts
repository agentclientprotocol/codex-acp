import {describe, expect, it, vi} from "vitest";
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
});

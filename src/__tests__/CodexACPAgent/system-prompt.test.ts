import {describe, expect, it, vi} from "vitest";
import type {CodexAcpServer} from "../../CodexAcpServer";
import {
    readSystemPromptAppend,
    SYSTEM_PROMPT_APPEND_MAX_BYTES,
} from "../../SystemPrompt";
import {createCodexMockTestFixture, createTestModel} from "../acp-test-utils";

describe("system prompt append metadata", () => {
    it("accepts append text without changing its formatting", () => {
        expect(readSystemPromptAppend({
            systemPrompt: {append: "  You are a database expert.\n"},
        })).toBe("  You are a database expert.\n");
    });

    it("treats absent and blank append text as unspecified", () => {
        expect(readSystemPromptAppend()).toBeUndefined();
        expect(readSystemPromptAppend({systemPrompt: {append: " \n\t "}})).toBeUndefined();
    });

    it.each([
        [{systemPrompt: "replace the system prompt"}, "systemPrompt must be an object"],
        [{systemPrompt: null}, "systemPrompt must be an object"],
        [{systemPrompt: {}}, "systemPrompt.append must be a string"],
        [{systemPrompt: {append: 42}}, "systemPrompt.append must be a string"],
        [{systemPrompt: {append: "valid", mode: "override"}}, "unsupported fields: mode"],
    ])("rejects unsupported metadata %#", (meta, message) => {
        expect(() => readSystemPromptAppend(meta)).toThrow(message);
    });

    it("applies the byte limit to the raw UTF-8 append text", () => {
        const exactlyAtLimit = "é".repeat(SYSTEM_PROMPT_APPEND_MAX_BYTES / 2);
        expect(readSystemPromptAppend({systemPrompt: {append: exactlyAtLimit}})).toBe(exactlyAtLimit);
        expect(() => readSystemPromptAppend({
            systemPrompt: {append: `${exactlyAtLimit}a`},
        })).toThrow(`must not exceed ${SYSTEM_PROMPT_APPEND_MAX_BYTES} UTF-8 bytes`);
    });

    it("maps append text onto new, resume, load, and fork developer instructions", async () => {
        const fixture = createCodexMockTestFixture();
        const client = fixture.getCodexAcpClient();
        const appServer = fixture.getCodexAppServerClient();
        const model = createTestModel({id: "gpt-5"});

        vi.spyOn(appServer, "skillsExtraRootsSet").mockResolvedValue(undefined);
        vi.spyOn(appServer, "listSkills").mockResolvedValue({data: []});
        vi.spyOn(appServer, "configRead").mockResolvedValue({config: {model_provider: "openai"}} as never);
        vi.spyOn(appServer, "listModels").mockResolvedValue({data: [model], nextCursor: null});
        const threadStart = vi.spyOn(appServer, "threadStart").mockResolvedValue({
            thread: {id: "new-thread"},
            model: model.id,
            modelProvider: "openai",
            reasoningEffort: model.defaultReasoningEffort,
            serviceTier: null,
        } as never);
        const threadResume = vi.spyOn(appServer, "threadResume").mockImplementation(async ({threadId}) => ({
            thread: {id: threadId},
            model: model.id,
            modelProvider: "openai",
            reasoningEffort: model.defaultReasoningEffort,
            serviceTier: null,
        }) as never);
        vi.spyOn(appServer, "threadRead").mockImplementation(async ({threadId}) => ({
            thread: {id: threadId},
        }) as never);
        const threadFork = vi.spyOn(appServer, "threadFork").mockResolvedValue({
            thread: {id: "fork-thread"},
            model: model.id,
            modelProvider: "openai",
            reasoningEffort: model.defaultReasoningEffort,
            serviceTier: null,
        } as never);
        vi.spyOn(appServer, "threadUnsubscribe").mockResolvedValue({status: "unsubscribed"});

        const _meta = {systemPrompt: {append: "You are a database expert."}};
        await client.newSession({cwd: "/workspace", mcpServers: [], _meta});
        await client.resumeSession({sessionId: "resume-thread", cwd: "/workspace", _meta});
        await client.loadSession({sessionId: "load-thread", cwd: "/workspace", mcpServers: [], _meta});
        await client.forkSession({sessionId: "source-thread", cwd: "/workspace", _meta});

        expect(threadStart).toHaveBeenCalledWith(expect.objectContaining({
            developerInstructions: "You are a database expert.",
        }));
        expect(threadStart.mock.calls[0]![0]).not.toHaveProperty("baseInstructions");
        expect(threadResume).toHaveBeenNthCalledWith(1, expect.objectContaining({
            threadId: "resume-thread",
            developerInstructions: "You are a database expert.",
        }));
        expect(threadResume).toHaveBeenNthCalledWith(2, expect.objectContaining({
            threadId: "load-thread",
            developerInstructions: "You are a database expert.",
        }));
        expect(threadFork).toHaveBeenCalledWith(expect.objectContaining({
            threadId: "source-thread",
            developerInstructions: "You are a database expert.",
        }));

        await client.newSession({cwd: "/workspace", mcpServers: []});
        await client.resumeSession({sessionId: "resume-without-append", cwd: "/workspace"});
        await client.loadSession({
            sessionId: "load-without-append",
            cwd: "/workspace",
            mcpServers: [],
        });
        await client.forkSession({sessionId: "fork-without-append", cwd: "/workspace"});

        expect(threadStart.mock.calls[1]![0]).not.toHaveProperty("developerInstructions");
        expect(threadResume.mock.calls[2]![0]).not.toHaveProperty("developerInstructions");
        expect(threadResume.mock.calls[3]![0]).not.toHaveProperty("developerInstructions");
        expect(threadFork.mock.calls[1]![0]).not.toHaveProperty("developerInstructions");
    });

    it.each(["new", "resume", "load", "fork"] as const)(
        "rejects invalid metadata before public %s-session side effects",
        async route => {
            const fixture = createCodexMockTestFixture();
            const agent = fixture.getCodexAcpAgent();
            const client = fixture.getCodexAcpClient();
            const authRequired = vi.spyOn(client, "authRequired");

            await expect(invokeSessionRoute(agent, route)).rejects.toThrow(
                "systemPrompt must be an object containing an append string",
            );
            expect(authRequired).not.toHaveBeenCalled();
        },
    );
});

function invokeSessionRoute(agent: CodexAcpServer, route: "new" | "resume" | "load" | "fork") {
    const _meta = {systemPrompt: "override is not supported"};
    switch (route) {
        case "new":
            return agent.newSession({cwd: "/workspace", mcpServers: [], _meta});
        case "resume":
            return agent.resumeSession({sessionId: "resume-thread", cwd: "/workspace", _meta});
        case "load":
            return agent.loadSession({sessionId: "load-thread", cwd: "/workspace", mcpServers: [], _meta});
        case "fork":
            return agent.forkSession({sessionId: "source-thread", cwd: "/workspace", _meta});
    }
}

import {describe, expect, it, vi} from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import {AgentMode} from "../../AgentMode";
import {createCodexMockTestFixture, createTestModel} from "../acp-test-utils";

async function captureRejection<T>(promise: Promise<T>): Promise<unknown> {
    try {
        await promise;
    } catch (error) {
        return error;
    }
    throw new Error("Expected promise to reject");
}

describe("ACP session fork", () => {
    it("advertises session fork support", async () => {
        const fixture = createCodexMockTestFixture();

        const response = await fixture.getCodexAcpAgent().initialize({protocolVersion: 1});

        expect(response.agentCapabilities?.sessionCapabilities?.fork).toEqual({});
    });

    it("maps a fork request to Codex thread/fork and returns the new thread metadata", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();
        const model = createTestModel({id: "gpt-5"});
        const mcpServer: acp.McpServer = {
            name: "fork mcp",
            command: "node",
            args: ["server.js"],
            env: [{name: "TOKEN", value: "secret"}],
        };

        const extraRootsSetSpy = vi.spyOn(codexAppServerClient, "skillsExtraRootsSet").mockResolvedValue(undefined);
        const listSkillsSpy = vi.spyOn(codexAppServerClient, "listSkills").mockResolvedValue({data: []});
        const threadReadSpy = vi.spyOn(codexAppServerClient, "threadRead");
        vi.spyOn(codexAppServerClient, "configRead").mockImplementation(async (params) => ({
            config: params.includeLayers ? {} : {model_provider: "configured-provider"},
        } as any));
        const threadForkSpy = vi.spyOn(codexAppServerClient, "threadFork").mockResolvedValue({
            thread: {id: "fork-session"},
            model: model.id,
            modelProvider: "source-provider",
            serviceTier: "fast",
            reasoningEffort: model.defaultReasoningEffort,
        } as any);
        vi.spyOn(codexAppServerClient, "getThreadSettings").mockReturnValue({
            collaborationMode: {mode: "plan"},
        } as any);
        vi.spyOn(codexAppServerClient, "listModels").mockResolvedValue({
            data: [model],
            nextCursor: null,
        });

        const result = await codexAcpClient.forkSession({
            sessionId: "source-session",
            cwd: "/workspace",
            additionalDirectories: ["/workspace/extra"],
            mcpServers: [mcpServer],
            _meta: {
                sessionFork: {},
            },
        });

        expect(result).toEqual({
            sessionId: "fork-session",
            currentModelId: "gpt-5[medium]",
            models: [model],
            collaborationMode: "plan",
            modelProvider: "source-provider",
            currentServiceTier: "fast",
            additionalDirectories: ["/workspace/extra"],
        });
        expect(extraRootsSetSpy).toHaveBeenCalledWith({
            extraRoots: ["/workspace/extra/.agents/skills"],
        });
        expect(listSkillsSpy).toHaveBeenCalledWith({
            // noinspection SpellCheckingInspection
            cwds: ["/workspace", "/workspace/extra"],
            forceReload: true,
        });
        expect(threadReadSpy).not.toHaveBeenCalled();
        expect(threadForkSpy).toHaveBeenCalledWith({
            threadId: "source-session",
            cwd: "/workspace",
            modelProvider: "configured-provider",
            config: {
                projects: {
                    "/workspace": {trust_level: "trusted"},
                    "/workspace/extra": {trust_level: "trusted"},
                },
                sandbox_workspace_write: {
                    writable_roots: ["/workspace/extra"],
                },
                mcp_servers: {
                    fork_mcp: {
                        command: "node",
                        args: ["server.js"],
                        env: {TOKEN: "secret"},
                    },
                },
            },
        });
    });

    it("forks through the requested persisted item ID", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();
        const model = createTestModel({id: "gpt-5"});

        vi.spyOn(codexAppServerClient, "threadRead").mockResolvedValue({
            thread: {
                turns: [
                    {
                        id: "turn-1",
                        items: [{type: "agentMessage", id: "message-1"}],
                    },
                    {
                        id: "turn-2",
                        items: [{type: "agentMessage", id: "message-2"}],
                    },
                ],
            },
        } as any);
        vi.spyOn(codexAppServerClient, "listSkills").mockResolvedValue({data: []});
        vi.spyOn(codexAppServerClient, "configRead").mockResolvedValue({config: {}} as any);
        const threadForkSpy = vi.spyOn(codexAppServerClient, "threadFork").mockResolvedValue({
            thread: {id: "fork-session"},
            model: model.id,
            modelProvider: "openai",
            serviceTier: null,
            reasoningEffort: model.defaultReasoningEffort,
        } as any);
        vi.spyOn(codexAppServerClient, "listModels").mockResolvedValue({
            data: [model],
            nextCursor: null,
        });

        await codexAcpClient.forkSession({
            sessionId: "source-session",
            cwd: "/workspace",
            _meta: {
                sessionFork: {
                    messageId: "message-1",
                },
            },
        });

        expect(codexAppServerClient.threadRead).toHaveBeenCalledWith({
            threadId: "source-session",
            includeTurns: true,
        });
        expect(threadForkSpy).toHaveBeenCalledWith(expect.objectContaining({
            threadId: "source-session",
            lastTurnId: "turn-1",
        }));
    });

    it("does not accept a turn ID as a message ID", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();

        vi.spyOn(codexAppServerClient, "threadRead").mockResolvedValue({
            thread: {
                turns: [{
                    id: "turn-1",
                    items: [{type: "agentMessage", id: "known-message"}],
                }],
            },
        } as any);
        const threadForkSpy = vi.spyOn(codexAppServerClient, "threadFork");

        const error = await captureRejection(codexAcpClient.forkSession({
            sessionId: "source-session",
            cwd: "/workspace",
            _meta: {
                sessionFork: {
                    messageId: "turn-1",
                },
            },
        }));

        expect(error).toMatchObject({
            code: -32602,
            message: "Invalid params: Fork message turn-1 was not found in session source-session",
            data: {
                sessionId: "source-session",
                messageId: "turn-1",
            },
        });
        expect(threadForkSpy).not.toHaveBeenCalled();
    });

    it.each([
        {name: "string sessionFork", sessionFork: "turn-1", message: "_meta.sessionFork must be an object"},
        {name: "array sessionFork", sessionFork: ["turn-1"], message: "_meta.sessionFork must be an object"},
        {name: "null sessionFork", sessionFork: null, message: "_meta.sessionFork must be an object"},
        {name: "non-string messageId", sessionFork: {messageId: 42}, message: "_meta.sessionFork.messageId must be a non-empty string"},
        {name: "empty messageId", sessionFork: {messageId: ""}, message: "_meta.sessionFork.messageId must be a non-empty string"},
    ])("rejects malformed fork message metadata: $name", async ({sessionFork, message}) => {
        const fixture = createCodexMockTestFixture();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();
        const threadReadSpy = vi.spyOn(codexAppServerClient, "threadRead");
        const threadForkSpy = vi.spyOn(codexAppServerClient, "threadFork");

        const error = await captureRejection(codexAcpClient.forkSession({
            sessionId: "source-session",
            cwd: "/workspace",
            _meta: {
                sessionFork,
            },
        } as any));

        expect(error).toMatchObject({
            code: -32602,
            message: `Invalid params: ${message}`,
        });
        expect(threadReadSpy).not.toHaveBeenCalled();
        expect(threadForkSpy).not.toHaveBeenCalled();
    });

    it("reports a source without a rollout as resource not found", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();

        vi.spyOn(codexAppServerClient, "listSkills").mockResolvedValue({data: []});
        vi.spyOn(codexAppServerClient, "configRead").mockResolvedValue({config: {}} as any);
        const error = new Error("no rollout found for thread id missing-session");
        vi.spyOn(codexAppServerClient, "threadFork").mockRejectedValue(error);
        const loadedListSpy = vi.spyOn(codexAppServerClient, "threadLoadedList");
        const threadStartSpy = vi.spyOn(codexAppServerClient, "threadStart");

        const rejection = await captureRejection(codexAcpClient.forkSession({
            sessionId: "missing-session",
            cwd: "/workspace",
        }));
        expect(rejection).toMatchObject({
            code: -32002,
            message: "Resource not found: missing-session",
            data: {uri: "missing-session"},
        });
        expect(loadedListSpy).not.toHaveBeenCalled();
        expect(threadStartSpy).not.toHaveBeenCalled();
    });

    it("reports a source without a rollout as resource not found when forking through a message", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();

        const error = new Error("thread not loaded: missing-session");
        vi.spyOn(codexAppServerClient, "threadRead").mockRejectedValue(error);
        const threadForkSpy = vi.spyOn(codexAppServerClient, "threadFork");

        const rejection = await captureRejection(codexAcpClient.forkSession({
            sessionId: "missing-session",
            cwd: "/workspace",
            _meta: {
                sessionFork: {
                    messageId: "turn-1",
                },
            },
        }));
        expect(rejection).toMatchObject({
            code: -32002,
            message: "Resource not found: missing-session",
            data: {uri: "missing-session"},
        });
        expect(threadForkSpy).not.toHaveBeenCalled();
    });

    it("preserves unrelated native fork errors", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();
        const nativeError = new Error("fork failed for another reason");

        vi.spyOn(codexAppServerClient, "listSkills").mockResolvedValue({data: []});
        vi.spyOn(codexAppServerClient, "configRead").mockResolvedValue({config: {}} as any);
        vi.spyOn(codexAppServerClient, "threadFork").mockRejectedValue(nativeError);

        const error = await captureRejection(codexAcpClient.forkSession({
            sessionId: "source-session",
            cwd: "/workspace",
        }));

        expect(error).toBe(nativeError);
    });

    it("publishes commands, MCP status, and goal only after returning the fork response", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const model = createTestModel({id: "gpt-5"});
        const events: string[] = [];

        vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);
        vi.spyOn(codexAcpClient, "getAccount").mockResolvedValue({
            account: null,
            requiresOpenaiAuth: false,
        });
        vi.spyOn(codexAcpClient, "forkSession").mockResolvedValue({
            sessionId: "fork-session",
            currentModelId: "gpt-5[medium]",
            models: [model],
            collaborationMode: "default",
            modelProvider: "openai",
            currentServiceTier: null,
            additionalDirectories: [],
        });
        vi.spyOn(codexAcpClient, "listSkills").mockImplementation(async () => {
            events.push("available-commands");
            return {data: []};
        });
        vi.spyOn(codexAcpClient, "getMcpServerStartupVersion").mockReturnValue(0);
        vi.spyOn(codexAcpClient, "awaitMcpServerStartup").mockImplementation(async () => {
            events.push("mcp-startup");
            return {ready: ["fork-mcp"], failed: [], cancelled: []};
        });
        vi.spyOn(codexAcpClient, "getGoal").mockImplementation(async () => {
            events.push("goal");
            return null;
        });

        await codexAcpAgent.unstable_forkSession({
            sessionId: "source-session",
            cwd: "/workspace",
            mcpServers: [{
                name: "fork-mcp",
                command: "node",
                args: ["server.js"],
                env: [],
            }],
        });
        events.push("fork-response");

        expect(events).toEqual(["fork-response"]);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(events).toEqual(["fork-response", "available-commands", "mcp-startup", "goal"]);
    });

    it("skips deferred fork publications when the session starts closing before they fire", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const model = createTestModel({id: "gpt-5"});
        const events: string[] = [];

        vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);
        vi.spyOn(codexAcpClient, "getAccount").mockResolvedValue({
            account: null,
            requiresOpenaiAuth: false,
        });
        vi.spyOn(codexAcpClient, "forkSession").mockResolvedValue({
            sessionId: "fork-session",
            currentModelId: "gpt-5[medium]",
            models: [model],
            collaborationMode: "default",
            modelProvider: "openai",
            currentServiceTier: null,
            additionalDirectories: [],
        });
        let finishClose!: () => void;
        vi.spyOn(codexAcpClient, "closeSession").mockImplementation(
            () => new Promise<void>((resolve) => {
                finishClose = resolve;
            })
        );
        vi.spyOn(codexAcpClient, "listSkills").mockImplementation(async () => {
            events.push("available-commands");
            return {data: []};
        });
        vi.spyOn(codexAcpClient, "getMcpServerStartupVersion").mockReturnValue(0);
        vi.spyOn(codexAcpClient, "awaitMcpServerStartup").mockImplementation(async () => {
            events.push("mcp-startup");
            return {ready: [], failed: [], cancelled: []};
        });
        vi.spyOn(codexAcpClient, "getGoal").mockImplementation(async () => {
            events.push("goal");
            return null;
        });

        await codexAcpAgent.unstable_forkSession({
            sessionId: "source-session",
            cwd: "/workspace",
            mcpServers: [],
        });
        const close = codexAcpAgent.closeSession({sessionId: "fork-session"});
        await vi.waitFor(() => {
            expect(codexAcpClient.closeSession).toHaveBeenCalled();
        });

        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(events).toEqual([]);

        finishClose();
        await close;
    });

    it("installs the fork as an independent active session", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const model = createTestModel({id: "gpt-5"});

        vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);
        vi.spyOn(codexAcpClient, "getAccount").mockResolvedValue({
            account: null,
            requiresOpenaiAuth: false,
        });
        vi.spyOn(codexAcpClient, "listSkills").mockResolvedValue({data: []});
        vi.spyOn(codexAcpClient, "newSession").mockResolvedValue({
            sessionId: "source-session",
            currentModelId: "gpt-5[medium]",
            models: [model],
            collaborationMode: "default",
            modelProvider: "openai",
            currentServiceTier: null,
            additionalDirectories: [],
        });
        await codexAcpAgent.newSession({cwd: "/source-workspace", mcpServers: []});
        const sourceState = codexAcpAgent.getSessionState("source-session");
        await codexAcpAgent.setSessionMode({
            sessionId: "source-session",
            modeId: AgentMode.ReadOnly.id,
        });
        sourceState.currentTurnId = "source-turn";

        const forkSessionSpy = vi.spyOn(codexAcpClient, "forkSession").mockResolvedValue({
            sessionId: "fork-session",
            currentModelId: "gpt-5[medium]",
            models: [model],
            collaborationMode: "default",
            modelProvider: "openai",
            currentServiceTier: null,
            additionalDirectories: ["/fork-extra"],
        });

        const response = await codexAcpAgent.unstable_forkSession({
            sessionId: "source-session",
            cwd: "/fork-workspace",
            additionalDirectories: ["/fork-extra"],
            mcpServers: [],
        });

        expect(forkSessionSpy).toHaveBeenCalledWith({
            sessionId: "source-session",
            cwd: "/fork-workspace",
            additionalDirectories: ["/fork-extra"],
            mcpServers: [],
        });
        expect(response).not.toHaveProperty("models");
        await expect(`${JSON.stringify(response, null, 2)}\n`).toMatchFileSnapshot(
            "data/session-fork-response.json"
        );
        expect(codexAcpAgent.getSessionState("source-session")).toBe(sourceState);
        expect(sourceState).toMatchObject({
            agentMode: AgentMode.ReadOnly,
            currentTurnId: "source-turn",
            cwd: "/source-workspace",
        });
        expect(codexAcpAgent.getSessionState("fork-session")).toMatchObject({
            sessionId: "fork-session",
            currentModelId: "gpt-5[medium]",
            agentMode: AgentMode.Agent,
            currentTurnId: null,
            lastTokenUsage: null,
            totalTokenUsage: null,
            cwd: "/fork-workspace",
            additionalDirectories: ["/fork-extra"],
        });
    });
});

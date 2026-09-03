import {describe, expect, it, vi} from "vitest";
import {createCodexMockTestFixture, createTestModel} from "../acp-test-utils";
import type {ServerNotification} from "../../app-server";

describe("ACP session fork", () => {
    it("creates and installs a forked session", async () => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        const client = fixture.getCodexAcpClient();
        const model = createTestModel({id: "gpt-5"});

        vi.spyOn(client, "authRequired").mockResolvedValue(false);
        vi.spyOn(client, "getAccount").mockResolvedValue({account: null, requiresOpenaiAuth: false});
        vi.spyOn(client, "listSkills").mockResolvedValue({data: []});
        const forkSpy = vi.spyOn(client, "forkSession").mockResolvedValue({
            sessionId: "fork-id",
            currentModelId: "gpt-5[medium]",
            models: [model],
            collaborationMode: "default",
            modelProvider: "openai",
            currentServiceTier: null,
            additionalDirectories: [],
        });

        const response = await agent.forkSession({
            sessionId: "source-id",
            cwd: "/workspace",
            mcpServers: [],
        });

        expect(response.sessionId).toBe("fork-id");
        expect(agent.getSessionState("fork-id").cwd).toBe("/workspace");
        expect(fixture.getAcpConnectionEvents([])).toEqual([]);
        expect(forkSpy).toHaveBeenCalledWith({
            sessionId: "source-id",
            cwd: "/workspace",
            mcpServers: [],
        });
    });

    it("streams and completes a prompt sent directly to a newly forked session", async () => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        const client = fixture.getCodexAcpClient();
        const appServer = fixture.getCodexAppServerClient();
        const model = createTestModel({id: "gpt-5"});
        const metadata = {
            sessionId: "fork-id",
            currentModelId: "gpt-5[medium]",
            models: [model],
            collaborationMode: "default" as const,
            modelProvider: "openai",
            currentServiceTier: null,
            additionalDirectories: [],
        };

        vi.spyOn(client, "authRequired").mockResolvedValue(false);
        vi.spyOn(client, "getAccount").mockResolvedValue({account: null, requiresOpenaiAuth: false});
        vi.spyOn(client, "listSkills").mockResolvedValue({data: []});
        vi.spyOn(client, "forkSession").mockResolvedValue(metadata);
        const resumeSpy = vi.spyOn(client, "resumeSession").mockResolvedValue(metadata);
        vi.spyOn(appServer, "turnStart").mockImplementation(async () => {
            queueMicrotask(() => {
                const notifications: ServerNotification[] = [
                    {
                        method: "item/started",
                        params: {
                            threadId: "fork-id",
                            turnId: "turn-id",
                            startedAtMs: 0,
                            item: {
                                type: "agentMessage",
                                id: "message-id",
                                text: "",
                                phase: "final_answer",
                                memoryCitation: null,
                                delivery: null,
                            },
                        },
                    },
                    {
                        method: "item/agentMessage/delta",
                        params: {
                            threadId: "fork-id",
                            turnId: "turn-id",
                            itemId: "message-id",
                            delta: "Fork answer",
                        },
                    },
                    {
                        method: "turn/completed",
                        params: {
                            threadId: "fork-id",
                            turn: {
                                id: "turn-id",
                                items: [],
                                itemsView: "notLoaded",
                                status: "completed",
                                error: null,
                                startedAt: null,
                                completedAt: null,
                                durationMs: null,
                            },
                        },
                    },
                ];
                notifications.forEach(notification => fixture.sendServerNotification(notification));
            });
            return {
                turn: {
                    id: "turn-id",
                    items: [],
                    itemsView: "notLoaded",
                    status: "inProgress",
                    error: null,
                    startedAt: null,
                    completedAt: null,
                    durationMs: null,
                },
            };
        });

        const fork = await agent.forkSession({sessionId: "source-id", cwd: "/workspace", mcpServers: []});
        const prompt = agent.prompt({
            sessionId: fork.sessionId,
            prompt: [{type: "text", text: "Answer from the fork"}],
        });
        const response = await Promise.race([
            prompt,
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("fork prompt timed out")), 1_000)),
        ]);

        expect(response.stopReason).toBe("end_turn");
        expect(resumeSpy).toHaveBeenCalledWith({
            sessionId: "fork-id",
            cwd: "/workspace",
            additionalDirectories: [],
            mcpServers: [],
        });
        expect(fixture.getAcpConnectionEvents([])).toContainEqual({
            method: "sessionUpdate",
            args: [{
                sessionId: "fork-id",
                update: {
                    sessionUpdate: "agent_message_chunk",
                    content: {type: "text", text: "Fork answer"},
                    messageId: "message-id",
                    _meta: {codex: {phase: "final_answer"}},
                },
            }],
        });
    });
});

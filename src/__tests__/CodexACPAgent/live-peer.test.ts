import * as acp from "@agentclientprotocol/sdk";
import {beforeEach, describe, expect, it, vi} from "vitest";
import type {ServerNotification} from "../../app-server";
import type {CommandExecutionRequestApprovalParams, UserInput} from "../../app-server/v2";
import {
    createCodexMockTestFixture,
    createTestModel,
    type CodexMockTestFixture,
} from "../acp-test-utils";

describe("Codex ACP live peer", () => {
    let fixture: CodexMockTestFixture;

    beforeEach(() => {
        fixture = createCodexMockTestFixture();
        configureNewSession(fixture);
    });

    it("advertises live-peer support without enabling it for existing clients", async () => {
        const response = await fixture.getCodexAcpAgent().initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
        });
        expect(response._meta).toMatchObject({
            codex: {
                livePeer: {
                    version: 1,
                    ambientEvents: true,
                    interactions: true,
                    userMessages: true,
                    clientUserMessageIds: true,
                    turnLifecycle: true,
                },
            },
        });

        const session = await fixture.getCodexAcpAgent().newSession({
            cwd: "/workspace",
            mcpServers: [],
        });
        fixture.clearAcpConnectionDump();
        fixture.sendServerNotification(userMessageStarted(session.sessionId));

        await new Promise(resolve => setImmediate(resolve));
        expect(fixture.getAcpConnectionDump([])).not.toContain("terminal says hello");
    });

    it("streams ambient terminal user messages with their origin ID", async () => {
        await initializeLivePeer(fixture);
        const session = await fixture.getCodexAcpAgent().newSession({
            cwd: "/workspace",
            mcpServers: [],
        });
        fixture.clearAcpConnectionDump();

        fixture.sendServerNotification(userMessageStarted(
            session.sessionId,
            "telegram:chat-1:update-42",
        ));

        await vi.waitFor(() => {
            expect(fixture.getAcpConnectionDump([])).toContain("terminal says hello");
        });
        expect(fixture.getAcpConnectionDump([])).toContain(
            '"clientUserMessageId": "telegram:chat-1:update-42"',
        );
    });

    it("streams ambient turn lifecycle without guessing from message silence", async () => {
        await initializeLivePeer(fixture);
        const session = await fixture.getCodexAcpAgent().newSession({
            cwd: "/workspace",
            mcpServers: [],
        });
        fixture.clearAcpConnectionDump();

        fixture.sendServerNotification({
            method: "turn/started",
            params: {
                threadId: session.sessionId,
                turn: {
                    id: "turn-ambient",
                    items: [],
                    itemsView: "notLoaded",
                    status: "inProgress",
                    error: null,
                    startedAt: null,
                    completedAt: null,
                    durationMs: null,
                },
            },
        });
        fixture.sendServerNotification({
            method: "turn/completed",
            params: {
                threadId: session.sessionId,
                turn: {
                    id: "turn-ambient",
                    items: [],
                    itemsView: "notLoaded",
                    status: "completed",
                    error: null,
                    startedAt: null,
                    completedAt: null,
                    durationMs: null,
                },
            },
        });

        await vi.waitFor(() => {
            const updates = fixture.getAcpConnectionEvents([])
                .map(event => event.args[0]?.update);
            expect(updates).toContainEqual(expect.objectContaining({
                _meta: {
                    codex: {
                        turn: {
                            id: "turn-ambient",
                            status: "inProgress",
                        },
                    },
                },
            }));
            expect(updates).toContainEqual(expect.objectContaining({
                _meta: {
                    codex: {
                        turn: {
                            id: "turn-ambient",
                            status: "completed",
                            error: null,
                        },
                    },
                },
            }));
        });
    });

    it("uses the history mapper for ambient user-message content", async () => {
        await initializeLivePeer(fixture);
        const session = await fixture.getCodexAcpAgent().newSession({
            cwd: "/workspace",
            mcpServers: [],
        });
        fixture.clearAcpConnectionDump();

        fixture.sendServerNotification(userMessageStarted(
            session.sessionId,
            null,
            [
                {type: "text", text: "inspect this", text_elements: []},
                {type: "localImage", path: "/workspace/screenshot.png"},
            ],
        ));

        await vi.waitFor(() => {
            const updates = fixture.getAcpConnectionDump([]);
            expect(updates).toContain("inspect this");
            expect(updates).toContain("[@screenshot.png](file:///workspace/screenshot.png)");
        });
    });

    it("relays an ambient approval after the session is created", async () => {
        await initializeLivePeer(fixture);
        const session = await fixture.getCodexAcpAgent().newSession({
            cwd: "/workspace",
            mcpServers: [],
        });
        fixture.setPermissionResponse({
            outcome: {outcome: "selected", optionId: "allow_once"},
        });

        const params: CommandExecutionRequestApprovalParams = {
            threadId: session.sessionId,
            turnId: "turn-1",
            itemId: "command-1",
            reason: "Run the requested test",
            command: "npm test",
            cwd: "/workspace",
            startedAtMs: 0,
            environmentId: null,
            proposedExecpolicyAmendment: null,
        };

        await expect(fixture.sendServerRequest(
            "item/commandExecution/requestApproval",
            params,
        )).resolves.toEqual({decision: "accept"});
        expect(fixture.getAcpConnectionDump([])).toContain("requestPermission");
    });

    it("passes a client user-message ID into a normal turn", async () => {
        const agent = fixture.getCodexAcpAgent();
        const session = await agent.newSession({
            cwd: "/workspace",
            mcpServers: [],
        });
        const turnStart = mockCompletedTurn(fixture, session.sessionId);

        await agent.prompt({
            sessionId: session.sessionId,
            prompt: [{type: "text", text: "hello"}],
            _meta: {
                codex: {
                    clientUserMessageId: "telegram:chat-1:update-99",
                },
            },
        });

        expect(turnStart).toHaveBeenCalledWith(expect.objectContaining({
            clientUserMessageId: "telegram:chat-1:update-99",
        }));
    });

    it("restores ambient handlers after an ACP-owned prompt", async () => {
        await initializeLivePeer(fixture);
        const agent = fixture.getCodexAcpAgent();
        const session = await agent.newSession({
            cwd: "/workspace",
            mcpServers: [],
        });
        mockCompletedTurn(fixture, session.sessionId);

        await agent.prompt({
            sessionId: session.sessionId,
            prompt: [{type: "text", text: "remote prompt"}],
        });
        fixture.clearAcpConnectionDump();
        fixture.sendServerNotification(userMessageStarted(session.sessionId));

        await vi.waitFor(() => {
            expect(fixture.getAcpConnectionDump([])).toContain("terminal says hello");
        });
    });
});

async function initializeLivePeer(fixture: CodexMockTestFixture): Promise<void> {
    await fixture.getCodexAcpAgent().initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        _meta: {
            codex: {
                livePeer: {version: 1},
            },
        },
    });
}

function configureNewSession(fixture: CodexMockTestFixture): void {
    const client = fixture.getCodexAcpClient();
    const appServer = fixture.getCodexAppServerClient();
    client.authRequired = vi.fn().mockResolvedValue(false);
    client.getAccount = vi.fn().mockResolvedValue({
        account: null,
        requiresOpenaiAuth: false,
    });
    vi.spyOn(appServer, "listSkills").mockResolvedValue({data: []});
    vi.spyOn(appServer, "listModels").mockResolvedValue({
        data: [createTestModel()],
        nextCursor: null,
    });
    vi.spyOn(appServer, "threadStart").mockResolvedValue({
        thread: {id: "session-1"},
        model: "model-id",
        modelProvider: "openai",
        cwd: "/workspace",
        approvalPolicy: "on-request",
        sandbox: {type: "workspaceWrite", writableRoots: []},
        reasoningEffort: "medium",
    } as never);
}

function mockCompletedTurn(
    fixture: CodexMockTestFixture,
    threadId: string,
): ReturnType<typeof vi.spyOn> {
    const appServer = fixture.getCodexAppServerClient();
    const turn = {
        id: "turn-1",
        items: [],
        itemsView: "notLoaded" as const,
        status: "completed" as const,
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
    };
    const turnStart = vi.spyOn(appServer, "turnStart").mockResolvedValue({
        turn: {...turn, status: "inProgress"},
    });
    vi.spyOn(appServer, "awaitTurnCompleted").mockResolvedValue({
        threadId,
        turn,
    });
    return turnStart;
}

function userMessageStarted(
    threadId: string,
    clientId: string | null = null,
    content: UserInput[] = [{
        type: "text",
        text: "terminal says hello",
        text_elements: [],
    }],
): ServerNotification {
    return {
        method: "item/started",
        params: {
            threadId,
            turnId: "turn-1",
            startedAtMs: 0,
            item: {
                type: "userMessage",
                id: "message-1",
                clientId,
                content,
            },
        },
    };
}

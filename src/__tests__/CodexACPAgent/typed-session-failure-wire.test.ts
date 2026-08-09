import {describe, expect, it, vi} from "vitest";
import * as acp from "@agentclientprotocol/sdk";
import {CodexAppServerClient} from "../../CodexAppServerClient";
import {CodexAcpClient} from "../../CodexAcpClient";
import {CodexAcpServer} from "../../CodexAcpServer";
import {createTestSessionState} from "../acp-test-utils";
import {createMockConnections} from "./test-utils";

const typedFailureCapabilities: acp.ClientCapabilities = {
    _meta: {jetbrains: {air: {version: 1, capabilities: ["sessionFailure"]}}},
};

describe("typed session failures over ACP transport", () => {
    it("returns a sanitized process-exit failure in the decoded prompt response", async () => {
        const fixture = createWireFixture({
            exitCode: 1,
            stderr: "secret process stderr must stay server-side",
        });
        await fixture.initialize();
        const sessionState = createTestSessionState({
            sessionId: "wire-process-exit",
            account: {type: "apiKey"},
        });
        vi.spyOn(fixture.server, "getSessionState").mockReturnValue(sessionState);
        vi.spyOn(fixture.appServer, "turnStart").mockRejectedValue(
            new Error("raw transport rejection must not cross ACP"),
        );

        const response = await fixture.client.prompt({
            sessionId: sessionState.sessionId,
            prompt: [{type: "text", text: "trigger process failure"}],
        });

        expect(response).toMatchObject({
            stopReason: "end_turn",
            _meta: {
                jetbrains: {
                    air: {
                        version: 1,
                        sessionFailure: {
                            category: "transport_lost",
                            safeMessage: "Connection to Codex was lost.",
                            retryable: true,
                            actions: ["reconnect", "retry"],
                        },
                    },
                },
            },
        });
        expect(JSON.stringify(response)).not.toContain("secret process stderr");
        expect(JSON.stringify(response)).not.toContain("raw transport rejection");
        expect(fixture.updates).toEqual([]);
    });

    it("keeps the legacy process-exit rejection when the capability is absent", async () => {
        const fixture = createWireFixture({
            exitCode: 1,
            stderr: "legacy process stderr",
        });
        await fixture.initialize({});
        const sessionState = createTestSessionState({
            sessionId: "wire-legacy-process-exit",
            account: {type: "apiKey"},
        });
        vi.spyOn(fixture.server, "getSessionState").mockReturnValue(sessionState);
        vi.spyOn(fixture.appServer, "turnStart").mockRejectedValue(new Error("transport closed"));

        await expect(fixture.client.prompt({
            sessionId: sessionState.sessionId,
            prompt: [{type: "text", text: "keep legacy rejection"}],
        })).rejects.toThrow("Codex process has exited with code 1:\nlegacy process stderr");
        expect(fixture.updates).toEqual([]);
    });

    it("delivers an idle terminal error as a decoded session update", async () => {
        const fixture = createWireFixture();
        await fixture.initialize();
        const sessionState = createTestSessionState({
            sessionId: "wire-idle-error",
            account: {type: "apiKey"},
        });
        vi.spyOn(fixture.server, "getSessionState").mockReturnValue(sessionState);
        vi.spyOn(fixture.appServer, "turnStart").mockResolvedValue({
            turn: createTurn("inProgress"),
        });
        vi.spyOn(fixture.appServer, "awaitTurnCompleted").mockResolvedValue({
            threadId: sessionState.sessionId,
            turn: createTurn("completed"),
        });

        await fixture.client.prompt({
            sessionId: sessionState.sessionId,
            prompt: [{type: "text", text: "complete before late error"}],
        });
        fixture.updates.splice(0);

        fixture.sendServerNotification({
            method: "error",
            params: {
                threadId: sessionState.sessionId,
                turnId: "turn-id",
                willRetry: false,
                error: {
                    message: "raw idle provider detail",
                    codexErrorInfo: "serverOverloaded",
                    additionalDetails: "secret idle detail",
                },
            },
        });
        await fixture.codexClient.waitForSessionNotifications(sessionState.sessionId);
        await vi.waitFor(() => expect(fixture.updates).toHaveLength(1));

        expect(fixture.updates[0]).toMatchObject({
            sessionId: sessionState.sessionId,
            update: {
                sessionUpdate: "session_info_update",
                _meta: {
                    jetbrains: {
                        air: {
                            sessionFailure: {
                                id: expect.stringMatching(/^wire-idle-error:error:[0-9a-f-]+$/),
                                category: "overloaded",
                                safeMessage: "Codex is temporarily overloaded.",
                            },
                        },
                    },
                },
            },
        });
        const wireFailure = (fixture.updates[0]!.update._meta as {
            jetbrains: {air: {sessionFailure: Record<string, unknown>}};
        }).jetbrains.air.sessionFailure;
        expect(wireFailure).not.toHaveProperty("turnId");
        expect(JSON.stringify(fixture.updates)).not.toContain("raw idle provider detail");
        expect(JSON.stringify(fixture.updates)).not.toContain("secret idle detail");
    });
});

function createWireFixture(options: {exitCode?: number | null; stderr?: string} = {}) {
    const mockConnections = createMockConnections();
    const appServer = new CodexAppServerClient(mockConnections.mockCodexConnection);
    const codexClient = new CodexAcpClient(appServer);
    vi.spyOn(appServer, "initialize").mockResolvedValue({codexHome: null} as never);

    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
    const updates: acp.SessionNotification[] = [];
    let server!: CodexAcpServer;
    const client = new acp.ClientSideConnection(
        () => ({
            requestPermission: () => ({outcome: {outcome: "cancelled" as const}}),
            sessionUpdate: (params: acp.SessionNotification) => {
                updates.push(params);
            },
        }),
        acp.ndJsonStream(clientToAgent.writable, agentToClient.readable),
    );
    new acp.AgentSideConnection(
        (connection) => {
            server = new CodexAcpServer(
                connection,
                codexClient,
                undefined,
                () => options.exitCode ?? null,
                () => options.stderr ?? "",
            );
            return server;
        },
        acp.ndJsonStream(agentToClient.writable, clientToAgent.readable),
    );

    return {
        client,
        codexClient,
        appServer,
        updates,
        get server(): CodexAcpServer {
            return server;
        },
        async initialize(clientCapabilities: acp.ClientCapabilities = typedFailureCapabilities): Promise<void> {
            await client.initialize({
                protocolVersion: acp.PROTOCOL_VERSION,
                clientCapabilities,
            });
        },
        sendServerNotification(notification: Record<string, unknown>): void {
            const handler = mockConnections.getUnhandledNotificationHandler();
            if (!handler) throw new Error("App-server notification handler was not installed");
            handler(notification);
        },
    };
}

function createTurn(status: "inProgress" | "completed") {
    return {
        id: "turn-id",
        items: [],
        itemsView: "notLoaded" as const,
        status,
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
    };
}

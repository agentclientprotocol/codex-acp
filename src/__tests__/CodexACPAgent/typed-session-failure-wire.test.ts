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
    it("negotiates native subagents through AIR metadata across the SDK boundary", async () => {
        const fixture = createWireFixture();
        const response = await fixture.client.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {
                _meta: {
                    jetbrains: {
                        air: {version: 1, capabilities: ["nativeSubagentSessions"]},
                    },
                },
            },
        });

        expect((response.agentCapabilities!.sessionCapabilities as {subagents?: unknown}).subagents)
            .toEqual({});
        expect(response._meta).toMatchObject({
            jetbrains: {
                air: {
                    version: 1,
                    capabilities: expect.arrayContaining(["nativeSubagentSessions"]),
                },
            },
        });
    });

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
                            category: "connection",
                            severity: "error",
                            title: "Connection to Codex was lost.",
                            actions: ["retry", "new_session"],
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
                    message: "Codex is temporarily overloaded.",
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
                                id: "turn-id:error",
                                category: "service",
                                severity: "error",
                                title: "Codex is temporarily overloaded.",
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
        expect(wireFailure).not.toHaveProperty("safeMessage");
        expect(JSON.stringify(fixture.updates)).not.toContain("secret idle detail");
    });

    it("delivers an app-server warning as a typed advisory instead of assistant text", async () => {
        const fixture = await createIdleFixture("wire-warning");

        fixture.sendServerNotification({
            method: "warning",
            params: {
                threadId: fixture.sessionId,
                message: "Heads up: Long threads and multiple compactions can cause the model to be less accurate.",
            },
        });
        await fixture.codexClient.waitForSessionNotifications(fixture.sessionId);
        await vi.waitFor(() => expect(fixture.updates).toHaveLength(1));

        expect(fixture.updates[0]).toMatchObject({
            update: {
                sessionUpdate: "session_info_update",
                _meta: {
                    jetbrains: {
                        air: {
                            sessionFailure: {
                                id: expect.stringMatching(/^wire-warning:notice:[0-9a-f-]+:\d+$/),
                                category: "unknown",
                                severity: "warning",
                                revision: 1,
                                actions: [],
                                title:
                                    "Heads up: Long threads and multiple compactions can cause the model to be less accurate.",
                            },
                        },
                    },
                },
            },
        });
        // The whole point of the change: it must not arrive as an agent message chunk.
        expect(JSON.stringify(fixture.updates)).not.toContain("agent_message_chunk");
        expect(JSON.stringify(fixture.updates)).not.toContain("Warning: ");
    });

    it("folds a config warning's details into the advisory message", async () => {
        const fixture = await createIdleFixture("wire-config-warning");

        fixture.sendServerNotification({
            method: "configWarning",
            params: {summary: "Unknown key `foo`", details: "in ~/.codex/config.toml"},
        });
        await fixture.codexClient.waitForSessionNotifications(fixture.sessionId);
        await vi.waitFor(() => expect(fixture.updates).toHaveLength(1));

        expect(fixture.updates[0]).toMatchObject({
            update: {
                _meta: {
                    jetbrains: {
                        air: {
                            sessionFailure: {
                                category: "unknown",
                                severity: "warning",
                                title: "Unknown key `foo` — in ~/.codex/config.toml",
                            },
                        },
                    },
                },
            },
        });
    });

    it("surfaces a deprecation notice that used to be dropped outright", async () => {
        const fixture = await createIdleFixture("wire-deprecation");

        fixture.sendServerNotification({
            method: "deprecationNotice",
            params: {summary: "`--legacy-flag` is deprecated", details: "Use `--flag` instead."},
        });
        await fixture.codexClient.waitForSessionNotifications(fixture.sessionId);
        await vi.waitFor(() => expect(fixture.updates).toHaveLength(1));

        expect(fixture.updates[0]).toMatchObject({
            update: {
                sessionUpdate: "session_info_update",
                _meta: {
                    jetbrains: {
                        air: {
                            sessionFailure: {
                                category: "unknown",
                                severity: "warning",
                                title: "`--legacy-flag` is deprecated — Use `--flag` instead.",
                            },
                        },
                    },
                },
            },
        });
    });

    it("still drops a deprecation notice when the capability is absent", async () => {
        const fixture = await createIdleFixture("wire-legacy-deprecation", {});

        fixture.sendServerNotification({
            method: "deprecationNotice",
            params: {summary: "`--legacy-flag` is deprecated", details: null},
        });
        await fixture.codexClient.waitForSessionNotifications(fixture.sessionId);

        // This notification produced nothing before typed records existed; a client that did not
        // negotiate them must not suddenly start seeing it.
        expect(fixture.updates).toEqual([]);
    });

    it("uses details only when a notice is too large for the title", async () => {
        const fixture = await createIdleFixture("wire-long-warning");
        const details = "A".repeat(300);

        fixture.sendServerNotification({
            method: "configWarning",
            params: {summary: "Configuration requires attention", details},
        });
        await fixture.codexClient.waitForSessionNotifications(fixture.sessionId);
        await vi.waitFor(() => expect(fixture.updates).toHaveLength(1));

        expect(fixture.updates[0]!.update).toMatchObject({
            _meta: {jetbrains: {air: {sessionFailure: {
                title: "Configuration requires attention",
                details,
            }}}},
        });
    });

    it("keeps warnings as assistant text when the capability is absent", async () => {
        const fixture = await createIdleFixture("wire-legacy-warning", {});

        fixture.sendServerNotification({
            method: "warning",
            params: {threadId: fixture.sessionId, message: "legacy advisory"},
        });
        await fixture.codexClient.waitForSessionNotifications(fixture.sessionId);
        await vi.waitFor(() => expect(fixture.updates).toHaveLength(1));

        expect(fixture.updates[0]!.update).toMatchObject({
            sessionUpdate: "agent_message_chunk",
            content: {type: "text", text: "Warning: legacy advisory\n\n"},
        });
    });

    it("keeps an advisory in its own id namespace so it never bumps an active failure's revision", async () => {
        const fixture = await createIdleFixture("wire-mixed");

        fixture.sendServerNotification({
            method: "error",
            params: {
                threadId: fixture.sessionId,
                turnId: "turn-id",
                willRetry: false,
                error: {message: "provider blew up", codexErrorInfo: "serverOverloaded", additionalDetails: null},
            },
        });
        fixture.sendServerNotification({
            method: "warning",
            params: {threadId: fixture.sessionId, message: "unrelated advisory"},
        });
        await fixture.codexClient.waitForSessionNotifications(fixture.sessionId);
        await vi.waitFor(() => expect(fixture.updates).toHaveLength(2));

        const records = fixture.updates.map(update => (update.update._meta as {
            jetbrains: {air: {sessionFailure: {id: string; revision: number; severity?: string}}};
        }).jetbrains.air.sessionFailure);
        // Distinct ids, each starting its own revision sequence at 1.
        expect(records[0]).toMatchObject({revision: 1, category: "service", severity: "error"});
        expect(records[1]).toMatchObject({revision: 1, category: "unknown", severity: "warning"});
        expect(records[0]!.id).not.toEqual(records[1]!.id);
    });

    it("reuses id and advances revision for a repeated warning", async () => {
        const fixture = await createIdleFixture("wire-repeated-warning");
        const notification = {
            method: "warning" as const,
            params: {threadId: fixture.sessionId, message: "Same warning"},
        };

        fixture.sendServerNotification(notification);
        fixture.sendServerNotification(notification);
        await fixture.codexClient.waitForSessionNotifications(fixture.sessionId);
        await vi.waitFor(() => expect(fixture.updates).toHaveLength(2));

        const records = fixture.updates.map(update => (update.update._meta as {
            jetbrains: {air: {sessionFailure: {id: string; revision: number}}};
        }).jetbrains.air.sessionFailure);
        expect(records[1]!.id).toBe(records[0]!.id);
        expect(records.map(record => record.revision)).toEqual([1, 2]);
    });

    it("uses a new id when the same warning occurs again after another incident", async () => {
        const fixture = await createIdleFixture("wire-recurring-warning");

        for (const message of ["Recurring warning", "Different warning", "Recurring warning"]) {
            fixture.sendServerNotification({
                method: "warning",
                params: {threadId: fixture.sessionId, message},
            });
        }
        await fixture.codexClient.waitForSessionNotifications(fixture.sessionId);
        await vi.waitFor(() => expect(fixture.updates).toHaveLength(3));

        const records = fixture.updates.map(update => (update.update._meta as {
            jetbrains: {air: {sessionFailure: {id: string; revision: number}}};
        }).jetbrains.air.sessionFailure);
        expect(records.map(record => record.revision)).toEqual([1, 1, 1]);
        expect(records[2]!.id).not.toBe(records[0]!.id);
    });

    it("updates one late retry incident from warning attempts to terminal error", async () => {
        const fixture = await createIdleFixture("wire-late-retry-chain");
        const error = {
            message: "Connection to Codex was lost.",
            codexErrorInfo: {responseStreamDisconnected: {httpStatusCode: null}},
            additionalDetails: null,
        };

        for (const [willRetry, message] of [
            [true, "Reconnecting to Codex, attempt 1 of 2."],
            [true, "Reconnecting to Codex, attempt 2 of 2."],
            [false, "Connection to Codex was lost after 2 attempts."],
        ] as const) {
            fixture.sendServerNotification({
                method: "error",
                params: {threadId: fixture.sessionId, turnId: "turn-id", willRetry, error: {...error, message}},
            });
        }
        await fixture.codexClient.waitForSessionNotifications(fixture.sessionId);
        await vi.waitFor(() => expect(fixture.updates).toHaveLength(3));

        const records = fixture.updates.map(update => (update.update._meta as {
            jetbrains: {air: {sessionFailure: {id: string; revision: number; severity: string; actions: string[]}}};
        }).jetbrains.air.sessionFailure);
        expect(new Set(records.map(record => record.id)).size).toBe(1);
        expect(records.map(record => record.revision)).toEqual([1, 2, 3]);
        expect(records.map(record => record.severity)).toEqual(["warning", "warning", "error"]);
        expect(records.slice(0, 2).every(record => record.actions.length === 0)).toBe(true);

        fixture.sendServerNotification({
            method: "error",
            params: {threadId: fixture.sessionId, turnId: "turn-id", willRetry: false, error},
        });
        await fixture.codexClient.waitForSessionNotifications(fixture.sessionId);
        await vi.waitFor(() => expect(fixture.updates).toHaveLength(4));
        const next = (fixture.updates[3]!.update._meta as {
            jetbrains: {air: {sessionFailure: {id: string; revision: number}}};
        }).jetbrains.air.sessionFailure;
        expect(next.id).toBe(records[0]!.id);
        expect(next.revision).toBe(4);
    });
});

/** A fixture whose session already completed a turn, so notifications route to a live event handler. */
async function createIdleFixture(
    sessionId: string,
    clientCapabilities: acp.ClientCapabilities = typedFailureCapabilities,
) {
    const fixture = createWireFixture();
    await fixture.initialize(clientCapabilities);
    const sessionState = createTestSessionState({sessionId, account: {type: "apiKey"}});
    vi.spyOn(fixture.server, "getSessionState").mockReturnValue(sessionState);
    vi.spyOn(fixture.appServer, "turnStart").mockResolvedValue({turn: createTurn("inProgress")});
    vi.spyOn(fixture.appServer, "awaitTurnCompleted").mockResolvedValue({
        threadId: sessionId,
        turn: createTurn("completed"),
    });

    await fixture.client.prompt({
        sessionId,
        prompt: [{type: "text", text: "settle the session"}],
    });
    fixture.updates.splice(0);

    return {...fixture, sessionId};
}

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

import * as acp from "@agentclientprotocol/sdk";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {createCodexMockTestFixture, createTestSessionState, type CodexMockTestFixture} from "../acp-test-utils";
import {TURN_CONFIGURATION_RECEIPT_ENV} from "../../TurnConfigurationReceipt";

describe("PromptResponse turn configuration receipt", () => {
    let fixture: CodexMockTestFixture;
    const sessionId = "test-session-id";

    beforeEach(async () => {
        fixture = createCodexMockTestFixture();
        vi.clearAllMocks();
        await declareReceipt(true);
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    async function declareReceipt(declared: boolean): Promise<void> {
        await fixture.getCodexAcpAgent().initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: declared ? {_meta: {codex: {turnConfiguration: true}}} : {},
        });
    }

    async function promptOnce(): Promise<acp.PromptResponse> {
        const agent = fixture.getCodexAcpAgent();
        const appServer = fixture.getCodexAppServerClient();
        const turn = {id: "turn-id", items: [], status: "inProgress" as const, error: null};

        vi.spyOn(appServer, "turnStart").mockResolvedValue({turn} as never);
        vi.spyOn(appServer, "awaitTurnCompleted").mockResolvedValue({
            threadId: sessionId,
            turn: {...turn, status: "completed" as const},
        } as never);
        vi.spyOn(agent, "getSessionState").mockReturnValue(createTestSessionState({
            sessionId,
            currentModelId: "gpt-5.6-terra[medium]",
        }));

        return await agent.prompt({
            sessionId,
            prompt: [{type: "text", text: "test prompt"}],
        });
    }

    it("reports requested model settings, observed thread settings, and reroutes", async () => {
        const agent = fixture.getCodexAcpAgent();
        const appServer = fixture.getCodexAppServerClient();
        const turn = {id: "turn-id", items: [], status: "inProgress" as const, error: null};

        const turnStart = vi.spyOn(appServer, "turnStart").mockResolvedValue({turn} as never);
        vi.spyOn(appServer, "awaitTurnCompleted").mockImplementation(async () => {
            fixture.sendServerNotification({
                method: "thread/settings/updated",
                params: {
                    threadId: sessionId,
                    threadSettings: {
                        cwd: "/test/cwd",
                        approvalPolicy: "on-request",
                        approvalsReviewer: "user",
                        sandboxPolicy: {type: "workspaceWrite", writableRoots: [], networkAccess: false},
                        activePermissionProfile: null,
                        model: "gpt-5.6-sol",
                        modelProvider: "openai",
                        serviceTier: null,
                        effort: "xhigh",
                        summary: "auto",
                        collaborationMode: {mode: "default", settings: {}},
                        personality: null,
                    },
                },
            });
            fixture.sendServerNotification({
                method: "model/rerouted",
                params: {
                    threadId: sessionId,
                    turnId: turn.id,
                    fromModel: "gpt-5.6-sol",
                    toModel: "gpt-5.6-terra",
                    reason: "highRiskCyberActivity",
                },
            });
            return {
                threadId: sessionId,
                turn: {...turn, status: "completed" as const},
            } as never;
        });
        vi.spyOn(agent, "getSessionState").mockReturnValue(createTestSessionState({
            sessionId,
            currentModelId: "gpt-5.6-sol[xhigh]",
        }));

        const response = await agent.prompt({
            sessionId,
            prompt: [{type: "text", text: "test prompt"}],
        });

        expect(turnStart).toHaveBeenCalledWith(expect.objectContaining({
            model: "gpt-5.6-sol",
            effort: "xhigh",
        }));
        await expect(`${JSON.stringify(response._meta?.["codex"], null, 2)}\n`).toMatchFileSnapshot(
            "data/turn-configuration-receipt.json",
        );
    });

    it("marks thread settings unavailable when the app server did not report them", async () => {
        const agent = fixture.getCodexAcpAgent();
        const appServer = fixture.getCodexAppServerClient();
        const turn = {id: "turn-id", items: [], status: "inProgress" as const, error: null};

        vi.spyOn(appServer, "turnStart").mockResolvedValue({turn} as never);
        vi.spyOn(appServer, "awaitTurnCompleted").mockResolvedValue({
            threadId: sessionId,
            turn: {...turn, status: "completed" as const},
        } as never);
        vi.spyOn(agent, "getSessionState").mockReturnValue(createTestSessionState({
            sessionId,
            currentModelId: "gpt-5.6-terra[medium]",
        }));

        const response = await agent.prompt({
            sessionId,
            prompt: [{type: "text", text: "test prompt"}],
        });

        expect(response._meta?.["codex"]).toEqual({
            turnConfiguration: {
                version: 1,
                turns: [{
                    threadId: sessionId,
                    turnId: turn.id,
                    requested: {model: "gpt-5.6-terra", effort: "medium"},
                    threadSettings: null,
                    modelReroutes: [],
                }],
            },
        });
    });

    it("marks command-started turns as having no explicit requested configuration", async () => {
        const agent = fixture.getCodexAcpAgent();
        const appServer = fixture.getCodexAppServerClient();
        const reviewThreadId = "review-thread-id";
        const turn = {id: "review-turn-id", items: [], status: "inProgress" as const, error: null};

        vi.spyOn(appServer, "reviewStart").mockResolvedValue({
            reviewThreadId,
            turn,
        } as never);
        vi.spyOn(appServer, "awaitTurnCompleted").mockResolvedValue({
            threadId: reviewThreadId,
            turn: {...turn, status: "completed" as const},
        } as never);
        vi.spyOn(agent, "getSessionState").mockReturnValue(createTestSessionState({
            sessionId,
            currentModelId: "gpt-5.6-terra[medium]",
        }));

        const response = await agent.prompt({
            sessionId,
            prompt: [{type: "text", text: "/review"}],
        });

        expect(response._meta?.["codex"]).toEqual({
            turnConfiguration: {
                version: 1,
                turns: [{
                    threadId: reviewThreadId,
                    turnId: turn.id,
                    requested: null,
                    threadSettings: null,
                    modelReroutes: [],
                }],
            },
        });
    });

    it("sends no receipt to a client that did not declare it", async () => {
        await declareReceipt(false);

        const response = await promptOnce();

        expect(response._meta).toEqual({quota: {token_count: null, model_usage: []}});
    });

    it.each(["true", "1"])("sends the receipt to every client when the environment sets %s", async (value) => {
        vi.stubEnv(TURN_CONFIGURATION_RECEIPT_ENV, value);
        await declareReceipt(false);

        const response = await promptOnce();

        expect(response._meta?.["codex"]).toMatchObject({
            turnConfiguration: {version: 1, turns: [{turnId: "turn-id"}]},
        });
    });

    it.each(["false", "0"])("sends no receipt to a declaring client when the environment sets %s", async (value) => {
        vi.stubEnv(TURN_CONFIGURATION_RECEIPT_ENV, value);

        const response = await promptOnce();

        expect(response._meta).toEqual({quota: {token_count: null, model_usage: []}});
    });
});

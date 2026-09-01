import {beforeEach, describe, expect, it, vi} from "vitest";
import {createCodexMockTestFixture, createTestSessionState, type CodexMockTestFixture} from "../acp-test-utils";

describe("PromptResponse turn configuration receipt", () => {
    let fixture: CodexMockTestFixture;
    const sessionId = "test-session-id";

    beforeEach(() => {
        fixture = createCodexMockTestFixture();
        vi.clearAllMocks();
    });

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
});

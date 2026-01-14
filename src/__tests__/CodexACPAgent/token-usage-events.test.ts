import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionState } from '../../CodexAcpServer';
import type { ServerNotification } from '../../app-server';
import { createCodexMockTestFixture, createTestSessionState, type CodexMockTestFixture } from '../acp-test-utils';
import { AgentMode } from "../../AgentMode";
import type { TokenUsageBreakdown } from '../../app-server/v2';

describe('Token Usage Events', () => {
    let mockFixture: CodexMockTestFixture;
    const sessionId = 'test-session-id';

    beforeEach(() => {
        mockFixture = createCodexMockTestFixture();
        vi.clearAllMocks();
    });


    describe('PromptResponse token_count', () => {
        function setupPromptWithTokenUsage(notifications: ServerNotification[], turnStatus: string = "completed") {
            const codexAcpAgent = mockFixture.getCodexAcpAgent();

            mockFixture.getCodexAppServerClient().turnStart = vi.fn().mockResolvedValue({
                turn: { id: "turn-id", items: [], status: "inProgress", error: null }
            });

            // awaitTurnCompleted sends notifications before resolving
            mockFixture.getCodexAppServerClient().awaitTurnCompleted = vi.fn().mockImplementation(async () => {
                // Send notifications during turn (after handler is registered)
                for (const notification of notifications) {
                    mockFixture.sendServerNotification(notification);
                }
                return {
                    threadId: sessionId,
                    turn: { id: "turn-id", items: [], status: turnStatus, error: null }
                };
            });

            const sessionState: SessionState = createTestSessionState({
                sessionMetadata: {
                    sessionId,
                    currentModelId: 'model-id[medium]',
                    models: [],
                    agentMode: AgentMode.DEFAULT_AGENT_MODE
                },
            });
            vi.spyOn(codexAcpAgent, 'getSessionState').mockReturnValue(sessionState);

            return codexAcpAgent;
        }

        it('should include token_count in PromptResponse on end_turn', async () => {
            const tokenUsageNotification: ServerNotification = {
                method: 'thread/tokenUsage/updated',
                params: {
                    threadId: sessionId,
                    turnId: 'turn-id',
                    tokenUsage: {
                        total: {
                            totalTokens: 5000,
                            inputTokens: 4000,
                            cachedInputTokens: 1000,
                            outputTokens: 900,
                            reasoningOutputTokens: 100,
                        },
                        last: {
                            totalTokens: 2500,
                            inputTokens: 2000,
                            cachedInputTokens: 500,
                            outputTokens: 450,
                            reasoningOutputTokens: 50,
                        },
                        modelContextWindow: 128000,
                    },
                },
            };

            const codexAcpAgent = setupPromptWithTokenUsage([tokenUsageNotification]);

            const response = await codexAcpAgent.prompt({
                sessionId,
                prompt: [{ type: 'text', text: 'test prompt' }],
            });

            await expect(JSON.stringify(response, null, 2)).toMatchFileSnapshot(
                'data/token-usage-end-turn.json'
            );
        });

        it('should include token_count in PromptResponse on cancelled', async () => {
            const tokenUsageNotification: ServerNotification = {
                method: 'thread/tokenUsage/updated',
                params: {
                    threadId: sessionId,
                    turnId: 'turn-id',
                    tokenUsage: {
                        total: {
                            totalTokens: 3000,
                            inputTokens: 2500,
                            cachedInputTokens: 0,
                            outputTokens: 500,
                            reasoningOutputTokens: 0,
                        },
                        last: {
                            totalTokens: 1500,
                            inputTokens: 1200,
                            cachedInputTokens: 0,
                            outputTokens: 300,
                            reasoningOutputTokens: 0,
                        },
                        modelContextWindow: 128000,
                    },
                },
            };

            const codexAcpAgent = setupPromptWithTokenUsage([tokenUsageNotification], "interrupted");

            const response = await codexAcpAgent.prompt({
                sessionId,
                prompt: [{ type: 'text', text: 'test prompt' }],
            });

            await expect(JSON.stringify(response, null, 2)).toMatchFileSnapshot(
                'data/token-usage-cancelled.json'
            );
        });

        it('should return null token_count when no token usage event received', async () => {
            const codexAcpAgent = setupPromptWithTokenUsage([]);

            const response = await codexAcpAgent.prompt({
                sessionId,
                prompt: [{ type: 'text', text: 'test prompt' }],
            });

            await expect(JSON.stringify(response, null, 2)).toMatchFileSnapshot(
                'data/token-usage-null.json'
            );
        });

        it('should use last token usage from multiple updates', async () => {
            const notifications: ServerNotification[] = [
                {
                    method: 'thread/tokenUsage/updated',
                    params: {
                        threadId: sessionId,
                        turnId: 'turn-id',
                        tokenUsage: {
                            total: { totalTokens: 1000, inputTokens: 800, cachedInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
                            last: { totalTokens: 1000, inputTokens: 800, cachedInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
                            modelContextWindow: 128000,
                        },
                    },
                },
                {
                    method: 'thread/tokenUsage/updated',
                    params: {
                        threadId: sessionId,
                        turnId: 'turn-id',
                        tokenUsage: {
                            total: { totalTokens: 2000, inputTokens: 1600, cachedInputTokens: 0, outputTokens: 400, reasoningOutputTokens: 0 },
                            last: { totalTokens: 1000, inputTokens: 800, cachedInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
                            modelContextWindow: 128000,
                        },
                    },
                },
                {
                    method: 'thread/tokenUsage/updated',
                    params: {
                        threadId: sessionId,
                        turnId: 'turn-id',
                        tokenUsage: {
                            total: { totalTokens: 3500, inputTokens: 2800, cachedInputTokens: 500, outputTokens: 600, reasoningOutputTokens: 100 },
                            last: { totalTokens: 1500, inputTokens: 1200, cachedInputTokens: 500, outputTokens: 200, reasoningOutputTokens: 100 },
                            modelContextWindow: 128000,
                        },
                    },
                },
            ];

            const codexAcpAgent = setupPromptWithTokenUsage(notifications);

            const response = await codexAcpAgent.prompt({
                sessionId,
                prompt: [{ type: 'text', text: 'test prompt' }],
            });

            await expect(JSON.stringify(response, null, 2)).toMatchFileSnapshot(
                'data/token-usage-multiple-updates.json'
            );
        });
    });
});

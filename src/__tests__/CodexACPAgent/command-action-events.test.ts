import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionState } from '../../CodexAcpServer';
import type { ServerNotification } from '../../app-server';
import { createCodexMockTestFixture, type CodexMockTestFixture } from '../acp-test-utils';
import {AgentMode} from "../../AgentMode";

describe('CodexEventHandler - command action events', () => {
    let mockFixture: CodexMockTestFixture;
    const sessionId = 'test-session-id';

    beforeEach(() => {
        mockFixture = createCodexMockTestFixture();
        vi.clearAllMocks();
    });

    const sessionState: SessionState = {
        currentTurnId: null,
        sessionMetadata: {
            sessionId,
            currentModelId: 'model-id',
            models: [],
            agentMode: AgentMode.DEFAULT_AGENT_MODE
        },
    };

    async function setupAndSendNotifications(notifications: ServerNotification[]) {
        const codexAcpAgent = mockFixture.getCodexAcpAgent();

        mockFixture.getCodexAppServerClient().turnStart = vi.fn().mockResolvedValue({
            turn: { id: "turn-id", items: [], status: "inProgress", error: null }
        });
        mockFixture.getCodexAppServerClient().awaitTurnCompleted = vi.fn().mockResolvedValue({
            threadId: sessionId,
            turn: { id: "turn-id", items: [], status: "completed", error: null }
        });

        vi.spyOn(codexAcpAgent, 'getSessionState').mockReturnValue(sessionState);

        await codexAcpAgent.prompt({
            sessionId,
            prompt: [{ type: 'text', text: 'test prompt' }],
        });

        mockFixture.clearAcpConnectionDump();

        for (const notification of notifications) {
            mockFixture.sendServerNotification(notification);
        }

        await vi.waitFor(() => {
            const dump = mockFixture.getAcpConnectionDump([]);
            expect(dump.length).toBeGreaterThan(0);
        });
    }

    it('should handle list files command with explicit path', async () => {
        const listFilesNotification: ServerNotification = {
            method: 'item/started',
            params: {
                threadId: 'thread-1',
                turnId: 'turn-1',
                item: {
                    type: 'commandExecution',
                    id: 'command-list-path',
                    command: 'ls /test/project',
                    cwd: '/test/project',
                    processId: null,
                    status: 'inProgress',
                    commandActions: [
                        {
                            type: 'listFiles',
                            command: 'ls /test/project',
                            path: '/test/project',
                        },
                    ],
                    aggregatedOutput: null,
                    exitCode: null,
                    durationMs: null,
                },
            },
        };

        await setupAndSendNotifications([listFilesNotification]);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            'data/command-list-files-with-path.json'
        );
    });

    it('should handle list files command without a path', async () => {
        const listFilesNotification: ServerNotification = {
            method: 'item/started',
            params: {
                threadId: 'thread-1',
                turnId: 'turn-1',
                item: {
                    type: 'commandExecution',
                    id: 'command-list-no-path',
                    command: 'ls',
                    cwd: '/test/project',
                    processId: null,
                    status: 'completed',
                    commandActions: [
                        {
                            type: 'listFiles',
                            command: 'ls',
                            path: null,
                        },
                    ],
                    aggregatedOutput: null,
                    exitCode: 0,
                    durationMs: 10,
                },
            },
        };

        await setupAndSendNotifications([listFilesNotification]);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            'data/command-list-files-without-path.json'
        );
    });
});

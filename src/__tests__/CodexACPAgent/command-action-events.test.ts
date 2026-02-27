import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionState } from '../../CodexAcpServer';
import type { ServerNotification } from '../../app-server';
import { createCodexMockTestFixture, createTestSessionState, type CodexMockTestFixture } from '../acp-test-utils';
import {AgentMode} from "../../AgentMode";

describe('CodexEventHandler - command action events', () => {
    let mockFixture: CodexMockTestFixture;
    const sessionId = 'test-session-id';

    beforeEach(() => {
        mockFixture = createCodexMockTestFixture();
        vi.clearAllMocks();
    });

    const sessionState: SessionState = createTestSessionState({
        sessionId,
        currentModelId: 'model-id[effort]',
        agentMode: AgentMode.DEFAULT_AGENT_MODE
    });

    async function setupAndSendNotifications(notifications: ServerNotification[]) {
        const codexAcpAgent = mockFixture.getCodexAcpAgent();

        mockFixture.getCodexAppServerClient().turnStart = vi.fn().mockResolvedValue({
            turn: { id: "turn-id", items: [], status: "inProgress", error: null }
        });
        mockFixture.getCodexAppServerClient().awaitTurnCompletedForThread = vi.fn().mockResolvedValue({
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
                threadId: sessionId,
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
                threadId: sessionId,
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

    it('should handle search command with query and path', async () => {
        const searchNotification: ServerNotification = {
            method: 'item/started',
            params: {
                threadId: sessionId,
                turnId: 'turn-1',
                item: {
                    type: 'commandExecution',
                    id: 'command-search-query-path',
                    command: 'rg "Service" src',
                    cwd: '/test/project',
                    processId: null,
                    status: 'inProgress',
                    commandActions: [
                        {
                            type: 'search',
                            command: 'rg Service src',
                            query: 'Service',
                            path: 'src',
                        },
                    ],
                    aggregatedOutput: null,
                    exitCode: null,
                    durationMs: null,
                },
            },
        };

        await setupAndSendNotifications([searchNotification]);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            'data/command-search-with-query-and-path.json'
        );
    });

    it('should handle search command with only query', async () => {
        const searchNotification: ServerNotification = {
            method: 'item/started',
            params: {
                threadId: sessionId,
                turnId: 'turn-1',
                item: {
                    type: 'commandExecution',
                    id: 'command-search-query-only',
                    command: 'rg "Service"',
                    cwd: '/test/project',
                    processId: null,
                    status: 'inProgress',
                    commandActions: [
                        {
                            type: 'search',
                            command: 'rg Service',
                            query: 'Service',
                            path: null,
                        },
                    ],
                    aggregatedOutput: null,
                    exitCode: null,
                    durationMs: null,
                },
            },
        };

        await setupAndSendNotifications([searchNotification]);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            'data/command-search-with-query-only.json'
        );
    });

    it('should handle search command with only path (file glob search)', async () => {
        const searchNotification: ServerNotification = {
            method: 'item/started',
            params: {
                threadId: sessionId,
                turnId: 'turn-1',
                item: {
                    type: 'commandExecution',
                    id: 'command-search-path-only',
                    command: 'rg --files -g "*service*"',
                    cwd: '/test/project',
                    processId: null,
                    status: 'inProgress',
                    commandActions: [
                        {
                            type: 'search',
                            command: "rg --files -g '*service*'",
                            query: null,
                            path: '*service*',
                        },
                    ],
                    aggregatedOutput: null,
                    exitCode: null,
                    durationMs: null,
                },
            },
        };

        await setupAndSendNotifications([searchNotification]);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            'data/command-search-with-path-only.json'
        );
    });

    it('should handle search command with neither query nor path', async () => {
        const searchNotification: ServerNotification = {
            method: 'item/started',
            params: {
                threadId: sessionId,
                turnId: 'turn-1',
                item: {
                    type: 'commandExecution',
                    id: 'command-search-no-query-no-path',
                    command: 'rg',
                    cwd: '/test/project',
                    processId: null,
                    status: 'inProgress',
                    commandActions: [
                        {
                            type: 'search',
                            command: 'rg',
                            query: null,
                            path: null,
                        },
                    ],
                    aggregatedOutput: null,
                    exitCode: null,
                    durationMs: null,
                },
            },
        };

        await setupAndSendNotifications([searchNotification]);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            'data/command-search-no-query-no-path.json'
        );
    });

    it('should handle mcp tools', async () => {
        const searchNotification: ServerNotification = {
            method: 'item/started',
            params: {
                threadId: sessionId,
                turnId: 'turn-1',
                item: {
                    type: "mcpToolCall",
                    id: "call-id",
                    server: "server-name",
                    tool: "tool-name",
                    status: "inProgress",
                    arguments: { argument: "example"},
                    result: null,
                    error: null,
                    durationMs: null,
                },
            },
        };

        await setupAndSendNotifications([searchNotification]);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            'data/mcp-tool-in-progress.json'
        );
    });
});

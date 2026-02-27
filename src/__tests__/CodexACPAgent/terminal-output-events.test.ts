import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionState } from '../../CodexAcpServer';
import type { ServerNotification } from '../../app-server';
import { createCodexMockTestFixture, createTestSessionState, type CodexMockTestFixture } from '../acp-test-utils';
import { AgentMode } from "../../AgentMode";

describe('CodexEventHandler - terminal output events', () => {
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

    it('should send terminal info when command execution starts', async () => {
        const commandStartNotification: ServerNotification = {
            method: 'item/started',
            params: {
                threadId: sessionId,
                turnId: 'turn-1',
                item: {
                    type: 'commandExecution',
                    id: 'command-123',
                    command: 'ls -la',
                    cwd: '/test/project',
                    processId: null,
                    status: 'inProgress',
                    commandActions: [],
                    aggregatedOutput: null,
                    exitCode: null,
                    durationMs: null,
                },
            },
        };

        await setupAndSendNotifications([commandStartNotification]);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            'data/terminal-command-started.json'
        );
    });

    it.each([
        { command: '/bin/zsh -c npm install', expected: 'npm install' },
        { command: '/bin/bash -lc npm install', expected: 'npm install' },
        { command: 'zsh npm install', expected: 'npm install' },
        { command: 'sh -c ls -la', expected: 'ls -la' },
        { command: 'npm install', expected: 'npm install' },
        { command: "/bin/bash -lc './tests.cmd -Darg=value'", expected: './tests.cmd -Darg=value' },
        { command: "/bin/zsh -c 'echo hello'", expected: 'echo hello' },
    ])('should strip shell prefix from "$command"', async ({ command, expected }) => {
        const commandStartNotification: ServerNotification = {
            method: 'item/started',
            params: {
                threadId: sessionId,
                turnId: 'turn-1',
                item: {
                    type: 'commandExecution',
                    id: 'command-shell-prefix',
                    command,
                    cwd: '/test/project',
                    processId: null,
                    status: 'inProgress',
                    commandActions: [],
                    aggregatedOutput: null,
                    exitCode: null,
                    durationMs: null,
                },
            },
        };

        await setupAndSendNotifications([commandStartNotification]);

        const dump = mockFixture.getAcpConnectionDump([]);
        const parsed = JSON.parse(dump);
        expect(parsed.args[0].update.title).toBe(expected);
        expect(parsed.args[0].update.rawInput.command).toBe(command);
    });

    it('should stream terminal output delta', async () => {
        const outputDeltaNotification: ServerNotification = {
            method: 'item/commandExecution/outputDelta',
            params: {
                threadId: sessionId,
                turnId: 'turn-1',
                itemId: 'command-123',
                delta: 'file1.txt\nfile2.txt\n',
            },
        };

        await setupAndSendNotifications([outputDeltaNotification]);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            'data/terminal-output-delta.json'
        );
    });

    it('should send formatted output on command completion', async () => {
        const commandCompletedNotification: ServerNotification = {
            method: 'item/completed',
            params: {
                threadId: sessionId,
                turnId: 'turn-1',
                item: {
                    type: 'commandExecution',
                    id: 'command-123',
                    command: 'ls -la',
                    cwd: '/test/project',
                    processId: 'pid-456',
                    status: 'completed',
                    commandActions: [],
                    aggregatedOutput: 'file1.txt\nfile2.txt\nfile3.txt\n',
                    exitCode: 0,
                    durationMs: 150,
                },
            },
        };

        await setupAndSendNotifications([commandCompletedNotification]);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            'data/terminal-command-completed.json'
        );
    });

    it('should handle failed command completion', async () => {
        const commandFailedNotification: ServerNotification = {
            method: 'item/completed',
            params: {
                threadId: sessionId,
                turnId: 'turn-1',
                item: {
                    type: 'commandExecution',
                    id: 'command-456',
                    command: 'cat nonexistent.txt',
                    cwd: '/test/project',
                    processId: 'pid-789',
                    status: 'failed',
                    commandActions: [],
                    aggregatedOutput: 'cat: nonexistent.txt: No such file or directory',
                    exitCode: 1,
                    durationMs: 50,
                },
            },
        };

        await setupAndSendNotifications([commandFailedNotification]);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            'data/terminal-command-failed.json'
        );
    });

    it('should handle full terminal output flow: start -> delta -> complete', async () => {
        const commandStartNotification: ServerNotification = {
            method: 'item/started',
            params: {
                threadId: sessionId,
                turnId: 'turn-1',
                item: {
                    type: 'commandExecution',
                    id: 'command-flow',
                    command: 'echo hello',
                    cwd: '/test/project',
                    processId: null,
                    status: 'inProgress',
                    commandActions: [],
                    aggregatedOutput: null,
                    exitCode: null,
                    durationMs: null,
                },
            },
        };

        const outputDeltaNotification: ServerNotification = {
            method: 'item/commandExecution/outputDelta',
            params: {
                threadId: sessionId,
                turnId: 'turn-1',
                itemId: 'command-flow',
                delta: 'hello\n',
            },
        };

        const commandCompletedNotification: ServerNotification = {
            method: 'item/completed',
            params: {
                threadId: sessionId,
                turnId: 'turn-1',
                item: {
                    type: 'commandExecution',
                    id: 'command-flow',
                    command: 'echo hello',
                    cwd: '/test/project',
                    processId: 'pid-123',
                    status: 'completed',
                    commandActions: [],
                    aggregatedOutput: 'hello\n',
                    exitCode: 0,
                    durationMs: 10,
                },
            },
        };

        await setupAndSendNotifications([
            commandStartNotification,
            outputDeltaNotification,
            commandCompletedNotification
        ]);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            'data/terminal-full-flow.json'
        );
    });

    it('should accumulate terminal output across multiple deltas', async () => {
        const delta1: ServerNotification = {
            method: 'item/commandExecution/outputDelta',
            params: {
                threadId: sessionId,
                turnId: 'turn-1',
                itemId: 'command-accumulate',
                delta: 'line1\n',
            },
        };

        const delta2: ServerNotification = {
            method: 'item/commandExecution/outputDelta',
            params: {
                threadId: sessionId,
                turnId: 'turn-1',
                itemId: 'command-accumulate',
                delta: 'line2\n',
            },
        };

        const delta3: ServerNotification = {
            method: 'item/commandExecution/outputDelta',
            params: {
                threadId: sessionId,
                turnId: 'turn-1',
                itemId: 'command-accumulate',
                delta: 'line3\n',
            },
        };

        await setupAndSendNotifications([delta1, delta2, delta3]);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            'data/terminal-output-accumulated.json'
        );
    });
});

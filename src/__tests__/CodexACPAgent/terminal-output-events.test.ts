import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionState } from '../../CodexAcpServer';
import type { ServerNotification } from '../../app-server';
import { createCodexMockTestFixture, createTestSessionState, setupPromptAndSendNotifications, type CodexMockTestFixture } from '../acp-test-utils';
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

    it('should send terminal info when command execution starts', async () => {
        const commandStartNotification: ServerNotification = {
            method: 'item/started',
            params: {
                threadId: sessionId,
                turnId: 'turn-1',
                startedAtMs: 0,
                item: {
                    type: 'commandExecution',
                    id: 'command-123',
                    command: 'ls -la',
                    cwd: '/test/project',
                    processId: null,
                    source: 'agent',
                    status: 'inProgress',
                    commandActions: [],
                    aggregatedOutput: null,
                    exitCode: null,
                    durationMs: null,
                },
            },
        };

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, [commandStartNotification]);

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
                startedAtMs: 0,
                item: {
                    type: 'commandExecution',
                    id: 'command-shell-prefix',
                    command,
                    cwd: '/test/project',
                    processId: null,
                    source: 'agent',
                    status: 'inProgress',
                    commandActions: [],
                    aggregatedOutput: null,
                    exitCode: null,
                    durationMs: null,
                },
            },
        };

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, [commandStartNotification]);

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

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, [outputDeltaNotification]);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            'data/terminal-output-delta.json'
        );
    });

    it('should stream terminal interaction stdin as terminal output delta', async () => {
        const terminalInteractionNotification: ServerNotification = {
            method: 'item/commandExecution/terminalInteraction',
            params: {
                threadId: sessionId,
                turnId: 'turn-1',
                itemId: 'command-123',
                processId: 'pid-456',
                stdin: 'continue',
            },
        };

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, [terminalInteractionNotification]);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            'data/terminal-interaction-stdin.json'
        );
    });

    it('should send formatted output on command completion', async () => {
        const commandCompletedNotification: ServerNotification = {
            method: 'item/completed',
            params: {
                threadId: sessionId,
                turnId: 'turn-1',
                completedAtMs: 0,
                item: {
                    type: 'commandExecution',
                    id: 'command-123',
                    command: 'ls -la',
                    cwd: '/test/project',
                    processId: 'pid-456',
                    source: 'agent',
                    status: 'completed',
                    commandActions: [],
                    aggregatedOutput: 'file1.txt\nfile2.txt\nfile3.txt\n',
                    exitCode: 0,
                    durationMs: 150,
                },
            },
        };

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, [commandCompletedNotification]);

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
                completedAtMs: 0,
                item: {
                    type: 'commandExecution',
                    id: 'command-456',
                    command: 'cat nonexistent.txt',
                    cwd: '/test/project',
                    processId: 'pid-789',
                    source: 'agent',
                    status: 'failed',
                    commandActions: [],
                    aggregatedOutput: 'cat: nonexistent.txt: No such file or directory',
                    exitCode: 1,
                    durationMs: 50,
                },
            },
        };

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, [commandFailedNotification]);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            'data/terminal-command-failed.json'
        );
    });

    it('should send status update when dynamic tool call completes', async () => {
        const dynamicToolCompletedNotification: ServerNotification = {
            method: 'item/completed',
            params: {
                threadId: sessionId,
                turnId: 'turn-1',
                completedAtMs: 0,
                item: {
                    type: 'dynamicToolCall',
                    id: 'dyn-tool-123',
                    namespace: null,
                    tool: 'list_apps',
                    arguments: { includeDisabled: false },
                    status: 'completed',
                    contentItems: [{ type: "inputText", text: "Done" }],
                    success: true,
                    durationMs: 25,
                },
            },
        };

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, [dynamicToolCompletedNotification]);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            'data/dynamic-tool-completed.json'
        );
    });

    it('should handle full terminal output flow: start -> delta -> complete', async () => {
        const commandStartNotification: ServerNotification = {
            method: 'item/started',
            params: {
                threadId: sessionId,
                turnId: 'turn-1',
                startedAtMs: 0,
                item: {
                    type: 'commandExecution',
                    id: 'command-flow',
                    command: 'echo hello',
                    cwd: '/test/project',
                    processId: null,
                    source: 'agent',
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
                completedAtMs: 0,
                item: {
                    type: 'commandExecution',
                    id: 'command-flow',
                    command: 'echo hello',
                    cwd: '/test/project',
                    processId: 'pid-123',
                    source: 'agent',
                    status: 'completed',
                    commandActions: [],
                    aggregatedOutput: 'hello\n',
                    exitCode: 0,
                    durationMs: 10,
                },
            },
        };

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, [
            commandStartNotification,
            outputDeltaNotification,
            commandCompletedNotification
        ]);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            'data/terminal-full-flow.json'
        );
    });

    it('should use terminal_output meta when supported', async () => {
        const terminalOutputSessionState = createTestSessionState({
            sessionId,
            currentModelId: 'model-id[effort]',
            agentMode: AgentMode.DEFAULT_AGENT_MODE,
            terminalOutputMode: 'terminal_output',
        });
        const commandStartNotification: ServerNotification = {
            method: 'item/started',
            params: {
                threadId: sessionId,
                turnId: 'turn-1',
                startedAtMs: 0,
                item: {
                    type: 'commandExecution',
                    id: 'command-terminal-output',
                    command: 'python manage.py migrate',
                    cwd: '/test/project',
                    processId: null,
                    source: 'agent',
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
                itemId: 'command-terminal-output',
                delta: 'Applying migrations\n',
            },
        };
        const terminalInteractionNotification: ServerNotification = {
            method: 'item/commandExecution/terminalInteraction',
            params: {
                threadId: sessionId,
                turnId: 'turn-1',
                itemId: 'command-terminal-output',
                processId: 'pid-456',
                stdin: 'yes',
            },
        };
        const commandCompletedNotification: ServerNotification = {
            method: 'item/completed',
            params: {
                threadId: sessionId,
                turnId: 'turn-1',
                completedAtMs: 0,
                item: {
                    type: 'commandExecution',
                    id: 'command-terminal-output',
                    command: 'python manage.py migrate',
                    cwd: '/test/project',
                    processId: 'pid-456',
                    source: 'agent',
                    status: 'completed',
                    commandActions: [],
                    aggregatedOutput: 'Applying migrations\n\nyes\nDone\n',
                    exitCode: 0,
                    durationMs: 250,
                },
            },
        };

        await setupPromptAndSendNotifications(mockFixture, sessionId, terminalOutputSessionState, [
            commandStartNotification,
            outputDeltaNotification,
            terminalInteractionNotification,
            commandCompletedNotification
        ]);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            'data/terminal-output-meta-flow.json'
        );
    });

    it('should flush aggregated output when terminal_output command completes without deltas', async () => {
        const terminalOutputSessionState = createTestSessionState({
            sessionId,
            currentModelId: 'model-id[effort]',
            agentMode: AgentMode.DEFAULT_AGENT_MODE,
            terminalOutputMode: 'terminal_output',
        });
        const commandStartNotification: ServerNotification = {
            method: 'item/started',
            params: {
                threadId: sessionId,
                turnId: 'turn-1',
                startedAtMs: 0,
                item: {
                    type: 'commandExecution',
                    id: 'command-terminal-output-completion',
                    command: 'git status --short',
                    cwd: '/test/project',
                    processId: null,
                    source: 'agent',
                    status: 'inProgress',
                    commandActions: [],
                    aggregatedOutput: null,
                    exitCode: null,
                    durationMs: null,
                },
            },
        };
        const commandCompletedNotification: ServerNotification = {
            method: 'item/completed',
            params: {
                threadId: sessionId,
                turnId: 'turn-1',
                completedAtMs: 0,
                item: {
                    type: 'commandExecution',
                    id: 'command-terminal-output-completion',
                    command: 'git status --short',
                    cwd: '/test/project',
                    processId: 'pid-456',
                    source: 'agent',
                    status: 'completed',
                    commandActions: [],
                    aggregatedOutput: 'M src/CodexEventHandler.ts\n',
                    exitCode: 0,
                    durationMs: 25,
                },
            },
        };

        await setupPromptAndSendNotifications(mockFixture, sessionId, terminalOutputSessionState, [
            commandStartNotification,
            commandCompletedNotification
        ]);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            'data/terminal-output-completion-fallback.json'
        );
    });

    it('should keep parsed non-terminal command output on legacy delta metadata', async () => {
        const terminalOutputSessionState = createTestSessionState({
            sessionId,
            currentModelId: 'model-id[effort]',
            agentMode: AgentMode.DEFAULT_AGENT_MODE,
            terminalOutputMode: 'terminal_output',
        });
        const commandStartNotification: ServerNotification = {
            method: 'item/started',
            params: {
                threadId: sessionId,
                turnId: 'turn-1',
                startedAtMs: 0,
                item: {
                    type: 'commandExecution',
                    id: 'command-read-file',
                    command: 'cat README.md',
                    cwd: '/test/project',
                    processId: null,
                    source: 'agent',
                    status: 'inProgress',
                    commandActions: [
                        {
                            type: 'read',
                            command: 'cat README.md',
                            name: 'cat',
                            path: '/test/project/README.md',
                        },
                    ],
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
                itemId: 'command-read-file',
                delta: '# Project\n',
            },
        };
        const commandCompletedNotification: ServerNotification = {
            method: 'item/completed',
            params: {
                threadId: sessionId,
                turnId: 'turn-1',
                completedAtMs: 0,
                item: {
                    type: 'commandExecution',
                    id: 'command-read-file',
                    command: 'cat README.md',
                    cwd: '/test/project',
                    processId: 'pid-456',
                    source: 'agent',
                    status: 'completed',
                    commandActions: [
                        {
                            type: 'read',
                            command: 'cat README.md',
                            name: 'cat',
                            path: '/test/project/README.md',
                        },
                    ],
                    aggregatedOutput: '# Project\n',
                    exitCode: 0,
                    durationMs: 10,
                },
            },
        };

        await setupPromptAndSendNotifications(mockFixture, sessionId, terminalOutputSessionState, [
            commandStartNotification,
            outputDeltaNotification,
            commandCompletedNotification
        ]);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            'data/terminal-output-parsed-command-legacy-delta.json'
        );
    });

    it('should stream multiple terminal output deltas without accumulation', async () => {
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

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, [delta1, delta2, delta3]);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            'data/terminal-output-multiple-deltas.json'
        );
    });
});

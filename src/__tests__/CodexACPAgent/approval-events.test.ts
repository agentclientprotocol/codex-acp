import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CommandExecutionRequestApprovalParams, FileChangeRequestApprovalParams } from '../../app-server/v2';
import { createCodexMockTestFixture, createTestSessionState, type CodexMockTestFixture } from '../acp-test-utils';
import type { SessionState } from '../../CodexAcpServer';
import {AgentMode} from "../../AgentMode";
import type { ServerNotification } from '../../app-server';

const { mockFiles, mockFileContent, clearMockFiles } = vi.hoisted(() => {
    const files = new Map<string, string>();
    return {
        mockFiles: files,
        mockFileContent: (path: string, content: string) => files.set(path, content),
        clearMockFiles: () => files.clear(),
    };
});

vi.mock('node:fs/promises', () => ({
    readFile: (path: string) => {
        const content = mockFiles.get(path);
        if (content !== undefined) {
            return Promise.resolve(content);
        }
        return Promise.reject(new Error(`ENOENT: no such file or directory, open '${path}'`));
    },
}));

describe('Approval Events', () => {
    let fixture: CodexMockTestFixture;
    const sessionId = 'test-session-id';

    beforeEach(() => {
        fixture = createCodexMockTestFixture();
        clearMockFiles();
        vi.clearAllMocks();
    });

    function setupSessionWithPendingPrompt() {
        const codexAcpAgent = fixture.getCodexAcpAgent();

        let resolveTurnCompleted: (value: { threadId: string; turn: { id: string; items: never[]; status: string; error: null } }) => void = () => {};
        const turnCompletedPromise = new Promise<{ threadId: string; turn: { id: string; items: never[]; status: string; error: null } }>((resolve) => {
            resolveTurnCompleted = resolve;
        });

        fixture.getCodexAppServerClient().turnStart = vi.fn().mockResolvedValue({
            turn: { id: "turn-id", items: [], status: "inProgress", error: null }
        });
        fixture.getCodexAppServerClient().awaitTurnCompleted = vi.fn().mockReturnValue(turnCompletedPromise);

        const sessionState: SessionState = createTestSessionState({
            sessionId,
            currentModelId: 'model-id[effort]',
            agentMode: AgentMode.DEFAULT_AGENT_MODE
        });
        vi.spyOn(codexAcpAgent, 'getSessionState').mockReturnValue(sessionState);

        const promptPromise = codexAcpAgent.prompt({
            sessionId,
            prompt: [{ type: 'text', text: 'Test prompt' }]
        });

        return {
            promptPromise,
            completeTurn: () => resolveTurnCompleted({
                threadId: sessionId,
                turn: { id: "turn-id", items: [], status: "completed", error: null }
            })
        };
    }

    describe('Command execution approval', () => {
        const commandApprovalCases = [
            { optionId: 'allow_once', expectedDecision: 'accept', description: 'allow once' },
            { optionId: 'allow_always', expectedDecision: 'acceptForSession', description: 'allow for session' },
            { optionId: 'reject_once', expectedDecision: 'decline', description: 'reject' },
        ] as const;

        it.each(commandApprovalCases)(
            'should map $optionId to $expectedDecision ($description)',
            async ({ optionId, expectedDecision }) => {
                const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
                fixture.setPermissionResponse({
                    outcome: { outcome: 'selected', optionId }
                });

                const params: CommandExecutionRequestApprovalParams = {
                    threadId: sessionId,
                    turnId: 'turn-1',
                    itemId: `item-${optionId}`,
                    reason: 'Test command',
                    proposedExecpolicyAmendment: null,
                };

                const response = await fixture.sendServerRequest(
                    'item/commandExecution/requestApproval',
                    params
                );

                expect(response).toEqual({ decision: expectedDecision });

                completeTurn();
                await promptPromise;
            }
        );

        it('should handle cancelled permission dialog', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({
                outcome: { outcome: 'cancelled' }
            });

            const params: CommandExecutionRequestApprovalParams = {
                threadId: sessionId,
                turnId: 'turn-1',
                itemId: 'item-cancelled',
                reason: null,
                proposedExecpolicyAmendment: null,
            };

            const response = await fixture.sendServerRequest(
                'item/commandExecution/requestApproval',
                params
            );

            expect(response).toEqual({ decision: 'cancel' });

            completeTurn();
            await promptPromise;
        });

        it('should return cancel when no handler registered', async () => {
            const params: CommandExecutionRequestApprovalParams = {
                threadId: 'non-existent-session',
                turnId: 'turn-1',
                itemId: 'item-no-handler',
                reason: null,
                proposedExecpolicyAmendment: null,
            };

            const response = await fixture.sendServerRequest(
                'item/commandExecution/requestApproval',
                params
            );

            expect(response).toEqual({ decision: 'cancel' });
        });

        it('should convert to ACP permission request format', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({
                outcome: { outcome: 'selected', optionId: 'allow_once' }
            });

            const params: CommandExecutionRequestApprovalParams = {
                threadId: sessionId,
                turnId: 'turn-1',
                itemId: 'item-snapshot',
                reason: 'Running npm install',
                proposedExecpolicyAmendment: null,
            };

            await fixture.sendServerRequest(
                'item/commandExecution/requestApproval',
                params
            );

            await expect(fixture.getAcpConnectionDump(['_meta'])).toMatchFileSnapshot(
                'data/approval-command-allow-once.json'
            );

            completeTurn();
            await promptPromise;
        });

        it('should include rawInput with command and cwd', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({
                outcome: { outcome: 'selected', optionId: 'allow_once' }
            });

            const params: CommandExecutionRequestApprovalParams = {
                threadId: sessionId,
                turnId: 'turn-1',
                itemId: 'item-with-command',
                reason: 'Installing dependencies',
                command: 'npm install',
                cwd: '/home/user/project',
                proposedExecpolicyAmendment: null,
            };

            await fixture.sendServerRequest(
                'item/commandExecution/requestApproval',
                params
            );

            await expect(fixture.getAcpConnectionDump(['_meta'])).toMatchFileSnapshot(
                'data/approval-command-with-rawInput.json'
            );

            completeTurn();
            await promptPromise;
        });

        it.each([
            { command: '/bin/zsh -c npm install', expected: 'npm install' },
            { command: '/bin/bash -lc npm install', expected: 'npm install' },
            { command: 'zsh npm install', expected: 'npm install' },
            { command: 'sh -c ls -la', expected: 'ls -la' },
            { command: 'npm install', expected: 'npm install' },
            { command: "/bin/bash -lc './tests.cmd -Darg=value'", expected: './tests.cmd -Darg=value' },
            { command: "/bin/zsh -c 'echo hello'", expected: 'echo hello' },
        ])('should strip shell prefix from "$command" in rawInput', async ({ command, expected }) => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({
                outcome: { outcome: 'selected', optionId: 'allow_once' }
            });

            const params: CommandExecutionRequestApprovalParams = {
                threadId: sessionId,
                turnId: 'turn-1',
                itemId: 'item-shell-prefix',
                reason: 'Installing dependencies',
                command,
                cwd: '/home/user/project',
                proposedExecpolicyAmendment: null,
            };

            await fixture.sendServerRequest(
                'item/commandExecution/requestApproval',
                params
            );

            const dump = fixture.getAcpConnectionDump(['_meta']);
            const parsed = JSON.parse(dump);
            expect(parsed.args[0].toolCall.rawInput.command).toBe(expected);

            completeTurn();
            await promptPromise;
        });
    });

    describe('File change approval', () => {
        const fileChangeApprovalCases = [
            { optionId: 'allow_once', expectedDecision: 'accept', description: 'allow once' },
            { optionId: 'allow_always', expectedDecision: 'acceptForSession', description: 'allow for session' },
            { optionId: 'reject_once', expectedDecision: 'cancel', description: 'reject' },
        ] as const;

        it.each(fileChangeApprovalCases)(
            'should map $optionId to $expectedDecision ($description)',
            async ({ optionId, expectedDecision }) => {
                const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
                fixture.setPermissionResponse({
                    outcome: { outcome: 'selected', optionId }
                });

                const params: FileChangeRequestApprovalParams = {
                    threadId: sessionId,
                    turnId: 'turn-1',
                    itemId: `file-change-${optionId}`,
                    reason: 'Test file change',
                    grantRoot: null,
                };

                const response = await fixture.sendServerRequest(
                    'item/fileChange/requestApproval',
                    params
                );

                expect(response).toEqual({ decision: expectedDecision });

                completeTurn();
                await promptPromise;
            }
        );

        it('should handle cancelled file change dialog', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({
                outcome: { outcome: 'cancelled' }
            });

            const params: FileChangeRequestApprovalParams = {
                threadId: sessionId,
                turnId: 'turn-1',
                itemId: 'file-change-cancelled',
                reason: null,
                grantRoot: null,
            };

            const response = await fixture.sendServerRequest(
                'item/fileChange/requestApproval',
                params
            );

            expect(response).toEqual({ decision: 'cancel' });

            completeTurn();
            await promptPromise;
        });

        it('should return cancel when no handler registered', async () => {
            const params: FileChangeRequestApprovalParams = {
                threadId: 'non-existent-session',
                turnId: 'turn-1',
                itemId: 'file-change-no-handler',
                reason: null,
                grantRoot: null,
            };

            const response = await fixture.sendServerRequest(
                'item/fileChange/requestApproval',
                params
            );

            expect(response).toEqual({ decision: 'cancel' });
        });

        it('should convert to ACP permission request format', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({
                outcome: { outcome: 'selected', optionId: 'allow_once' }
            });

            const params: FileChangeRequestApprovalParams = {
                threadId: sessionId,
                turnId: 'turn-1',
                itemId: 'file-change-snapshot',
                reason: 'Modifying config file',
                grantRoot: null,
            };

            await fixture.sendServerRequest(
                'item/fileChange/requestApproval',
                params
            );

            await expect(fixture.getAcpConnectionDump(['_meta'])).toMatchFileSnapshot(
                'data/approval-file-change.json'
            );

            completeTurn();
            await promptPromise;
        });

        it('should include diff content for file change approval when file change item is available', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({
                outcome: { outcome: 'selected', optionId: 'allow_once' }
            });
            mockFileContent('/test/project/config.json', '{"feature":false}');

            const notification = {
                method: 'item/started',
                params: {
                    threadId: sessionId,
                    turnId: 'turn-1',
                    item: {
                        type: 'fileChange',
                        id: 'file-change-with-diff',
                        changes: [
                            {
                                path: '/test/project/config.json',
                                kind: { type: 'update' },
                                diff: `--- /test/project/config.json
+++ /test/project/config.json
@@ -1 +1 @@
-{"feature":false}
+{"feature":true}`,
                            },
                        ],
                        status: 'inProgress',
                    },
                },
            } as ServerNotification;

            fixture.sendServerNotification(notification);
            await vi.waitFor(() => {
                expect(fixture.getAcpConnectionDump([])).toContain('file-change-with-diff');
            });
            fixture.clearAcpConnectionDump();

            const params: FileChangeRequestApprovalParams = {
                threadId: sessionId,
                turnId: 'turn-1',
                itemId: 'file-change-with-diff',
                reason: 'Updating config file',
                grantRoot: null,
            };

            await fixture.sendServerRequest(
                'item/fileChange/requestApproval',
                params
            );

            await expect(fixture.getAcpConnectionDump(['_meta'])).toMatchFileSnapshot(
                'data/approval-file-change-with-diff.json'
            );

            completeTurn();
            await promptPromise;
        });

        it('should include one ACP diff per changed file in file change approvals', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({
                outcome: { outcome: 'selected', optionId: 'allow_once' }
            });
            mockFileContent('/test/project/config-a.json', '{"feature":false}');
            mockFileContent('/test/project/config-b.json', '{"enabled":false}');

            const notification = {
                method: 'item/started',
                params: {
                    threadId: sessionId,
                    turnId: 'turn-1',
                    item: {
                        type: 'fileChange',
                        id: 'file-change-multi-diff',
                        changes: [
                            {
                                path: '/test/project/config-a.json',
                                kind: { type: 'update' },
                                diff: `--- /test/project/config-a.json
+++ /test/project/config-a.json
@@ -1 +1 @@
-{"feature":false}
+{"feature":true}`,
                            },
                            {
                                path: '/test/project/config-b.json',
                                kind: { type: 'update' },
                                diff: `--- /test/project/config-b.json
+++ /test/project/config-b.json
@@ -1 +1 @@
-{"enabled":false}
+{"enabled":true}`,
                            },
                        ],
                        status: 'inProgress',
                    },
                },
            } as ServerNotification;

            fixture.sendServerNotification(notification);
            await vi.waitFor(() => {
                expect(fixture.getAcpConnectionDump([])).toContain('file-change-multi-diff');
            });
            fixture.clearAcpConnectionDump();

            await fixture.sendServerRequest(
                'item/fileChange/requestApproval',
                {
                    threadId: sessionId,
                    turnId: 'turn-1',
                    itemId: 'file-change-multi-diff',
                    reason: 'Updating config files',
                    grantRoot: null,
                } satisfies FileChangeRequestApprovalParams
            );

            const dump = JSON.parse(fixture.getAcpConnectionDump(['_meta']));
            const diffEntries = dump.args[0].toolCall.content.filter((entry: { type: string }) => entry.type === 'diff');
            expect(diffEntries).toHaveLength(2);
            expect(diffEntries.map((entry: { path: string }) => entry.path)).toEqual([
                '/test/project/config-a.json',
                '/test/project/config-b.json',
            ]);

            completeTurn();
            await promptPromise;
        });

        it('should include diff content from turn diff when file change item is unavailable', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({
                outcome: { outcome: 'selected', optionId: 'allow_once' }
            });
            mockFileContent('/test/project/config.json', '{"feature":false}');

            const notification: ServerNotification = {
                method: 'turn/diff/updated',
                params: {
                    threadId: sessionId,
                    turnId: 'turn-1',
                    diff: `diff --git a/test/project/config.json b/test/project/config.json
index 0000000..1111111 100644
--- a/test/project/config.json
+++ b/test/project/config.json
@@ -1 +1 @@
-{"feature":false}
+{"feature":true}`,
                },
            };

            fixture.sendServerNotification(notification);
            await Promise.resolve();

            const params: FileChangeRequestApprovalParams = {
                threadId: sessionId,
                turnId: 'turn-1',
                itemId: 'file-change-from-turn-diff',
                reason: 'Updating config file',
                grantRoot: null,
            };

            await fixture.sendServerRequest(
                'item/fileChange/requestApproval',
                params
            );

            await expect(fixture.getAcpConnectionDump(['_meta'])).toMatchFileSnapshot(
                'data/approval-file-change-from-turn-diff.json'
            );

            completeTurn();
            await promptPromise;
        });
    });
});

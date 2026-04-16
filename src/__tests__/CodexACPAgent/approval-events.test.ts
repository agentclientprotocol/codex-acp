import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
    CommandExecutionRequestApprovalParams,
    FileChangeRequestApprovalParams,
    McpServerElicitationRequestParams,
    PermissionsRequestApprovalParams
} from '../../app-server/v2';
import { createCodexMockTestFixture, createTestSessionState, type CodexMockTestFixture } from '../acp-test-utils';
import type { SessionState } from '../../CodexAcpServer';
import {AgentMode} from "../../AgentMode";

describe('Approval Events', () => {
    let fixture: CodexMockTestFixture;
    const sessionId = 'test-session-id';

    beforeEach(() => {
        fixture = createCodexMockTestFixture();
        vi.clearAllMocks();
    });

    function setupSessionWithPendingPrompt() {
        const codexAcpAgent = fixture.getCodexAcpAgent();

        let resolveTurnCompleted: (value: { threadId: string; turn: { id: string; items: never[]; status: string; error: null } }) => void;
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
            completeTurn: () => resolveTurnCompleted!({
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
    });

    describe('Additional permissions approval', () => {
        const baseParams: PermissionsRequestApprovalParams = {
            threadId: sessionId,
            turnId: 'turn-1',
            itemId: 'permissions-item',
            reason: 'MCP tool needs network access',
            permissions: {
                network: { enabled: true },
                fileSystem: {
                    read: ['/workspace/input.txt'],
                    write: ['/workspace/output.txt'],
                },
            },
        };

        it('should grant requested permissions for turn when allow_once is selected', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({
                outcome: { outcome: 'selected', optionId: 'allow_once' }
            });

            const response = await fixture.sendServerRequest(
                'item/permissions/requestApproval',
                baseParams
            );

            expect(response).toEqual({
                permissions: {
                    network: { enabled: true },
                    fileSystem: {
                        read: ['/workspace/input.txt'],
                        write: ['/workspace/output.txt'],
                    },
                },
                scope: 'turn',
            });

            completeTurn();
            await promptPromise;
        });

        it('should grant requested permissions for session when allow_always is selected', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({
                outcome: { outcome: 'selected', optionId: 'allow_always' }
            });

            const response = await fixture.sendServerRequest(
                'item/permissions/requestApproval',
                baseParams
            );

            expect(response).toEqual({
                permissions: {
                    network: { enabled: true },
                    fileSystem: {
                        read: ['/workspace/input.txt'],
                        write: ['/workspace/output.txt'],
                    },
                },
                scope: 'session',
            });

            completeTurn();
            await promptPromise;
        });

        it('should deny requested permissions when reject is selected', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({
                outcome: { outcome: 'selected', optionId: 'reject_once' }
            });

            const response = await fixture.sendServerRequest(
                'item/permissions/requestApproval',
                baseParams
            );

            expect(response).toEqual({
                permissions: {},
                scope: 'turn',
            });

            completeTurn();
            await promptPromise;
        });

        it('should convert additional permissions to ACP permission request format', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({
                outcome: { outcome: 'selected', optionId: 'allow_once' }
            });

            await fixture.sendServerRequest(
                'item/permissions/requestApproval',
                baseParams
            );

            await expect(`${fixture.getAcpConnectionDump(['_meta'])}\n`).toMatchFileSnapshot(
                'data/approval-permissions-allow-once.json'
            );

            completeTurn();
            await promptPromise;
        });
    });

    describe('MCP elicitation approval', () => {
        const baseParams: McpServerElicitationRequestParams = {
            threadId: sessionId,
            turnId: 'turn-1',
            serverName: 'filesystem',
            mode: 'form',
            message: 'Allow filesystem.write_file?',
            _meta: {
                codex_approval_kind: 'mcp_tool_call',
                persist: ['session', 'always'],
                connector_name: 'filesystem',
                tool_title: 'write_file',
                tool_description: 'Write a file to disk',
                tool_params_display: [
                    { display_name: 'Path', name: 'path', value: '/tmp/example.txt' },
                    { display_name: 'Content', name: 'content', value: '' },
                ],
            },
            requestedSchema: {
                type: 'object',
                properties: {},
            },
        };

        it('should accept MCP tool approval elicitations', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({
                outcome: { outcome: 'selected', optionId: 'approved' }
            });

            const response = await fixture.sendServerRequest(
                'mcpServer/elicitation/request',
                baseParams
            );

            expect(response).toEqual({
                action: 'accept',
                content: null,
                _meta: null,
            });

            completeTurn();
            await promptPromise;
        });

        it('should decline MCP tool approval elicitations on reject', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({
                outcome: { outcome: 'selected', optionId: 'cancel' }
            });

            const response = await fixture.sendServerRequest(
                'mcpServer/elicitation/request',
                baseParams
            );

            expect(response).toEqual({
                action: 'cancel',
                content: null,
                _meta: null,
            });

            completeTurn();
            await promptPromise;
        });

        it('should convert MCP tool approval elicitations to ACP permission requests', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({
                outcome: { outcome: 'selected', optionId: 'approved' }
            });

            await fixture.sendServerRequest(
                'mcpServer/elicitation/request',
                baseParams
            );

            await expect(`${fixture.getAcpConnectionDump(['_meta'])}\n`).toMatchFileSnapshot(
                'data/approval-mcp-elicitation-allow-once.json'
            );

            completeTurn();
            await promptPromise;
        });
    });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CommandExecutionRequestApprovalParams, FileChangeRequestApprovalParams } from '../../app-server/v2';
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
            { optionId: 'allow_for_session', expectedDecision: 'acceptForSession', description: 'allow for session' },
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

        it('should map available execpolicy amendment approval to Codex decision', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            const execpolicyAmendment = ['env', 'GRADLE_USER_HOME=/workspace/.gradle-home', './gradlew', 'build'];
            fixture.setPermissionResponse({
                outcome: { outcome: 'selected', optionId: 'allow_command_prefix_rule' }
            });

            const params: CommandExecutionRequestApprovalParams = {
                threadId: sessionId,
                turnId: 'turn-1',
                itemId: 'item-prefix-rule',
                reason: 'Build the project',
                proposedExecpolicyAmendment: ['ignored-fallback'],
                availableDecisions: [
                    'accept',
                    { acceptWithExecpolicyAmendment: { execpolicy_amendment: execpolicyAmendment } },
                    'decline',
                ],
            };

            const response = await fixture.sendServerRequest(
                'item/commandExecution/requestApproval',
                params
            );

            expect(response).toEqual({
                decision: {
                    acceptWithExecpolicyAmendment: {
                        execpolicy_amendment: execpolicyAmendment,
                    },
                },
            });
            await expect(fixture.getAcpConnectionDump(['_meta'])).toMatchFileSnapshot(
                'data/approval-command-prefix-rule.json'
            );

            completeTurn();
            await promptPromise;
        });

        it('should add fallback execpolicy amendment option when availableDecisions is absent', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            const execpolicyAmendment = ['npm', 'run'];
            fixture.setPermissionResponse({
                outcome: { outcome: 'selected', optionId: 'allow_command_prefix_rule' }
            });

            const params: CommandExecutionRequestApprovalParams = {
                threadId: sessionId,
                turnId: 'turn-1',
                itemId: 'item-prefix-rule-fallback',
                reason: 'Run npm script',
                proposedExecpolicyAmendment: execpolicyAmendment,
            };

            const response = await fixture.sendServerRequest(
                'item/commandExecution/requestApproval',
                params
            );

            expect(response).toEqual({
                decision: {
                    acceptWithExecpolicyAmendment: {
                        execpolicy_amendment: execpolicyAmendment,
                    },
                },
            });

            completeTurn();
            await promptPromise;
        });

        it('should respect availableDecisions when prefix-rule approval is omitted', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({
                outcome: { outcome: 'selected', optionId: 'allow_once' }
            });

            const params: CommandExecutionRequestApprovalParams = {
                threadId: sessionId,
                turnId: 'turn-1',
                itemId: 'item-no-prefix-rule',
                reason: 'Run exact command only',
                proposedExecpolicyAmendment: ['npm', 'run'],
                availableDecisions: ['accept', 'decline'],
            };

            await fixture.sendServerRequest(
                'item/commandExecution/requestApproval',
                params
            );

            await expect(fixture.getAcpConnectionDump(['_meta'])).toMatchFileSnapshot(
                'data/approval-command-available-decisions-without-prefix.json'
            );

            completeTurn();
            await promptPromise;
        });

        it('should map network policy amendment approval to Codex decision', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            const networkPolicyAmendment = { host: 'registry.npmjs.org', action: 'allow' } as const;
            fixture.setPermissionResponse({
                outcome: { outcome: 'selected', optionId: 'apply_network_policy_amendment' }
            });

            const params: CommandExecutionRequestApprovalParams = {
                threadId: sessionId,
                turnId: 'turn-1',
                itemId: 'item-network-policy',
                reason: 'Allow network access',
                proposedExecpolicyAmendment: null,
                availableDecisions: [
                    'accept',
                    { applyNetworkPolicyAmendment: { network_policy_amendment: networkPolicyAmendment } },
                    'cancel',
                ],
            };

            const response = await fixture.sendServerRequest(
                'item/commandExecution/requestApproval',
                params
            );

            expect(response).toEqual({
                decision: {
                    applyNetworkPolicyAmendment: {
                        network_policy_amendment: networkPolicyAmendment,
                    },
                },
            });
            await expect(fixture.getAcpConnectionDump(['_meta'])).toMatchFileSnapshot(
                'data/approval-command-network-policy.json'
            );

            completeTurn();
            await promptPromise;
        });

        it('should map explicit cancel option to cancel when advertised', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({
                outcome: { outcome: 'selected', optionId: 'cancel' }
            });

            const params: CommandExecutionRequestApprovalParams = {
                threadId: sessionId,
                turnId: 'turn-1',
                itemId: 'item-explicit-cancel',
                reason: 'Test command',
                proposedExecpolicyAmendment: null,
                availableDecisions: ['accept', 'cancel'],
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
            { optionId: 'allow_for_session', expectedDecision: 'acceptForSession', description: 'allow for session' },
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
});

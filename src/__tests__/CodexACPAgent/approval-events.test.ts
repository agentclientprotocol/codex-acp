import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
    CommandExecutionRequestApprovalParams,
    FileChangeRequestApprovalParams,
    PermissionsRequestApprovalParams,
} from '../../app-server/v2';
import type { ServerNotification } from '../../app-server';
import { createCodexMockTestFixture, createTestSessionState, type CodexMockTestFixture } from '../acp-test-utils';
import type { SessionState } from '../../CodexAcpServer';
import {AgentMode} from '../../AgentMode';
import {ApprovalOptionId} from '../../ApprovalOptionId';

function threadStarted(threadId: string, rootSessionId: string, parentThreadId: string): ServerNotification {
    return {
        method: 'thread/started',
        params: {
            thread: {
                id: threadId,
                sessionId: rootSessionId,
                forkedFromId: null,
                parentThreadId,
                preview: '',
                ephemeral: false,
                section: null,
                sectionEnteredAt: null,
                modelProvider: 'openai',
                createdAt: 0,
                updatedAt: 0,
                recencyAt: null,
                status: { type: 'idle' },
                path: null,
                cwd: '/workspace',
                cliVersion: 'test',
                source: 'unknown',
                threadSource: null,
                agentNickname: null,
                agentRole: null,
                gitInfo: null,
                name: null,
                turns: [],
            },
        },
    };
}

function approvalHandler(decision: 'accept' | 'decline') {
    return {
        handleCommandExecution: async () => ({ decision }),
        handleFileChange: async () => ({ decision }),
        handlePermissionsRequest: async () => ({
            permissions: {},
            scope: 'turn' as const,
            strictAutoReview: true,
        }),
    };
}

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
                    startedAtMs: 0,
                    environmentId: null,
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
                startedAtMs: 0,
                environmentId: null,
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

        it('should map execpolicy amendment approval to the exact app-server decision', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({
                outcome: { outcome: 'selected', optionId: ApprovalOptionId.AcceptWithExecpolicyAmendment }
            });

            const proposedExecpolicyAmendment = ['npm', 'install'];
            const params: CommandExecutionRequestApprovalParams = {
                threadId: sessionId,
                turnId: 'turn-1',
                itemId: 'item-execpolicy-amendment',
                startedAtMs: 0,
                environmentId: null,
                reason: 'Installing dependencies',
                command: 'npm install',
                cwd: '/home/user/project',
                proposedExecpolicyAmendment,
            };

            const response = await fixture.sendServerRequest(
                'item/commandExecution/requestApproval',
                params
            );

            expect(response).toEqual({
                decision: {
                    acceptWithExecpolicyAmendment: {
                        execpolicy_amendment: proposedExecpolicyAmendment,
                    },
                },
            });

            const requestEvent = fixture.getAcpConnectionEvents([])[0];
            expect(requestEvent).toBeDefined();
            const request = requestEvent!.args[0];
            expect(request.options).toContainEqual(
                expect.objectContaining({
                    optionId: ApprovalOptionId.AcceptWithExecpolicyAmendment,
                    kind: 'allow_always',
                    _meta: {
                        permission: {
                            version: 1,
                            changes: [{
                                type: 'policy_rule',
                                operation: 'add',
                                ruleBehavior: 'allow',
                                description: 'Allow commands starting with npm install',
                                targets: [{
                                    type: 'command',
                                    matcher: {
                                        type: 'argv_prefix',
                                        argv: proposedExecpolicyAmendment,
                                    },
                                }],
                            }],
                        },
                        codex: expect.objectContaining({
                            execpolicyAmendment: proposedExecpolicyAmendment,
                        }),
                    },
                })
            );

            completeTurn();
            await promptPromise;
        });

        it('should map network policy amendment approval to the exact app-server decision', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            const optionId = `${ApprovalOptionId.ApplyNetworkPolicyAmendment}:0`;
            fixture.setPermissionResponse({
                outcome: { outcome: 'selected', optionId }
            });

            const networkPolicyAmendment = { host: 'registry.npmjs.org', action: 'allow' as const };
            const params: CommandExecutionRequestApprovalParams = {
                threadId: sessionId,
                turnId: 'turn-1',
                itemId: 'item-network-policy-amendment',
                startedAtMs: 0,
                environmentId: null,
                reason: 'Needs network access',
                networkApprovalContext: { host: 'registry.npmjs.org', protocol: 'https' },
                proposedNetworkPolicyAmendments: [networkPolicyAmendment],
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

            const requestEvent = fixture.getAcpConnectionEvents([])[0];
            expect(requestEvent).toBeDefined();
            const request = requestEvent!.args[0];
            expect(request.options).toContainEqual(
                expect.objectContaining({
                    optionId,
                    kind: 'allow_always',
                    _meta: {
                        permission: {
                            version: 1,
                            changes: [{
                                type: 'policy_rule',
                                operation: 'add',
                                ruleBehavior: 'allow',
                                description: 'Allow access to registry.npmjs.org',
                                targets: [{
                                    type: 'network',
                                    matcher: {
                                        type: 'host',
                                        host: 'registry.npmjs.org',
                                    },
                                }],
                            }],
                        },
                        codex: expect.objectContaining({
                            networkPolicyAmendment,
                        }),
                    },
                })
            );

            completeTurn();
            await promptPromise;
        });

        it('should return cancel when no handler registered', async () => {
            const params: CommandExecutionRequestApprovalParams = {
                threadId: 'non-existent-session',
                turnId: 'turn-1',
                startedAtMs: 0,
                environmentId: null,
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

        it('routes a child command approval to its root ACP session', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({
                outcome: { outcome: 'selected', optionId: 'allow_once' }
            });
            fixture.sendServerNotification(threadStarted('child-thread', sessionId, sessionId));

            const params: CommandExecutionRequestApprovalParams = {
                threadId: 'child-thread',
                turnId: 'child-turn',
                startedAtMs: 0,
                environmentId: null,
                itemId: 'child-command',
                reason: 'Read a source file',
                proposedExecpolicyAmendment: null,
            };

            const response = await fixture.sendServerRequest(
                'item/commandExecution/requestApproval',
                params
            );

            expect(response).toEqual({ decision: 'accept' });

            completeTurn();
            await promptPromise;
        });

        it('should convert to ACP permission request format', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({
                outcome: { outcome: 'selected', optionId: 'allow_once' }
            });

            const params: CommandExecutionRequestApprovalParams = {
                threadId: sessionId,
                turnId: 'turn-1',
                startedAtMs: 0,
                environmentId: null,
                itemId: 'item-snapshot',
                reason: 'Running npm install',
                proposedExecpolicyAmendment: null,
            };

            await fixture.sendServerRequest(
                'item/commandExecution/requestApproval',
                params
            );

            await expect(fixture.getAcpConnectionDump([])).toMatchFileSnapshot(
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
                startedAtMs: 0,
                environmentId: null,
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

            await expect(fixture.getAcpConnectionDump([])).toMatchFileSnapshot(
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
                startedAtMs: 0,
                environmentId: null,
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
            { optionId: 'reject_once', expectedDecision: 'decline', description: 'reject' },
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
                    startedAtMs: 0,
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
                startedAtMs: 0,
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

        it('should describe a session write-root grant with common permission metadata', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({
                outcome: { outcome: 'selected', optionId: ApprovalOptionId.AllowAlways }
            });

            const params: FileChangeRequestApprovalParams = {
                threadId: sessionId,
                turnId: 'turn-1',
                startedAtMs: 0,
                itemId: 'file-change-grant-root',
                reason: 'Write generated files',
                grantRoot: '/workspace/generated',
            };

            await fixture.sendServerRequest('item/fileChange/requestApproval', params);

            const request = fixture.getAcpConnectionEvents([])[0]!.args[0];
            expect(request.options.find((option: { optionId: string }) => option.optionId === ApprovalOptionId.AllowAlways)?._meta)
                .toMatchObject({
                    permission: {
                        version: 1,
                        changes: [{
                            type: 'grant',
                            operation: 'grant',
                            description: 'Allow writes under /workspace/generated for this session',
                            lifetime: {scope: 'session'},
                            targets: [{
                                type: 'filesystem',
                                access: ['write'],
                                matcher: {type: 'directory', path: '/workspace/generated'},
                            }],
                        }],
                    },
                });

            completeTurn();
            await promptPromise;
        });

        it('should return cancel when no handler registered', async () => {
            const params: FileChangeRequestApprovalParams = {
                threadId: 'non-existent-session',
                turnId: 'turn-1',
                startedAtMs: 0,
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
                startedAtMs: 0,
                itemId: 'file-change-snapshot',
                reason: 'Modifying config file',
                grantRoot: null,
            };

            await fixture.sendServerRequest(
                'item/fileChange/requestApproval',
                params
            );

            await expect(fixture.getAcpConnectionDump([])).toMatchFileSnapshot(
                'data/approval-file-change.json'
            );

            completeTurn();
            await promptPromise;
        });
    });

    describe('Permissions approval', () => {
        const requestedPermissions = {
            network: { enabled: true },
            fileSystem: {
                read: ['/home/user/project'],
                write: ['/home/user/project/tmp'],
                entries: [],
            },
        };

        const permissionApprovalCases = [
            {
                optionId: ApprovalOptionId.AllowPermissionsForTurn,
                expectedResponse: {
                    permissions: requestedPermissions,
                    scope: 'turn',
                    strictAutoReview: false,
                },
                description: 'allow for turn',
            },
            {
                optionId: ApprovalOptionId.AllowPermissionsForSession,
                expectedResponse: {
                    permissions: requestedPermissions,
                    scope: 'session',
                    strictAutoReview: false,
                },
                description: 'allow for session',
            },
            {
                optionId: ApprovalOptionId.RejectPermissions,
                expectedResponse: {
                    permissions: {},
                    scope: 'turn',
                    strictAutoReview: true,
                },
                description: 'reject',
            },
        ] as const;

        it.each(permissionApprovalCases)(
            'should map $optionId to app-server permissions response ($description)',
            async ({ optionId, expectedResponse }) => {
                const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
                fixture.setPermissionResponse({
                    outcome: { outcome: 'selected', optionId }
                });

                const params: PermissionsRequestApprovalParams = {
                    threadId: sessionId,
                    turnId: 'turn-1',
                    itemId: `permissions-${optionId}`,
                    environmentId: null,
                    startedAtMs: 0,
                    cwd: '/home/user/project',
                    reason: 'Need extra access',
                    permissions: requestedPermissions,
                };

                const response = await fixture.sendServerRequest(
                    'item/permissions/requestApproval',
                    params
                );

                expect(response).toEqual(expectedResponse);

                completeTurn();
                await promptPromise;
            }
        );

        it('should map cancelled permission dialog to strict auto-review with no grants', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({
                outcome: { outcome: 'cancelled' }
            });

            const params: PermissionsRequestApprovalParams = {
                threadId: sessionId,
                turnId: 'turn-1',
                itemId: 'permissions-cancelled',
                environmentId: null,
                startedAtMs: 0,
                cwd: '/home/user/project',
                reason: 'Need extra access',
                permissions: requestedPermissions,
            };

            const response = await fixture.sendServerRequest(
                'item/permissions/requestApproval',
                params
            );

            expect(response).toEqual({
                permissions: {},
                scope: 'turn',
                strictAutoReview: true,
            });

            completeTurn();
            await promptPromise;
        });

        it('should return strict auto-review with no grants when no handler registered', async () => {
            const params: PermissionsRequestApprovalParams = {
                threadId: 'non-existent-session',
                turnId: 'turn-1',
                itemId: 'permissions-no-handler',
                environmentId: null,
                startedAtMs: 0,
                cwd: '/home/user/project',
                reason: 'Need extra access',
                permissions: requestedPermissions,
            };

            const response = await fixture.sendServerRequest(
                'item/permissions/requestApproval',
                params
            );

            expect(response).toEqual({
                permissions: {},
                scope: 'turn',
                strictAutoReview: true,
            });
        });

        it('should convert to ACP permission request format', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({
                outcome: { outcome: 'selected', optionId: ApprovalOptionId.AllowPermissionsForSession }
            });

            const params: PermissionsRequestApprovalParams = {
                threadId: sessionId,
                turnId: 'turn-1',
                itemId: 'permissions-snapshot',
                environmentId: null,
                startedAtMs: 0,
                cwd: '/home/user/project',
                reason: 'Need extra access',
                permissions: requestedPermissions,
            };

            await fixture.sendServerRequest(
                'item/permissions/requestApproval',
                params
            );

            await expect(fixture.getAcpConnectionDump([])).toMatchFileSnapshot(
                'data/approval-permissions-request.json'
            );

            completeTurn();
            await promptPromise;
        });
    });

    describe('Child thread routing', () => {
        it('routes a nested child command approval to its root ACP session', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({
                outcome: { outcome: 'selected', optionId: 'allow_once' }
            });
            fixture.sendServerNotification(threadStarted('nested-child', sessionId, 'parent-child'));

            const response = await fixture.sendServerRequest(
                'item/commandExecution/requestApproval',
                {
                    threadId: 'nested-child',
                    turnId: 'nested-turn',
                    startedAtMs: 0,
                    environmentId: null,
                    itemId: 'nested-command',
                    reason: 'Inspect nested work',
                    proposedExecpolicyAmendment: null,
                } satisfies CommandExecutionRequestApprovalParams
            );

            expect(response).toEqual({ decision: 'accept' });

            completeTurn();
            await promptPromise;
        });

        it('routes a child file-change approval to its root ACP session', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({
                outcome: { outcome: 'selected', optionId: 'allow_once' }
            });
            fixture.sendServerNotification(threadStarted('child-file', sessionId, sessionId));

            const response = await fixture.sendServerRequest(
                'item/fileChange/requestApproval',
                {
                    threadId: 'child-file',
                    turnId: 'child-turn',
                    startedAtMs: 0,
                    itemId: 'child-file-change',
                    reason: 'Write a test fixture',
                    grantRoot: null,
                } satisfies FileChangeRequestApprovalParams
            );

            expect(response).toEqual({ decision: 'accept' });

            completeTurn();
            await promptPromise;
        });

        it('routes a child permissions approval to its root ACP session', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            const requestedPermissions = {
                network: { enabled: true },
                fileSystem: {
                    read: ['/workspace'],
                    write: ['/workspace/generated'],
                    entries: [],
                },
            };
            fixture.setPermissionResponse({
                outcome: {
                    outcome: 'selected',
                    optionId: ApprovalOptionId.AllowPermissionsForTurn,
                }
            });
            fixture.sendServerNotification(threadStarted('child-permissions', sessionId, sessionId));

            const response = await fixture.sendServerRequest(
                'item/permissions/requestApproval',
                {
                    threadId: 'child-permissions',
                    turnId: 'child-turn',
                    itemId: 'child-permissions-request',
                    environmentId: null,
                    startedAtMs: 0,
                    cwd: '/workspace',
                    reason: 'Build generated files',
                    permissions: requestedPermissions,
                } satisfies PermissionsRequestApprovalParams
            );

            expect(response).toEqual({
                permissions: requestedPermissions,
                scope: 'turn',
                strictAutoReview: false,
            });

            completeTurn();
            await promptPromise;
        });

        it('does not route a closed session child to a replacement root handler', async () => {
            const firstPrompt = setupSessionWithPendingPrompt();
            fixture.sendServerNotification(threadStarted('closed-child', sessionId, sessionId));
            firstPrompt.completeTurn();
            await firstPrompt.promptPromise;
            await fixture.getCodexAcpClient().closeSession(sessionId);

            const replacementPrompt = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({
                outcome: { outcome: 'selected', optionId: 'allow_once' }
            });

            const response = await fixture.sendServerRequest(
                'item/commandExecution/requestApproval',
                {
                    threadId: 'closed-child',
                    turnId: 'replacement-turn',
                    startedAtMs: 0,
                    environmentId: null,
                    itemId: 'closed-child-command',
                    reason: 'Request from a closed session',
                    proposedExecpolicyAmendment: null,
                } satisfies CommandExecutionRequestApprovalParams
            );

            expect(response).toEqual({ decision: 'cancel' });

            replacementPrompt.completeTurn();
            await replacementPrompt.promptPromise;
        });

        it('ignores a delayed child notification after its root session closes', async () => {
            const firstPrompt = setupSessionWithPendingPrompt();
            firstPrompt.completeTurn();
            await firstPrompt.promptPromise;
            await fixture.getCodexAcpClient().closeSession(sessionId);
            fixture.sendServerNotification(threadStarted('delayed-child', sessionId, sessionId));

            const replacementPrompt = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({
                outcome: { outcome: 'selected', optionId: 'allow_once' }
            });

            const response = await fixture.sendServerRequest(
                'item/commandExecution/requestApproval',
                {
                    threadId: 'delayed-child',
                    turnId: 'replacement-turn',
                    startedAtMs: 0,
                    environmentId: null,
                    itemId: 'delayed-child-command',
                    reason: 'Delayed notification from a closed session',
                    proposedExecpolicyAmendment: null,
                } satisfies CommandExecutionRequestApprovalParams
            );

            expect(response).toEqual({ decision: 'cancel' });

            replacementPrompt.completeTurn();
            await replacementPrompt.promptPromise;
        });

        it('prefers a child exact handler over its recorded root handler', async () => {
            const appServerClient = fixture.getCodexAppServerClient();
            appServerClient.onServerNotification(sessionId, () => {});
            appServerClient.onApprovalRequest(sessionId, approvalHandler('accept'));
            fixture.sendServerNotification(threadStarted('direct-child', sessionId, sessionId));
            appServerClient.onApprovalRequest('direct-child', approvalHandler('decline'));

            const response = await fixture.sendServerRequest(
                'item/commandExecution/requestApproval',
                {
                    threadId: 'direct-child',
                    turnId: 'direct-turn',
                    startedAtMs: 0,
                    environmentId: null,
                    itemId: 'direct-command',
                    reason: 'Use the direct child policy',
                    proposedExecpolicyAmendment: null,
                } satisfies CommandExecutionRequestApprovalParams
            );

            expect(response).toEqual({ decision: 'decline' });
        });

        it('keeps child approval routing isolated between root sessions', async () => {
            const appServerClient = fixture.getCodexAppServerClient();
            appServerClient.onServerNotification('root-a', () => {});
            appServerClient.onServerNotification('root-b', () => {});
            appServerClient.onApprovalRequest('root-a', approvalHandler('accept'));
            appServerClient.onApprovalRequest('root-b', approvalHandler('decline'));
            fixture.sendServerNotification(threadStarted('child-a', 'root-a', 'root-a'));
            fixture.sendServerNotification(threadStarted('child-b', 'root-b', 'root-b'));

            const childAResponse = await fixture.sendServerRequest(
                'item/commandExecution/requestApproval',
                {
                    threadId: 'child-a',
                    turnId: 'turn-a',
                    startedAtMs: 0,
                    environmentId: null,
                    itemId: 'command-a',
                    reason: 'Use root A policy',
                    proposedExecpolicyAmendment: null,
                } satisfies CommandExecutionRequestApprovalParams
            );
            const childBResponse = await fixture.sendServerRequest(
                'item/commandExecution/requestApproval',
                {
                    threadId: 'child-b',
                    turnId: 'turn-b',
                    startedAtMs: 0,
                    environmentId: null,
                    itemId: 'command-b',
                    reason: 'Use root B policy',
                    proposedExecpolicyAmendment: null,
                } satisfies CommandExecutionRequestApprovalParams
            );

            expect(childAResponse).toEqual({ decision: 'accept' });
            expect(childBResponse).toEqual({ decision: 'decline' });
        });
    });
});

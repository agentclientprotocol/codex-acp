import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as acp from "@agentclientprotocol/sdk";
import type { McpServerElicitationRequestParams } from '../../app-server/v2';
import { createCodexMockTestFixture, createTestSessionState, type CodexMockTestFixture } from '../acp-test-utils';
import type { SessionState } from '../../CodexAcpServer';
import { AgentMode } from "../../AgentMode";
import { McpApprovalOptionId } from "../../McpApprovalOptionId";
import type { ServerNotification } from "../../app-server";

describe('Elicitation Events', () => {
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

    async function setupSessionWithPendingPromptAndCapabilities(clientCapabilities: acp.ClientCapabilities) {
        await fixture.getCodexAcpAgent().initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities,
        });
        return setupSessionWithPendingPrompt();
    }

    describe('Form mode elicitation', () => {
        it('should use ACP form elicitation when the client supports it', async () => {
            const { promptPromise, completeTurn } = await setupSessionWithPendingPromptAndCapabilities({
                elicitation: { form: {} },
            });
            fixture.setElicitationResponse({
                action: 'accept',
                content: { username: 'octocat' },
                _meta: { source: 'client' },
            });

            const params: McpServerElicitationRequestParams = {
                threadId: sessionId, turnId: 'turn-1', serverName: 'test-server',
                mode: 'form', _meta: null, message: 'Please provide your username',
                requestedSchema: { type: 'object', properties: { username: { type: 'string' } }, required: ['username'] },
            };

            const response = await fixture.sendServerRequest('mcpServer/elicitation/request', params);
            expect(response).toEqual({ action: 'accept', content: { username: 'octocat' }, _meta: { source: 'client' } });

            const [elicitationEvent] = fixture.getAcpConnectionEvents([]);
            expect(elicitationEvent).toEqual({
                method: 'createElicitation',
                args: [{
                    sessionId,
                    mode: 'form',
                    message: 'Please provide your username',
                    requestedSchema: {
                        type: 'object',
                        properties: { username: { type: 'string' } },
                        required: ['username'],
                    },
                    _meta: null,
                }],
            });

            completeTurn();
            await promptPromise;
        });

        it('should normalize legacy enumNames schemas for ACP form elicitation', async () => {
            const { promptPromise, completeTurn } = await setupSessionWithPendingPromptAndCapabilities({
                elicitation: { form: {} },
            });
            fixture.setElicitationResponse({
                action: 'accept',
                content: { color: 'blue' },
            });

            const params: McpServerElicitationRequestParams = {
                threadId: sessionId, turnId: 'turn-1', serverName: 'test-server',
                mode: 'form', _meta: null, message: 'Pick a color',
                requestedSchema: {
                    type: 'object',
                    properties: {
                        color: {
                            type: 'string',
                            enum: ['red', 'blue'],
                            enumNames: ['Red', 'Blue'],
                        },
                    },
                    required: ['color'],
                },
            };

            await fixture.sendServerRequest('mcpServer/elicitation/request', params);

            const [elicitationEvent] = fixture.getAcpConnectionEvents([]);
            expect(elicitationEvent?.args[0].requestedSchema.properties.color).toEqual({
                type: 'string',
                oneOf: [
                    { const: 'red', title: 'Red' },
                    { const: 'blue', title: 'Blue' },
                ],
            });

            completeTurn();
            await promptPromise;
        });

        it('should map custom ACP elicitation actions to cancel', async () => {
            const { promptPromise, completeTurn } = await setupSessionWithPendingPromptAndCapabilities({
                elicitation: { form: {} },
            });
            fixture.setElicitationResponse({
                action: 'defer',
                _meta: { source: 'client' },
            });

            const params: McpServerElicitationRequestParams = {
                threadId: sessionId, turnId: 'turn-1', serverName: 'test-server',
                mode: 'form', _meta: null, message: 'Please provide your username',
                requestedSchema: { type: 'object', properties: { username: { type: 'string' } }, required: ['username'] },
            };

            const response = await fixture.sendServerRequest('mcpServer/elicitation/request', params);
            expect(response).toEqual({ action: 'cancel', content: null, _meta: null });

            completeTurn();
            await promptPromise;
        });

        it('should not treat malformed ACP elicitation accept responses as accepted', async () => {
            const { promptPromise, completeTurn } = await setupSessionWithPendingPromptAndCapabilities({
                elicitation: { form: {} },
            });
            fixture.setElicitationResponse({
                action: 'accept',
                content: { username: { nested: 'invalid' } },
            } as acp.CreateElicitationResponse);

            const params: McpServerElicitationRequestParams = {
                threadId: sessionId, turnId: 'turn-1', serverName: 'test-server',
                mode: 'form', _meta: null, message: 'Please provide your username',
                requestedSchema: { type: 'object', properties: { username: { type: 'string' } }, required: ['username'] },
            };

            const response = await fixture.sendServerRequest('mcpServer/elicitation/request', params);
            expect(response).toEqual({ action: 'cancel', content: null, _meta: null });

            completeTurn();
            await promptPromise;
        });

        it('should map accept to accept', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({ outcome: { outcome: 'selected', optionId: 'accept' } });

            const params: McpServerElicitationRequestParams = {
                threadId: sessionId, turnId: 'turn-1', serverName: 'test-server',
                mode: 'form', _meta: null, message: 'Please provide your username',
                requestedSchema: { type: 'object', properties: { username: { type: 'string' } }, required: ['username'] },
            };

            const response = await fixture.sendServerRequest('mcpServer/elicitation/request', params);
            expect(response).toEqual({ action: 'accept', content: null, _meta: null });

            completeTurn();
            await promptPromise;
        });

        it('should map decline to decline', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({ outcome: { outcome: 'selected', optionId: 'decline' } });

            const params: McpServerElicitationRequestParams = {
                threadId: sessionId, turnId: 'turn-1', serverName: 'test-server',
                mode: 'form', _meta: null, message: 'Please provide info',
                requestedSchema: { type: 'object', properties: {} },
            };

            const response = await fixture.sendServerRequest('mcpServer/elicitation/request', params);
            expect(response).toEqual({ action: 'decline', content: null, _meta: null });

            completeTurn();
            await promptPromise;
        });

        it('should return cancel when user dismisses dialog', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({ outcome: { outcome: 'cancelled' } });

            const params: McpServerElicitationRequestParams = {
                threadId: sessionId, turnId: 'turn-1', serverName: 'test-server',
                mode: 'form', _meta: null, message: 'Please provide info',
                requestedSchema: { type: 'object', properties: {} },
            };

            const response = await fixture.sendServerRequest('mcpServer/elicitation/request', params);
            expect(response).toEqual({ action: 'cancel', content: null, _meta: null });

            completeTurn();
            await promptPromise;
        });

        it('should return cancel when no handler registered', async () => {
            const params: McpServerElicitationRequestParams = {
                threadId: 'non-existent-session', turnId: null, serverName: 'test-server',
                mode: 'form', _meta: null, message: 'Please provide info',
                requestedSchema: { type: 'object', properties: {} },
            };

            const response = await fixture.sendServerRequest('mcpServer/elicitation/request', params);
            expect(response).toEqual({ action: 'cancel', content: null, _meta: null });
        });

        it('should build correct ACP permission request for form mode', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({ outcome: { outcome: 'selected', optionId: 'accept' } });

            const params: McpServerElicitationRequestParams = {
                threadId: sessionId, turnId: 'turn-1', serverName: 'my-mcp-server',
                mode: 'form', _meta: null, message: 'Please provide your GitHub username',
                requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
            };

            await fixture.sendServerRequest('mcpServer/elicitation/request', params);
            await expect(fixture.getAcpConnectionDump(['_meta'])).toMatchFileSnapshot('data/elicitation-form-accept.json');

            completeTurn();
            await promptPromise;
        });
    });

    describe('MCP tool call approval elicitation', () => {
        it('should use ACP form elicitation for MCP tool approval when supported', async () => {
            const { promptPromise, completeTurn } = await setupSessionWithPendingPromptAndCapabilities({
                elicitation: { form: {} },
            });
            fixture.setElicitationResponse({
                action: 'accept',
                content: { persist: 'always' },
                _meta: { source: 'client' },
            });

            fixture.sendServerNotification({
                method: 'item/started',
                params: {
                    threadId: sessionId,
                    turnId: 'turn-1',
                    startedAtMs: 0,
                    item: {
                        type: "mcpToolCall",
                        id: "call-id",
                        server: "tool-server",
                        tool: "tool-name",
                        status: "inProgress",
                        arguments: { argument: "example" },
                        appContext: null,
                        pluginId: null,
                        result: null,
                        error: null,
                        durationMs: null,
                    },
                },
            });
            await fixture.getCodexAcpClient().waitForSessionNotifications(sessionId);
            fixture.clearAcpConnectionDump();

            const params: McpServerElicitationRequestParams = {
                threadId: sessionId, turnId: 'turn-1', serverName: 'tool-server',
                mode: 'form',
                _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'] },
                message: 'Allow tool call?',
                requestedSchema: { type: 'object', properties: {} },
            };

            const response = await fixture.sendServerRequest('mcpServer/elicitation/request', params);
            expect(response).toEqual({ action: 'accept', content: null, _meta: { source: 'client', persist: 'always' } });

            const events = fixture.getAcpConnectionEvents(['_meta']);
            expect(events[0]).toMatchObject({
                method: 'createElicitation',
                args: [{
                    sessionId,
                    toolCallId: 'call-id',
                    mode: 'form',
                    message: 'Allow tool call?',
                }],
            });
            expect(events[0]!.args[0].requestedSchema.properties.persist.oneOf).toEqual([
                { const: 'once', title: 'Allow once' },
                { const: 'session', title: 'Allow for this session' },
                { const: 'always', title: "Allow and don't ask again" },
            ]);
            expect(events[1]).toEqual({
                method: 'sessionUpdate',
                args: [{
                    sessionId,
                    update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-id', status: 'in_progress' },
                }],
            });

            completeTurn();
            await promptPromise;
        });

        it('should show Allow/session/always/Decline options when all persist values advertised', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({ outcome: { outcome: 'selected', optionId: McpApprovalOptionId.AllowOnce } });

            const params: McpServerElicitationRequestParams = {
                threadId: sessionId, turnId: 'turn-1', serverName: 'tool-server',
                mode: 'form',
                _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'] },
                message: 'Allow tool call?',
                requestedSchema: { type: 'object', properties: {} },
            };

            await fixture.sendServerRequest('mcpServer/elicitation/request', params);
            await expect(fixture.getAcpConnectionDump(['_meta'])).toMatchFileSnapshot('data/elicitation-tool-approval-all-persist.json');

            completeTurn();
            await promptPromise;
        });

        it('should map allow_once to accept with null meta', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({ outcome: { outcome: 'selected', optionId: McpApprovalOptionId.AllowOnce } });

            const params: McpServerElicitationRequestParams = {
                threadId: sessionId, turnId: 'turn-1', serverName: 'tool-server',
                mode: 'form',
                _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'] },
                message: 'Allow tool call?',
                requestedSchema: { type: 'object', properties: {} },
            };

            const response = await fixture.sendServerRequest('mcpServer/elicitation/request', params);
            expect(response).toEqual({ action: 'accept', content: null, _meta: null });

            completeTurn();
            await promptPromise;
        });

        it('should map allow_session to accept with persist:session meta', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({ outcome: { outcome: 'selected', optionId: McpApprovalOptionId.AllowSession } });

            const params: McpServerElicitationRequestParams = {
                threadId: sessionId, turnId: 'turn-1', serverName: 'tool-server',
                mode: 'form',
                _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'] },
                message: 'Allow tool call?',
                requestedSchema: { type: 'object', properties: {} },
            };

            const response = await fixture.sendServerRequest('mcpServer/elicitation/request', params);
            expect(response).toEqual({ action: 'accept', content: null, _meta: { persist: 'session' } });

            completeTurn();
            await promptPromise;
        });

        it('should map allow_always to accept with persist:always meta', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({ outcome: { outcome: 'selected', optionId: McpApprovalOptionId.AllowAlways } });

            const params: McpServerElicitationRequestParams = {
                threadId: sessionId, turnId: 'turn-1', serverName: 'tool-server',
                mode: 'form',
                _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'] },
                message: 'Allow tool call?',
                requestedSchema: { type: 'object', properties: {} },
            };

            const response = await fixture.sendServerRequest('mcpServer/elicitation/request', params);
            expect(response).toEqual({ action: 'accept', content: null, _meta: { persist: 'always' } });

            completeTurn();
            await promptPromise;
        });

        it('should only show session option when persist is "session"', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({ outcome: { outcome: 'selected', optionId: McpApprovalOptionId.AllowOnce } });

            const params: McpServerElicitationRequestParams = {
                threadId: sessionId, turnId: 'turn-1', serverName: 'tool-server',
                mode: 'form',
                _meta: { codex_approval_kind: 'mcp_tool_call', persist: 'session' },
                message: 'Allow tool call?',
                requestedSchema: { type: 'object', properties: {} },
            };

            await fixture.sendServerRequest('mcpServer/elicitation/request', params);
            await expect(fixture.getAcpConnectionDump(['_meta'])).toMatchFileSnapshot('data/elicitation-tool-approval-session-only.json');

            completeTurn();
            await promptPromise;
        });

        it('should show only Allow and Decline when no persist options', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({ outcome: { outcome: 'selected', optionId: McpApprovalOptionId.AllowOnce } });

            const params: McpServerElicitationRequestParams = {
                threadId: sessionId, turnId: 'turn-1', serverName: 'tool-server',
                mode: 'form',
                _meta: { codex_approval_kind: 'mcp_tool_call' },
                message: 'Allow tool call?',
                requestedSchema: { type: 'object', properties: {} },
            };

            await fixture.sendServerRequest('mcpServer/elicitation/request', params);
            await expect(fixture.getAcpConnectionDump(['_meta'])).toMatchFileSnapshot('data/elicitation-tool-approval-no-persist.json');

            completeTurn();
            await promptPromise;
        });

        it('should not reuse a completed auto-approved call id for a later approval request', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({ outcome: { outcome: 'selected', optionId: McpApprovalOptionId.AllowOnce } });

            const startedNotification: ServerNotification = {
                method: 'item/started',
                params: {
                    threadId: sessionId,
                    turnId: 'turn-1',
                    startedAtMs: 0,
                    item: {
                        type: "mcpToolCall",
                        id: "completed-call-id",
                        server: "tool-server",
                        tool: "tool-name",
                        status: "inProgress",
                        arguments: { argument: "example" },
                        appContext: null,
                        pluginId: null,
                        result: null,
                        error: null,
                        durationMs: null,
                    },
                },
            };
            const completedNotification: ServerNotification = {
                method: 'item/completed',
                params: {
                    threadId: sessionId,
                    turnId: 'turn-1',
                    completedAtMs: 0,
                    item: {
                        type: "mcpToolCall",
                        id: "completed-call-id",
                        server: "tool-server",
                        tool: "tool-name",
                        status: "completed",
                        arguments: { argument: "example" },
                        appContext: null,
                        pluginId: null,
                        result: { content: [], structuredContent: null, _meta: null },
                        error: null,
                        durationMs: 15,
                    },
                },
            };

            fixture.sendServerNotification(startedNotification);
            fixture.sendServerNotification(completedNotification);
            await fixture.getCodexAcpClient().waitForSessionNotifications(sessionId);
            fixture.clearAcpConnectionDump();

            const params: McpServerElicitationRequestParams = {
                threadId: sessionId, turnId: 'turn-2', serverName: 'tool-server',
                mode: 'form',
                _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'] },
                message: 'Allow tool call?',
                requestedSchema: { type: 'object', properties: {} },
            };

            await fixture.sendServerRequest('mcpServer/elicitation/request', params);

            const [requestPermissionEvent] = fixture.getAcpConnectionEvents(['_meta']);
            expect(requestPermissionEvent?.method).toBe('requestPermission');
            expect(requestPermissionEvent?.args[0].toolCall.toolCallId).toBe('elicitation-tool-server');

            completeTurn();
            await promptPromise;
        });

        it('should not reuse a stale call id after serverRequest/resolved clears interrupted approval state', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({ outcome: { outcome: 'selected', optionId: McpApprovalOptionId.AllowOnce } });

            const startedNotification: ServerNotification = {
                method: 'item/started',
                params: {
                    threadId: sessionId,
                    turnId: 'turn-1',
                    startedAtMs: 0,
                    item: {
                        type: "mcpToolCall",
                        id: "interrupted-call-id",
                        server: "tool-server",
                        tool: "tool-name",
                        status: "inProgress",
                        arguments: { argument: "example" },
                        appContext: null,
                        pluginId: null,
                        result: null,
                        error: null,
                        durationMs: null,
                    },
                },
            };
            const resolvedNotification: ServerNotification = {
                method: 'serverRequest/resolved',
                params: {
                    threadId: sessionId,
                    requestId: 'request-1',
                },
            };

            fixture.sendServerNotification(startedNotification);
            fixture.sendServerNotification(resolvedNotification);
            await fixture.getCodexAcpClient().waitForSessionNotifications(sessionId);
            fixture.clearAcpConnectionDump();

            const params: McpServerElicitationRequestParams = {
                threadId: sessionId, turnId: 'turn-2', serverName: 'tool-server',
                mode: 'form',
                _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'] },
                message: 'Allow tool call?',
                requestedSchema: { type: 'object', properties: {} },
            };

            await fixture.sendServerRequest('mcpServer/elicitation/request', params);

            const [requestPermissionEvent] = fixture.getAcpConnectionEvents(['_meta']);
            expect(requestPermissionEvent?.method).toBe('requestPermission');
            expect(requestPermissionEvent?.args[0].toolCall.toolCallId).toBe('elicitation-tool-server');

            completeTurn();
            await promptPromise;
        });
    });

    describe('URL mode elicitation', () => {
        it('should use ACP URL elicitation when the client supports it', async () => {
            const { promptPromise, completeTurn } = await setupSessionWithPendingPromptAndCapabilities({
                elicitation: { url: {} },
            });
            fixture.setElicitationResponse({ action: 'accept', _meta: { source: 'client' } });

            const params: McpServerElicitationRequestParams = {
                threadId: sessionId, turnId: 'turn-1', serverName: 'auth-server',
                mode: 'url', _meta: null, message: 'Please authorize access',
                url: 'https://example.com/authorize', elicitationId: 'elicit-123',
            };

            const response = await fixture.sendServerRequest('mcpServer/elicitation/request', params);
            expect(response).toEqual({ action: 'accept', content: null, _meta: { source: 'client' } });

            const [elicitationEvent] = fixture.getAcpConnectionEvents([]);
            expect(elicitationEvent).toEqual({
                method: 'createElicitation',
                args: [{
                    sessionId,
                    mode: 'url',
                    message: 'Please authorize access',
                    url: 'https://example.com/authorize',
                    elicitationId: 'elicit-123',
                    _meta: null,
                }],
            });

            fixture.sendServerNotification({
                method: 'serverRequest/resolved',
                params: {
                    threadId: sessionId,
                    requestId: 'request-1',
                },
            });
            await fixture.getCodexAcpClient().waitForSessionNotifications(sessionId);

            const [, completeElicitationEvent] = fixture.getAcpConnectionEvents([]);
            expect(completeElicitationEvent).toEqual({
                method: 'completeElicitation',
                args: [{ elicitationId: 'elicit-123' }],
            });

            completeTurn();
            await promptPromise;
        });

        it('should map accept to accept for URL mode', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({ outcome: { outcome: 'selected', optionId: 'accept' } });

            const params: McpServerElicitationRequestParams = {
                threadId: sessionId, turnId: 'turn-1', serverName: 'auth-server',
                mode: 'url', _meta: null, message: 'Please authorize access',
                url: 'https://example.com/authorize', elicitationId: 'elicit-123',
            };

            const response = await fixture.sendServerRequest('mcpServer/elicitation/request', params);
            expect(response).toEqual({ action: 'accept', content: null, _meta: null });

            completeTurn();
            await promptPromise;
        });

        it('should return cancel when user dismisses URL mode dialog', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({ outcome: { outcome: 'cancelled' } });

            const params: McpServerElicitationRequestParams = {
                threadId: sessionId, turnId: null, serverName: 'auth-server',
                mode: 'url', _meta: null, message: 'Authorization required',
                url: 'https://example.com/authorize', elicitationId: 'elicit-456',
            };

            const response = await fixture.sendServerRequest('mcpServer/elicitation/request', params);
            expect(response).toEqual({ action: 'cancel', content: null, _meta: null });

            completeTurn();
            await promptPromise;
        });

        it('should build correct ACP permission request for URL mode', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({ outcome: { outcome: 'selected', optionId: 'accept' } });

            const params: McpServerElicitationRequestParams = {
                threadId: sessionId, turnId: 'turn-1', serverName: 'auth-server',
                mode: 'url', _meta: null,
                message: 'Please authorize access to your GitHub account',
                url: 'https://example.com/authorize?id=elicit-789',
                elicitationId: 'elicit-789',
            };

            await fixture.sendServerRequest('mcpServer/elicitation/request', params);
            await expect(fixture.getAcpConnectionDump(['_meta'])).toMatchFileSnapshot('data/elicitation-url-accept.json');

            completeTurn();
            await promptPromise;
        });
    });
});

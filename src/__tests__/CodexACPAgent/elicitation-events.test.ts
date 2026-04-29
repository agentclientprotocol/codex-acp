import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpServerStdio } from '@agentclientprotocol/sdk';
import type { McpServerElicitationRequestParams } from '../../app-server/v2';
import { createCodexMockTestFixture, createTestSessionState, type CodexMockTestFixture } from '../acp-test-utils';
import type { SessionState } from '../../CodexAcpServer';
import { AgentMode } from "../../AgentMode";
import type { ServerNotification } from "../../app-server";

describe('Elicitation Events', () => {
    let fixture: CodexMockTestFixture;
    const sessionId = 'test-session-id';

    beforeEach(() => {
        fixture = createCodexMockTestFixture();
        vi.clearAllMocks();
    });

    function setupSessionWithPendingPrompt(sessionOverrides?: Partial<SessionState>) {
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
            agentMode: AgentMode.DEFAULT_AGENT_MODE,
            ...sessionOverrides,
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

    describe('Form mode elicitation', () => {
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
        it('should show Allow/session/always/Cancel options when all persist values advertised', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({ outcome: { outcome: 'selected', optionId: 'allow_once' } });

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

        it('should include CLI-style descriptions for MCP tool approval options', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({ outcome: { outcome: 'selected', optionId: 'allow_once' } });

            const params: McpServerElicitationRequestParams = {
                threadId: sessionId, turnId: 'turn-1', serverName: 'tool-server',
                mode: 'form',
                _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'] },
                message: 'Allow tool call?',
                requestedSchema: { type: 'object', properties: {} },
            };

            await fixture.sendServerRequest('mcpServer/elicitation/request', params);
            const [requestPermissionEvent] = fixture.getAcpConnectionEvents([]);
            expect(requestPermissionEvent?.args[0].options).toEqual([
                {
                    optionId: 'allow_once',
                    name: 'Allow',
                    kind: 'allow_once',
                    _meta: { description: 'Run the tool and continue.' },
                },
                {
                    optionId: 'allow_session',
                    name: 'Allow for this session',
                    kind: 'allow_always',
                    _meta: { description: 'Run the tool and remember this choice for this session.' },
                },
                {
                    optionId: 'allow_persist',
                    name: 'Always allow',
                    kind: 'allow_always',
                    _meta: { description: 'Run the tool and remember this choice for future tool calls.' },
                },
                {
                    optionId: 'decline',
                    name: 'Cancel',
                    kind: 'reject_once',
                    _meta: { description: 'Cancel this tool call.' },
                },
            ]);

            completeTurn();
            await promptPromise;
        });

        it('should map allow_once to accept with null meta', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({ outcome: { outcome: 'selected', optionId: 'allow_once' } });

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
            fixture.setPermissionResponse({ outcome: { outcome: 'selected', optionId: 'allow_session' } });

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

        it('should map persistent approval to accept with persist:always meta', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({ outcome: { outcome: 'selected', optionId: 'allow_persist' } });

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

        it('should persist only the approved MCP server before returning persistent approval meta', async () => {
            const mcpServer: McpServerStdio = {
                name: 'tool-server',
                command: 'npx',
                args: ['tool-server'],
                env: [{ name: 'FOO', value: 'bar' }],
            };
            const otherServer: McpServerStdio = {
                name: 'other-server',
                command: 'npx',
                args: ['other-server'],
                env: [],
            };
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt({
                sessionMcpServers: new Map([
                    [mcpServer.name, mcpServer],
                    [otherServer.name, otherServer],
                ]),
            });
            const configBatchWriteSpy = vi.spyOn(fixture.getCodexAppServerClient(), 'configBatchWrite').mockResolvedValue({
                status: 'ok',
                version: '1',
                filePath: '/tmp/config.toml',
                overriddenMetadata: null,
            });
            fixture.setPermissionResponse({ outcome: { outcome: 'selected', optionId: 'allow_persist' } });

            const params: McpServerElicitationRequestParams = {
                threadId: sessionId, turnId: 'turn-1', serverName: 'tool-server',
                mode: 'form',
                _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'] },
                message: 'Allow tool call?',
                requestedSchema: { type: 'object', properties: {} },
            };

            const response = await fixture.sendServerRequest('mcpServer/elicitation/request', params);
            expect(response).toEqual({ action: 'accept', content: null, _meta: { persist: 'always' } });
            expect(configBatchWriteSpy).toHaveBeenCalledTimes(1);
            expect(configBatchWriteSpy).toHaveBeenCalledWith({
                edits: [{
                    keyPath: 'mcp_servers.tool-server',
                    value: {
                        command: 'npx',
                        args: ['tool-server'],
                        env: { FOO: 'bar' },
                    },
                    mergeStrategy: 'upsert',
                }],
                filePath: null,
                expectedVersion: null,
                reloadUserConfig: true,
            });

            completeTurn();
            await promptPromise;
        });

        it('should only show session option when persist is "session"', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({ outcome: { outcome: 'selected', optionId: 'allow_once' } });

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

        it('should show only Allow and Cancel when no persist options', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({ outcome: { outcome: 'selected', optionId: 'allow_once' } });

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
            fixture.setPermissionResponse({ outcome: { outcome: 'selected', optionId: 'allow_once' } });

            const startedNotification: ServerNotification = {
                method: 'item/started',
                params: {
                    threadId: sessionId,
                    turnId: 'turn-1',
                    item: {
                        type: "mcpToolCall",
                        id: "completed-call-id",
                        server: "tool-server",
                        tool: "tool-name",
                        status: "inProgress",
                        arguments: { argument: "example" },
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
                    item: {
                        type: "mcpToolCall",
                        id: "completed-call-id",
                        server: "tool-server",
                        tool: "tool-name",
                        status: "completed",
                        arguments: { argument: "example" },
                        result: { content: [], structuredContent: null, _meta: null },
                        error: null,
                        durationMs: 15,
                    },
                },
            };

            fixture.sendServerNotification(startedNotification);
            fixture.sendServerNotification(completedNotification);
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
            fixture.setPermissionResponse({ outcome: { outcome: 'selected', optionId: 'allow_once' } });

            const startedNotification: ServerNotification = {
                method: 'item/started',
                params: {
                    threadId: sessionId,
                    turnId: 'turn-1',
                    item: {
                        type: "mcpToolCall",
                        id: "interrupted-call-id",
                        server: "tool-server",
                        tool: "tool-name",
                        status: "inProgress",
                        arguments: { argument: "example" },
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

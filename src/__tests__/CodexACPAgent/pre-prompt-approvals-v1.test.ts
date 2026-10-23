import {afterEach, describe, expect, it} from 'vitest';
import {CommandExecutionApprovalRequest, FileChangeApprovalRequest, PermissionsApprovalRequest} from '../../CodexAppServerClient';
import {connectSession, sessionId, turnId, cwd, type PromptSession} from './v2-prompt-harness';

/**
 * `installSessionState()` registers a baseline Codex-turn tracker (with deny-all approval/
 * elicitation handlers) for every session, on ACP v1 too, as soon as `session/new` completes --
 * before any `session/prompt` has run. Pin that a Codex approval/elicitation/user-input request
 * for such a session still gets exactly the same reply app-server itself defaults to for a
 * thread with no handler registered, so v1's pre-prompt wire behavior is unchanged.
 */
describe('pre-prompt Codex approval/elicitation requests on ACP v1', () => {
    let closeClient: (() => void) | null = null;

    afterEach(() => {
        closeClient?.();
        closeClient = null;
    });

    async function connectV1(): Promise<PromptSession> {
        const client = await connectSession(1);
        closeClient = () => client.connection.close();
        return client;
    }

    it('declines a command execution approval with no prompt running', async () => {
        const client = await connectV1();

        const response = await client.triggerApproval(CommandExecutionApprovalRequest.method, {
            kind: "command",
            threadId: sessionId,
            turnId,
            itemId: "cmd-item-1",
            startedAtMs: 0,
            environmentId: null,
            command: "ls -la",
            cwd,
        });

        expect(response).toEqual({decision: "cancel"});
    });

    it('declines a file-change approval with no prompt running', async () => {
        const client = await connectV1();

        const response = await client.triggerApproval(FileChangeApprovalRequest.method, {
            threadId: sessionId,
            turnId,
            itemId: "edit-item-1",
            startedAtMs: 0,
        });

        expect(response).toEqual({decision: "cancel"});
    });

    it('grants no permissions for a permissions-request approval with no prompt running', async () => {
        const client = await connectV1();

        const response = await client.triggerApproval(PermissionsApprovalRequest.method, {
            threadId: sessionId,
            turnId,
            itemId: "perm-item-1",
            environmentId: null,
            startedAtMs: 0,
            cwd,
            reason: null,
            permissions: {},
        });

        expect(response).toEqual({permissions: {}, scope: "turn", strictAutoReview: false});
    });

    it('cancels an MCP elicitation with no prompt running', async () => {
        const client = await connectV1();

        const response = await client.triggerApproval('mcpServer/elicitation/request', {
            threadId: sessionId,
            turnId: null,
            serverName: "test-server",
            mode: "form",
            _meta: null,
            message: "Need input",
            requestedSchema: {type: "object", properties: {}},
        });

        expect(response).toEqual({action: "cancel", content: null, _meta: null});
    });

    it('answers an empty response for a tool user-input request with no prompt running', async () => {
        const client = await connectV1();

        const response = await client.triggerApproval('item/tool/requestUserInput', {
            threadId: sessionId,
            turnId,
            itemId: "tool-item-1",
            questions: [],
            isBlocking: true,
            autoResolutionMs: null,
        });

        expect(response).toEqual({answers: {}});
    });
});

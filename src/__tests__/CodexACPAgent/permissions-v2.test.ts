import {afterEach, describe, expect, it, vi} from 'vitest';
import * as acpV2 from '@agentclientprotocol/sdk/experimental/v2';
import {CommandExecutionApprovalRequest, FileChangeApprovalRequest} from '../../CodexAppServerClient';
import type {
    CommandExecutionRequestApprovalParams,
    FileChangeRequestApprovalParams,
} from '../../app-server/v2';
import {
    sessionId,
    turnId,
    cwd,
    connectSession,
    userMessageItem,
    itemCompleted,
    turnStarted,
    turnCompleted,
    settle,
    stateUpdates,
    indexOf,
    isState,
    dump,
    type PromptSession,
} from './v2-prompt-harness';
import {expectConformingV2SessionUpdates} from './v2-session-update-guard';

/** Starts a prompt and leaves `turn/start` pending, so the approval handler is registered but no turn is running. */
async function startPromptWithPendingTurn(client: PromptSession) {
    let releaseTurnStart!: () => void;
    const turnStartGate = new Promise<void>((resolve) => {
        releaseTurnStart = resolve;
    });
    client.setTurnStart(async () => {
        await turnStartGate;
        return {turn: {id: turnId, items: [], itemsView: "notLoaded" as const, status: "inProgress" as const, error: null, startedAt: null, completedAt: null, durationMs: null}};
    });
    const response = client.sendPrompt([{type: "text", text: "Hello"}]);
    await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
    return {
        response,
        finishTurn: async () => {
            releaseTurnStart();
            const clientUserMessageId = client.turnStartParams[0]!["clientUserMessageId"] as string;
            client.emit(turnStarted());
            client.emit(itemCompleted(userMessageItem(clientUserMessageId)));
            await response;
            client.emit(turnCompleted());
            await client.promptRunFinished();
        },
    };
}

function commandApprovalParams(overrides: Partial<CommandExecutionRequestApprovalParams> = {}): CommandExecutionRequestApprovalParams {
    return {
        kind: "command",
        threadId: sessionId,
        turnId,
        itemId: "cmd-item-1",
        startedAtMs: 0,
        environmentId: null,
        command: "ls -la",
        cwd,
        ...overrides,
    };
}

function fileChangeApprovalParams(overrides: Partial<FileChangeRequestApprovalParams> = {}): FileChangeRequestApprovalParams {
    return {
        threadId: sessionId,
        turnId,
        itemId: "edit-item-1",
        startedAtMs: 0,
        ...overrides,
    };
}

describe('session/request_permission over ACP v2', () => {
    let closeClient: (() => void) | null = null;

    afterEach(() => {
        closeClient?.();
        closeClient = null;
        vi.clearAllMocks();
        expectConformingV2SessionUpdates();
    });

    it('sends a command approval request in the v2 shape and applies the allowed decision', async () => {
        const client = await connectSession(2, {
            onRequestPermission: async () => ({outcome: {outcome: "selected", optionId: "allow_once"}}),
        });
        closeClient = () => client.connection.close();
        const {finishTurn} = await startPromptWithPendingTurn(client);
        const start = client.transcript.length;

        const response = await client.triggerApproval(CommandExecutionApprovalRequest.method, commandApprovalParams());

        expect(response).toEqual({decision: "accept"});
        const transcript = client.transcript.slice(start);
        expect(stateUpdates(transcript)).toEqual([{state: "requires_action"}, {state: "running"}]);
        const requiresAction = indexOf(transcript, isState("requires_action"));
        const running = indexOf(transcript, isState("running"));
        const permission = indexOf(transcript, entry => "permissionRequest" in entry);
        expect(requiresAction).toBeLessThan(permission);
        expect(permission).toBeLessThan(running);
        await expect(dump(transcript)).toMatchFileSnapshot('data/permissions-v2-command-allowed.json');

        await finishTurn();
    });

    it('sends a command approval request and applies the rejected decision', async () => {
        const client = await connectSession(2, {
            onRequestPermission: async () => ({outcome: {outcome: "selected", optionId: "decline"}}),
        });
        closeClient = () => client.connection.close();
        const {finishTurn} = await startPromptWithPendingTurn(client);
        const start = client.transcript.length;

        const response = await client.triggerApproval(CommandExecutionApprovalRequest.method, commandApprovalParams());

        expect(response).toEqual({decision: "decline"});
        const transcript = client.transcript.slice(start);
        expect(stateUpdates(transcript)).toEqual([{state: "requires_action"}, {state: "running"}]);
        await expect(dump(transcript)).toMatchFileSnapshot('data/permissions-v2-command-rejected.json');

        await finishTurn();
    });

    it('sends a file-change approval request in the v2 shape and applies the selected decision', async () => {
        const client = await connectSession(2, {
            onRequestPermission: async () => ({outcome: {outcome: "selected", optionId: "allow_once"}}),
        });
        closeClient = () => client.connection.close();
        const {finishTurn} = await startPromptWithPendingTurn(client);
        const start = client.transcript.length;

        const response = await client.triggerApproval(FileChangeApprovalRequest.method, fileChangeApprovalParams());

        expect(response).toEqual({decision: "accept"});
        const transcript = client.transcript.slice(start);
        expect(stateUpdates(transcript)).toEqual([{state: "requires_action"}, {state: "running"}]);
        await expect(dump(transcript)).toMatchFileSnapshot('data/permissions-v2-file-change-allowed.json');

        await finishTurn();
    });

    it('cancels the decision when the client returns a cancelled outcome', async () => {
        const client = await connectSession(2, {
            onRequestPermission: async () => ({outcome: {outcome: "cancelled"}}),
        });
        closeClient = () => client.connection.close();
        const {finishTurn} = await startPromptWithPendingTurn(client);
        const start = client.transcript.length;

        const response = await client.triggerApproval(CommandExecutionApprovalRequest.method, commandApprovalParams());

        expect(response).toEqual({decision: "cancel"});
        const transcript = client.transcript.slice(start);
        // `requires_action`/`running` still bracket the request even though it was cancelled.
        expect(stateUpdates(transcript)).toEqual([{state: "requires_action"}, {state: "running"}]);

        await finishTurn();
    });

    it('cancels the decision when the client answers with an unknown v2 outcome (ACP-ENUM-203)', async () => {
        const client = await connectSession(2, {
            onRequestPermission: async () => ({outcome: {outcome: "some_future_outcome"} as unknown as acpV2.RequestPermissionOutcome}),
        });
        closeClient = () => client.connection.close();
        const {finishTurn} = await startPromptWithPendingTurn(client);

        const response = await client.triggerApproval(CommandExecutionApprovalRequest.method, commandApprovalParams());

        expect(response).toEqual({decision: "cancel"});
        await finishTurn();
    });

    it('cancels the decision and still resumes `running` when the client request errors', async () => {
        const client = await connectSession(2, {
            onRequestPermission: async () => {
                throw new Error("client failed to answer");
            },
        });
        closeClient = () => client.connection.close();
        const {finishTurn} = await startPromptWithPendingTurn(client);
        const start = client.transcript.length;

        const response = await client.triggerApproval(CommandExecutionApprovalRequest.method, commandApprovalParams());

        expect(response).toEqual({decision: "cancel"});
        // `running` still fires even though the request itself failed.
        expect(stateUpdates(client.transcript.slice(start))).toEqual([{state: "requires_action"}, {state: "running"}]);

        await finishTurn();
    });

    it('sends the plan-implementation permission request on the real v2 send path and honors approval', async () => {
        const client = await connectSession(2, {
            onRequestPermission: async () => ({outcome: {outcome: "selected", optionId: "implement_plan"}}),
        });
        closeClient = () => client.connection.close();

        // Switch into plan mode first; `/plan` is a local command and starts no turn.
        await client.sendPrompt([{type: "text", text: "/plan"}]);
        await client.promptRunFinished(0);
        await settle();
        expect(client.turnStartParams).toEqual([]);
        const start = client.transcript.length;

        const response = client.sendPrompt([{type: "text", text: "Hello"}]);
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
        const clientUserMessageId = client.turnStartParams[0]!["clientUserMessageId"] as string;
        client.emit(turnStarted());
        client.emit(itemCompleted(userMessageItem(clientUserMessageId)));
        const {messageId} = await response;
        client.emit(itemCompleted({type: "plan", id: "plan-item", text: "1. Do the change."}));
        client.emit(turnCompleted());

        // Approval is granted over the real v2 wire, so codex-acp starts the "Implement the
        // approved plan." turn itself, still inside this same prompt.
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(2));
        const implementationId = client.turnStartParams[1]!["clientUserMessageId"] as string;
        client.emit(turnStarted("turn-2"));
        client.emit(itemCompleted(userMessageItem(implementationId, "Implement the approved plan."), "turn-2"));
        client.emit(turnCompleted("turn-2"));
        await client.promptRunFinished(1);
        await settle();

        const transcript = client.transcript.slice(start);
        const permissionRequests = transcript.flatMap(entry => "permissionRequest" in entry ? [entry.permissionRequest] : []);
        expect(permissionRequests).toEqual([expect.objectContaining({
            sessionId,
            title: "Implement this plan?",
            subject: {
                type: "tool_call",
                toolCall: expect.objectContaining({kind: "switch_mode", status: "pending"}),
            },
            options: [
                {optionId: "implement_plan", name: "Yes, implement this plan", kind: "allow_once"},
                {optionId: "revise_plan", name: "No, and tell Codex what to do differently", kind: "reject_once"},
            ],
        })]);
        // The prompt's own `running` (from insertion) brackets the whole exchange; the permission
        // request additionally brackets itself with `requires_action`/`running` while it is pending.
        expect(stateUpdates(transcript)).toEqual([
            {state: "running"},
            {state: "requires_action"},
            {state: "running"},
            {state: "idle", stopReason: "end_turn"},
        ]);
        await expect(dump(transcript, messageId).replaceAll(implementationId, "<implementationId>"))
            .toMatchFileSnapshot('data/permissions-v2-plan-implementation.json');
    });
});

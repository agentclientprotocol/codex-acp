import {afterEach, describe, expect, it, vi} from 'vitest';
import {ResponseError} from 'vscode-jsonrpc';
import {SESSION_STEERING_METHOD} from '../../AcpExtensions';
import {
    sessionId, connectSession, userMessageItem, itemStarted, itemCompleted,
    turnStarted, turnCompleted, turnFinished, settle, stateUpdates,
    type PromptSession,
} from './v2-prompt-harness';
import {expectConformingV2SessionUpdates} from './v2-session-update-guard';

type SteerParams = {threadId: string; expectedTurnId: string; clientUserMessageId: string};

async function startPrompt(client: PromptSession, version: 1 | 2 = 2): Promise<void> {
    const response = client.sendPrompt([{type: 'text', text: 'Write a long paragraph.'}]);
    await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
    client.emit(turnStarted());
    client.emit(itemCompleted(userMessageItem(client.turnStartParams[0]!['clientUserMessageId'] as string)));
    if (version === 2) await response;
}

function userMessages(client: PromptSession) {
    return client.transcript.flatMap(entry => 'sessionUpdate' in entry ? [entry.sessionUpdate] : [])
        .flatMap(update => update.sessionUpdate === 'user_message_chunk' ? [{messageId: update.messageId, content: update.content}] : []);
}

describe('native v2 prompt steering', () => {
    let client: PromptSession;
    let steers: SteerParams[];

    afterEach(() => {
        client?.connection.close();
        vi.clearAllMocks();
        expectConformingV2SessionUpdates();
    });

    async function connect(version: 1 | 2 = 2): Promise<void> {
        client = await connectSession(version);
        steers = [];
        client.setCodexResponse('turn/steer', async params => {
            steers.push(params as SteerParams);
            return {};
        });
        await startPrompt(client, version);
    }

    it.each([1, 2] as const)('delivers a follow-up during generation in v%s without restarting the turn', async version => {
        await connect(version);
        const response = version === 1
            ? client.request(SESSION_STEERING_METHOD, {sessionId, prompt: [{type: 'text', text: 'Answer briefly instead.'}]})
            : client.sendPrompt([{type: 'text', text: 'Answer briefly instead.'}]);
        await vi.waitFor(() => expect(steers).toHaveLength(1));
        await settle();
        if (version === 2) {
            expect(client.transcript.filter(entry => 'promptResponse' in entry)).toHaveLength(1);
            client.emit(itemCompleted(userMessageItem('other-client', 'Unrelated')));
            await settle();
            expect(userMessages(client)).toHaveLength(1);
        }
        const messageId = steers[0]!.clientUserMessageId;
        client.emit(itemStarted(userMessageItem(messageId, 'Answer briefly instead.')));
        client.emit(itemCompleted(userMessageItem(messageId, 'Answer briefly instead.')));
        expect(await response).toEqual(version === 1 ? {outcome: 'injected'} : {messageId});
        expect(client.turnStartParams).toHaveLength(1);
        expect(client.turnInterruptCalls()).toEqual([]);
        if (version === 2) {
            expect(stateUpdates(client.transcript)).toEqual([{state: 'running'}]);
            expect(userMessages(client)).toHaveLength(2);
        }
        client.emit(turnCompleted());
        await client.promptRunFinished();
        await settle();
        if (version === 2) expect(stateUpdates(client.transcript))
            .toEqual([{state: 'running'}, {state: 'idle', stopReason: 'end_turn'}]);
    });

    it('inserts several follow-ups in order within one running turn', async () => {
        await connect();
        const second = client.sendPrompt([{type: 'text', text: 'Two'}]);
        const third = client.sendPrompt([{type: 'text', text: 'Three'}]);
        await vi.waitFor(() => expect(steers).toHaveLength(1));
        client.emit(itemCompleted(userMessageItem(steers[0]!.clientUserMessageId, 'Two')));
        await second;
        await vi.waitFor(() => expect(steers).toHaveLength(2));
        client.emit(itemCompleted(userMessageItem(steers[1]!.clientUserMessageId, 'Three')));
        await third;
        expect(steers[1]!.clientUserMessageId).not.toBe(steers[0]!.clientUserMessageId);
        expect(userMessages(client).map(update => update.content)).toEqual([
            {type: 'text', text: 'Write a long paragraph.'},
            {type: 'text', text: 'Two'}, {type: 'text', text: 'Three'},
        ]);
        expect(client.turnStartParams).toHaveLength(1);
        client.emit(turnCompleted());
        await client.promptRunFinished();
        await settle();
        expect(stateUpdates(client.transcript)).toEqual([{state: 'running'}, {state: 'idle', stopReason: 'end_turn'}]);
    });

    it.each(['resolve', 'reject'] as const)('accepts a recorded input before a late steer response can %s', async outcome => {
        await connect();
        let finish!: () => void;
        const pending = new Promise<void>((resolve, reject) => {
            finish = outcome === 'resolve' ? resolve : () => reject(new Error('Late transport failure'));
        });
        client.setCodexResponse('turn/steer', async params => {
            steers.push(params as SteerParams);
            await pending;
            return {};
        });
        const response = client.sendPrompt([{type: 'text', text: 'Next'}]);
        await vi.waitFor(() => expect(steers).toHaveLength(1));
        const messageId = steers[0]!.clientUserMessageId;
        client.emit(itemCompleted(userMessageItem(messageId, 'Next')));
        expect(await response).toEqual({messageId});
        finish();
        await settle();
        expect(client.transcript.filter(entry => 'promptError' in entry)).toEqual([]);
        client.emit(turnCompleted());
        await client.promptRunFinished();
    });

    it('starts one new turn when the active turn ends before steering can accept the input', async () => {
        await connect();
        let rejectSteer!: (error: unknown) => void;
        client.setCodexResponse('turn/steer', async params => {
            steers.push(params as SteerParams);
            return await new Promise((_, reject) => { rejectSteer = reject; });
        });
        const response = client.sendPrompt([{type: 'text', text: 'Next'}]);
        await vi.waitFor(() => expect(steers).toHaveLength(1));
        client.emit(turnCompleted());
        await client.promptRunFinished();
        rejectSteer(new ResponseError(-32600, 'No active turn to steer'));
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(2));
        const messageId = client.turnStartParams[1]!['clientUserMessageId'] as string;
        expect(messageId).toBe(steers[0]!.clientUserMessageId);
        client.emit(turnStarted('turn-2'));
        client.emit(itemCompleted(userMessageItem(messageId, 'Next'), 'turn-2'));
        expect(await response).toEqual({messageId});
        client.emit(turnCompleted('turn-2'));
        await client.promptRunFinished(1);
        await settle();
        expect(userMessages(client)).toHaveLength(2);
        expect(stateUpdates(client.transcript)).toEqual([
            {state: 'running'}, {state: 'idle', stopReason: 'end_turn'},
            {state: 'running'}, {state: 'idle', stopReason: 'end_turn'},
        ]);
    });

    it.each(['completed', 'interrupted'] as const)('rejects input that a %s turn never recorded without retrying', async status => {
        await connect();
        const response = client.sendPrompt([{type: 'text', text: 'Never inserted'}]);
        await vi.waitFor(() => expect(steers).toHaveLength(1));
        client.emit(turnFinished(status));
        await expect(response).rejects.toMatchObject({code: status === 'interrupted' ? -32800 : -32603});
        await client.promptRunFinished();
        await settle();
        expect(client.turnStartParams).toHaveLength(1);
        expect(userMessages(client)).toHaveLength(1);
    });

    it.each(['cancel', 'close'] as const)('settles an uninserted follow-up when session/%s stops its turn', async method => {
        await connect();
        const response = client.sendPrompt([{type: 'text', text: 'Pending'}]);
        await vi.waitFor(() => expect(steers).toHaveLength(1));
        const stopping = method === 'cancel' ? client.cancel() : client.request('session/close', {sessionId});
        await vi.waitFor(() => expect(client.turnInterruptCalls()).toHaveLength(1));
        client.emit(turnFinished('interrupted'));
        await stopping;
        await expect(response).rejects.toMatchObject({code: -32800});
        await client.promptRunFinished();
        await settle();
        expect(userMessages(client)).toHaveLength(1);
        expect(stateUpdates(client.transcript)).toEqual([{state: 'running'}, {state: 'idle', stopReason: 'cancelled'}]);
    });

    it('reports a rejected steer without stopping the active turn', async () => {
        await connect();
        client.setCodexResponse('turn/steer', async () => {
            throw new ResponseError(-32602, 'Invalid input');
        });
        await expect(client.sendPrompt([{type: 'text', text: 'Rejected'}]))
            .rejects.toMatchObject({code: -32602});
        expect(userMessages(client)).toHaveLength(1);
        expect(stateUpdates(client.transcript)).toEqual([{state: 'running'}]);
        expect(client.turnInterruptCalls()).toEqual([]);
        client.emit(turnCompleted());
        await client.promptRunFinished();
    });

    it('drops a cancelled follow-up before its steering dispatch and keeps the earlier input', async () => {
        await connect();
        const second = client.sendPrompt([{type: 'text', text: 'Two'}]);
        await vi.waitFor(() => expect(steers).toHaveLength(1));
        const controller = new AbortController();
        const third = client.sendPrompt([{type: 'text', text: 'Three'}], controller.signal);
        await settle();
        controller.abort();
        client.emit(itemCompleted(userMessageItem(steers[0]!.clientUserMessageId, 'Two')));
        await second;
        await expect(third).rejects.toMatchObject({code: -32800});
        expect(steers).toHaveLength(1);
        expect(userMessages(client)).toHaveLength(2);
        expect(client.turnInterruptCalls()).toEqual([]);
        client.emit(turnCompleted());
        await client.promptRunFinished();
    });

    it('does not interrupt the active turn when an in-flight follow-up request is cancelled', async () => {
        await connect();
        const controller = new AbortController();
        const response = client.sendPrompt([{type: 'text', text: 'Pending'}], controller.signal);
        await vi.waitFor(() => expect(steers).toHaveLength(1));
        controller.abort();
        await settle();
        expect(client.turnInterruptCalls()).toEqual([]);
        const messageId = steers[0]!.clientUserMessageId;
        client.emit(itemCompleted(userMessageItem(messageId, 'Pending')));
        expect(await response).toEqual({messageId});
        client.emit(turnCompleted());
        await client.promptRunFinished();
    });
});

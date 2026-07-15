import {describe, expect, it, vi} from 'vitest';
import type {MessageConnection} from 'vscode-jsonrpc/node';
import {CodexAppServerClient} from '../CodexAppServerClient';
import type {DynamicToolCallParams, DynamicToolCallResponse} from '../app-server/v2';
import type {ServerNotification} from '../app-server';

const DYNAMIC_TOOL_METHOD = 'item/tool/call';

type SharedConnectionFixture = {
    connection: MessageConnection;
    requestRegistrationCount(method: string): number;
    sendRequest<T>(method: string, params: unknown): Promise<T>;
    sendNotification(notification: ServerNotification): void;
};

function createSharedConnectionFixture(): SharedConnectionFixture {
    const requestHandlers = new Map<string, (params: unknown) => Promise<unknown>>();
    const requestRegistrationCounts = new Map<string, number>();
    let notificationHandler: ((notification: unknown) => void) | null = null;

    const connection = {
        onUnhandledNotification(handler: (notification: unknown) => void) {
            notificationHandler = handler;
            return {dispose() { notificationHandler = null; }};
        },
        onRequest(type: {method: string}, handler: (params: unknown) => Promise<unknown>) {
            requestHandlers.set(type.method, handler);
            requestRegistrationCounts.set(type.method, (requestRegistrationCounts.get(type.method) ?? 0) + 1);
            return {dispose() { requestHandlers.delete(type.method); }};
        },
        sendRequest: vi.fn(),
    } as unknown as MessageConnection;

    return {
        connection,
        requestRegistrationCount(method) {
            return requestRegistrationCounts.get(method) ?? 0;
        },
        async sendRequest<T>(method: string, params: unknown): Promise<T> {
            const handler = requestHandlers.get(method);
            if (!handler) {
                throw new Error(`No request handler registered for ${method}`);
            }
            return await handler(params) as T;
        },
        sendNotification(notification) {
            if (!notificationHandler) {
                throw new Error('No notification handler registered');
            }
            notificationHandler(notification);
        },
    };
}

function dynamicToolParams(threadId: string, turnId = 'turn-1'): DynamicToolCallParams {
    return {
        threadId,
        turnId,
        callId: `call-${threadId}`,
        namespace: null,
        tool: 'opl_runtime_read',
        arguments: {detail: 'fast'},
    };
}

function successfulResponse(text: string): DynamicToolCallResponse {
    return {
        success: true,
        contentItems: [{type: 'inputText', text}],
    };
}

describe('CodexAppServerClient shared dynamic tool routing', () => {
    it('keeps earlier thread callbacks when a later client shares the MessageConnection', async () => {
        const fixture = createSharedConnectionFixture();
        const firstHandler = vi.fn(async () => successfulResponse('first'));
        const first = new CodexAppServerClient(fixture.connection, firstHandler);
        first.bindDynamicToolHandler('thread-first');
        const firstUpdates = vi.fn();
        first.onServerNotification('thread-first', firstUpdates);

        const secondHandler = vi.fn(async () => successfulResponse('second'));
        const second = new CodexAppServerClient(fixture.connection, secondHandler);
        second.bindDynamicToolHandler('thread-second');
        const secondUpdates = vi.fn();
        second.onServerNotification('thread-second', secondUpdates);

        expect(fixture.requestRegistrationCount(DYNAMIC_TOOL_METHOD)).toBe(1);
        await expect(fixture.sendRequest(DYNAMIC_TOOL_METHOD, dynamicToolParams('thread-first')))
            .resolves.toEqual(successfulResponse('first'));
        await expect(fixture.sendRequest(DYNAMIC_TOOL_METHOD, dynamicToolParams('thread-second')))
            .resolves.toEqual(successfulResponse('second'));

        fixture.sendNotification({
            method: 'thread/name/updated',
            params: {threadId: 'thread-first', threadName: 'First'},
        });
        expect(firstUpdates).toHaveBeenCalledOnce();
        expect(secondUpdates).not.toHaveBeenCalled();
        expect(firstHandler).toHaveBeenCalledOnce();
        expect(secondHandler).toHaveBeenCalledOnce();
    });

    it('fails closed for unknown and ambiguous thread owners', async () => {
        const fixture = createSharedConnectionFixture();
        const firstHandler = vi.fn(async () => successfulResponse('first'));
        const secondHandler = vi.fn(async () => successfulResponse('second'));
        const first = new CodexAppServerClient(fixture.connection, firstHandler);
        const second = new CodexAppServerClient(fixture.connection, secondHandler);

        await expect(fixture.sendRequest<DynamicToolCallResponse>(DYNAMIC_TOOL_METHOD, dynamicToolParams('unknown')))
            .resolves.toMatchObject({success: false});

        first.bindDynamicToolHandler('duplicate');
        second.bindDynamicToolHandler('duplicate');
        const firstUpdates = vi.fn();
        const secondUpdates = vi.fn();
        first.onServerNotification('duplicate', firstUpdates);
        second.onServerNotification('duplicate', secondUpdates);
        await expect(fixture.sendRequest<DynamicToolCallResponse>(DYNAMIC_TOOL_METHOD, dynamicToolParams('duplicate')))
            .resolves.toMatchObject({success: false});
        fixture.sendNotification({
            method: 'thread/name/updated',
            params: {threadId: 'duplicate', threadName: 'Ambiguous'},
        });
        expect(firstHandler).not.toHaveBeenCalled();
        expect(secondHandler).not.toHaveBeenCalled();
        expect(firstUpdates).not.toHaveBeenCalled();
        expect(secondUpdates).not.toHaveBeenCalled();

        second.clearThreadHandlers('duplicate');
        await expect(fixture.sendRequest(DYNAMIC_TOOL_METHOD, dynamicToolParams('duplicate')))
            .resolves.toEqual(successfulResponse('first'));
        fixture.sendNotification({
            method: 'thread/name/updated',
            params: {threadId: 'duplicate', threadName: 'First'},
        });
        expect(firstUpdates).toHaveBeenCalledOnce();
    });

    it('rejects stale turns and unregisters a server-closed session deterministically', async () => {
        const fixture = createSharedConnectionFixture();
        const handler = vi.fn(async () => successfulResponse('ready'));
        const client = new CodexAppServerClient(fixture.connection, handler);
        client.bindDynamicToolHandler('thread-stale');
        client.markTurnStale('thread-stale', 'turn-stale');

        await expect(fixture.sendRequest<DynamicToolCallResponse>(
            DYNAMIC_TOOL_METHOD,
            dynamicToolParams('thread-stale', 'turn-stale'),
        )).resolves.toMatchObject({success: false});
        expect(handler).not.toHaveBeenCalled();

        client.bindDynamicToolHandler('thread-closed');
        fixture.sendNotification({method: 'thread/closed', params: {threadId: 'thread-closed'}});
        await expect(fixture.sendRequest<DynamicToolCallResponse>(
            DYNAMIC_TOOL_METHOD,
            dynamicToolParams('thread-closed'),
        )).resolves.toMatchObject({success: false});
        expect(handler).not.toHaveBeenCalled();
    });

    it('removes all owned thread routes on client disposal', async () => {
        const fixture = createSharedConnectionFixture();
        const handler = vi.fn(async () => successfulResponse('ready'));
        const client = new CodexAppServerClient(fixture.connection, handler);
        client.bindDynamicToolHandler('thread-disposed');
        client.dispose();

        await expect(fixture.sendRequest<DynamicToolCallResponse>(
            DYNAMIC_TOOL_METHOD,
            dynamicToolParams('thread-disposed'),
        )).resolves.toMatchObject({success: false});
        expect(handler).not.toHaveBeenCalled();
    });

    it('converts dispatcher failures into a typed unavailable response', async () => {
        const fixture = createSharedConnectionFixture();
        const handler = vi.fn(async (): Promise<DynamicToolCallResponse> => {
            throw new Error('ACP dispatcher disconnected');
        });
        const client = new CodexAppServerClient(fixture.connection, handler);
        client.bindDynamicToolHandler('thread-failed');

        await expect(fixture.sendRequest<DynamicToolCallResponse>(
            DYNAMIC_TOOL_METHOD,
            dynamicToolParams('thread-failed'),
        )).resolves.toMatchObject({success: false});
        expect(handler).toHaveBeenCalledOnce();
    });
});

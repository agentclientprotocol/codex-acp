import { vi, expect } from 'vitest';
import type { CodexACPAgent } from '../../CodexACPAgent';

export interface MockConnections {
    mockAcpConnection: any;
    mockCodexConnection: any;
    notificationHandlers: Map<string, Function>;
    getUnhandledNotificationHandler: () => Function | null;
}

export function createMockConnections(): MockConnections {
    const notificationHandlers = new Map<string, Function>();
    let unhandledNotificationHandler: Function | null = null;

    const mockAcpConnection = {
        sessionUpdate: vi.fn().mockResolvedValue(undefined),
        readTextFile: vi.fn().mockResolvedValue({ content: 'file content' }),
    };

    const mockCodexConnection = {
        sendRequest: vi.fn(),
        onUnhandledNotification: vi.fn((handler: Function) => {
            unhandledNotificationHandler = handler;
        }),
        onNotification: vi.fn((method: string, handler: Function) => {
            notificationHandlers.set(method, handler);
        }),
        end: vi.fn(),
    };

    return {
        mockAcpConnection,
        mockCodexConnection,
        notificationHandlers,
        getUnhandledNotificationHandler: () => unhandledNotificationHandler,
    };
}

export async function startPromptForEventHandlers(
    agent: CodexACPAgent,
    sessionId: string,
    mocks: MockConnections
): Promise<() => Promise<void>> {
    mocks.mockCodexConnection.sendRequest.mockResolvedValue(undefined);

    const promptPromise = agent.prompt({
        sessionId,
        prompt: [{ type: 'text', text: 'test' }],
    });

    // wait for handlers to be registered
    await vi.waitFor(() => {
        expect(mocks.getUnhandledNotificationHandler()).not.toBeNull();
    }, { timeout: 1000 });

    return async () => {
        const taskCompleteHandler = mocks.notificationHandlers.get('codex/event/task_complete');
        if (taskCompleteHandler) {
            taskCompleteHandler({ type: 'task_complete' });
        }
        await promptPromise;
    };
}

export async function triggerEvent(mocks: MockConnections, event: any): Promise<void> {
    const handler = mocks.getUnhandledNotificationHandler();
    if (!handler) {
        throw new Error('No unhandled notification handler registered. Did you call startPromptForEventHandlers?');
    }
    await handler({ params: { msg: event } });
}

export async function testEventHandling(
    agent: CodexACPAgent,
    sessionId: string,
    mocks: MockConnections,
    events: any | any[]
): Promise<void> {
    const completePrompt = await startPromptForEventHandlers(agent, sessionId, mocks);

    const eventArray = Array.isArray(events) ? events : [events];
    for (const event of eventArray) {
        await triggerEvent(mocks, event);
    }

    await completePrompt();
}

import { vi } from 'vitest';

export interface MockConnections {
    mockAcpConnection: any;
    mockCodexConnection: any;
    notificationHandlers: Map<string, Function>;
    unhandledNotificationHandler: Function | null;
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
        unhandledNotificationHandler,
    };
}

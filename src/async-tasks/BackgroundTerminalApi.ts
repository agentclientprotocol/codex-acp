/** The fields used from an API that stable `generate-ts` output omits. */
export type ThreadBackgroundTerminal = {
    itemId: string;
    processId: string;
    command: string;
};

export type ThreadBackgroundTerminalsListParams = {
    threadId: string;
    cursor?: string | null;
    limit?: number | null;
};

export type ThreadBackgroundTerminalsListResponse = {
    data: ThreadBackgroundTerminal[];
    nextCursor: string | null;
};

export type ThreadBackgroundTerminalsTerminateParams = {
    threadId: string;
    processId: string;
};

export type ThreadBackgroundTerminalsTerminateResponse = {
    terminated: boolean;
};

export type ThreadBackgroundTerminalsRequest =
    | { method: "thread/backgroundTerminals/list"; params: ThreadBackgroundTerminalsListParams }
    | { method: "thread/backgroundTerminals/terminate"; params: ThreadBackgroundTerminalsTerminateParams };

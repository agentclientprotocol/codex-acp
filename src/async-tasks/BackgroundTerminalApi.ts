/** Experimental app-server API types that `generate-ts` does not export yet. */
export type ThreadBackgroundTerminal = {
    itemId: string;
    processId: string;
    command: string;
    cwd: string;
    osPid: number | null;
    cpuPercent: number | null;
    rssKb: number | null;
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

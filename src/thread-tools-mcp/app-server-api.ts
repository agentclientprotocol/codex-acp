import type {CodexAppServerClient} from "../CodexAppServerClient";
import type {
    Thread,
    ThreadForkResponse,
    ThreadItem,
    ThreadItemEntry,
    ThreadItemsListParams,
    ThreadItemsListResponse,
    ThreadResumeResponse,
    ThreadTurnsListParams,
    ThreadTurnsListResponse,
    Turn,
} from "../app-server/v2";

export type PaginatedThread = Thread & {
    historyMode?: "legacy" | "paginated";
    projectId?: string | null;
};

export type PaginatedThreadResumeResponse = ThreadResumeResponse & {
    runtimeWorkspaceRoots?: string[];
    activePermissionProfile?: {id: string} | null;
};

export type PaginatedTurn = Turn;
export type PaginatedThreadItem = ThreadItem;
export type {ThreadItemEntry};

type Page<T> = {
    data: T[];
    nextCursor: string | null;
    backwardsCursor: string | null;
};

export async function listThreadTurns(
    client: CodexAppServerClient,
    params: ThreadTurnsListParams,
): Promise<ThreadTurnsListResponse> {
    return await client.connection.sendRequest("thread/turns/list", params);
}

export async function listThreadTurnsWithFallback(
    client: CodexAppServerClient,
    params: Parameters<typeof listThreadTurns>[1],
): Promise<Page<PaginatedTurn>> {
    try {
        return await listThreadTurns(client, params);
    } catch (error) {
        if (!isHistoryPaginationUnsupported(error)) throw error;
        const turns = (await client.threadRead({threadId: params.threadId, includeTurns: true})).thread.turns as PaginatedTurn[];
        const end = params.cursor === undefined || params.cursor === null
            ? turns.length
            : turns.findIndex(turn => turn.id === params.cursor);
        if (end < 0) throw new Error(`Unknown cursor: ${params.cursor}`);
        const limit = params.limit ?? turns.length;
        const data = turns.slice(0, end).reverse().slice(0, limit);
        return {
            data,
            nextCursor: end > data.length ? data.at(-1)?.id ?? null : null,
            backwardsCursor: null,
        };
    }
}

export async function forkThreadWithoutHistory(
    client: CodexAppServerClient,
    params: {
        threadId: string;
        lastTurnId?: string;
        beforeTurnId?: string;
        ephemeral: boolean;
        excludeTurns: boolean;
        config: Record<string, unknown>;
    },
): Promise<ThreadForkResponse> {
    try {
        return await client.connection.sendRequest("thread/fork", params);
    } catch (error) {
        if (!params.excludeTurns || !isHistoryPaginationUnsupported(error)) throw error;
        return await client.connection.sendRequest("thread/fork", {...params, excludeTurns: false});
    }
}

export async function listThreadItems(
    client: CodexAppServerClient,
    params: ThreadItemsListParams,
): Promise<ThreadItemsListResponse> {
    return await client.connection.sendRequest("thread/items/list", params);
}

export async function resumeThreadWithoutHistory(
    client: CodexAppServerClient,
    params: {
        threadId: string;
        config?: Record<string, unknown>;
        excludeTurns: boolean;
    },
): Promise<PaginatedThreadResumeResponse> {
    try {
        return await client.connection.sendRequest("thread/resume", params);
    } catch (error) {
        if (!params.excludeTurns || !isHistoryPaginationUnsupported(error)) throw error;
        return await client.connection.sendRequest("thread/resume", {...params, excludeTurns: false});
    }
}

export async function startThread(
    client: CodexAppServerClient,
    params: Record<string, unknown>,
): Promise<{thread: PaginatedThread}> {
    try {
        return await client.connection.sendRequest("thread/start", params);
    } catch (error) {
        if (params["historyMode"] === undefined || !isHistoryPaginationUnsupported(error)) throw error;
        const legacyParams = {...params};
        delete legacyParams["historyMode"];
        return await client.connection.sendRequest("thread/start", legacyParams);
    }
}

export async function startToolTurn(
    client: CodexAppServerClient,
    params: {
        threadId: string;
        input: [];
        toolOutput: {
            name: string;
            namespace: string;
            output: string;
        };
        model: string | null;
        sandboxPolicy: unknown;
    },
): Promise<void> {
    await client.connection.sendRequest("turn/start", params);
}

function isHistoryPaginationUnsupported(error: unknown): boolean {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code === -32601) return true;
    if (code !== -32600 && code !== -32602) return false;
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
    const fields = ["historymode", "history mode", "excludeturns", "exclude turns", "thread/turns/list", "thread/items/list"];
    return fields.some(field => message.includes(field))
        || (message.includes("paginated") && ["unknown variant", "unsupported variant", "invalid enum"].some(value => message.includes(value)));
}

import {type MessageConnection, RequestType} from "vscode-jsonrpc/node";
import {AppServerConnectionLostError, ConnectionLoss} from "./app-server-recovery/ConnectionLoss";
import {McpOauthCompletions} from "./mcp/McpOauthCompletions";
import {McpStartupTracker} from "./mcp/McpStartupTracker";
import type {
    ClientRequest,
    InitializeParams,
    InitializeResponse,
    ServerNotification
} from "./app-server";
import type {
    CancelLoginAccountParams,
    CancelLoginAccountResponse,
    ConfigReadParams,
    ConfigReadResponse,
    ConfigBatchWriteParams,
    ConfigWriteResponse,
    GetAccountParams,
    GetAccountRateLimitsResponse,
    GetAccountResponse,
    HooksListParams,
    HooksListResponse,
    ListMcpServerStatusParams,
    ListMcpServerStatusResponse,
    LoginAccountParams,
    LoginAccountResponse,
    LogoutAccountResponse,
    McpServerElicitationRequestParams,
    McpServerElicitationRequestResponse,
    McpServerOauthLoginParams,
    McpServerOauthLoginResponse,
    McpServerRefreshResponse,
    McpServerStatusUpdatedNotification,
    ModelListParams,
    ModelListResponse,
    ReviewStartParams,
    ReviewStartResponse,
    SkillsExtraRootsSetParams,
    SkillsListParams,
    SkillsListResponse,
    ThreadGoal,
    ThreadGoalUpdatedNotification,
    ThreadStatus,
    ThreadStatusChangedNotification,
    ThreadArchiveParams,
    ThreadArchiveResponse,
    ThreadDeleteParams,
    ThreadDeleteResponse,
    ThreadUnarchiveParams,
    ThreadUnarchiveResponse,
    ThreadCompactStartParams,
    ThreadCompactStartResponse,
    ThreadGoalClearedNotification,
    ThreadGoalClearParams,
    ThreadGoalClearResponse,
    ThreadGoalGetParams,
    ThreadGoalGetResponse,
    ThreadGoalSetParams,
    ThreadGoalSetResponse,
    ThreadForkParams,
    ThreadForkResponse,
    ThreadLoadedListParams,
    ThreadLoadedListResponse,
    ThreadListParams,
    ThreadListResponse,
    ThreadReadParams,
    ThreadReadResponse,
    ThreadTurnsListParams,
    ThreadTurnsListResponse,
    ThreadItem,
    ThreadItemsListParams,
    ThreadItemsListResponse,
    Turn,
    ThreadResumeParams,
    ThreadResumeResponse,
    ThreadSettings,
    ThreadStartParams,
    ThreadStartResponse,
    ThreadSetNameParams,
    ThreadSetNameResponse,
    ThreadUnsubscribeParams,
    ThreadUnsubscribeResponse,
    ToolRequestUserInputParams,
    ToolRequestUserInputResponse,
    TurnCompletedNotification,
    TurnInterruptParams,
    TurnInterruptResponse,
    TurnStartParams,
    TurnStartResponse,
    TurnSteerParams,
    TurnSteerResponse,
    CommandExecutionRequestApprovalParams,
    CommandExecutionRequestApprovalResponse,
    FileChangeRequestApprovalParams,
    FileChangeRequestApprovalResponse,
    PermissionsRequestApprovalParams,
    PermissionsRequestApprovalResponse,
    ItemCompletedNotification,
} from "./app-server/v2";
import type {
    ThreadBackgroundTerminalsRequest,
    ThreadBackgroundTerminalsTerminateParams,
    ThreadBackgroundTerminalsTerminateResponse,
    ThreadBackgroundTerminalsListParams,
    ThreadBackgroundTerminalsListResponse,
} from "./async-tasks/BackgroundTerminalApi";

export interface ApprovalHandler {
    handleCommandExecution(params: CommandExecutionRequestApprovalParams): Promise<CommandExecutionRequestApprovalResponse>;
    handleFileChange(params: FileChangeRequestApprovalParams): Promise<FileChangeRequestApprovalResponse>;
    handlePermissionsRequest(params: PermissionsRequestApprovalParams): Promise<PermissionsRequestApprovalResponse>;
}

export interface ElicitationHandler {
    handleElicitation(params: McpServerElicitationRequestParams): Promise<McpServerElicitationRequestResponse>;
    handleUserInput(params: ToolRequestUserInputParams): Promise<ToolRequestUserInputResponse>;
}

const CommandExecutionApprovalRequest = new RequestType<
    CommandExecutionRequestApprovalParams,
    CommandExecutionRequestApprovalResponse,
    void
>('item/commandExecution/requestApproval');

const FileChangeApprovalRequest = new RequestType<
    FileChangeRequestApprovalParams,
    FileChangeRequestApprovalResponse,
    void
>('item/fileChange/requestApproval');

const PermissionsApprovalRequest = new RequestType<
    PermissionsRequestApprovalParams,
    PermissionsRequestApprovalResponse,
    void
>('item/permissions/requestApproval');

const McpServerElicitationRequest = new RequestType<
    McpServerElicitationRequestParams,
    McpServerElicitationRequestResponse,
    void
>('mcpServer/elicitation/request');

const ToolRequestUserInputRequest = new RequestType<
    ToolRequestUserInputParams,
    ToolRequestUserInputResponse,
    void
>('item/tool/requestUserInput');

const GOAL_RUNTIME_EFFECTS_GRACE_MS = 1_000;

/** The number of turns in one page of a full history read. */
const HISTORY_PAGE_TURNS = 5;

/** The number of items in one page of a history replay. */
const HISTORY_PAGE_ITEMS = 100;

/**
 * The longest wait for one page of history. A page takes milliseconds, so a page that takes this long is lost:
 * the load fails and the session closes instead of waiting forever.
 */
const HISTORY_PAGE_TIMEOUT_MS = 60_000;

/**
 * A type-safe client over the Codex App Server's JSON-RPC API.
 * Maps each request to its expected response and exposes clear, typed methods for supported JSON-RPC operations.
 */
export class CodexAppServerClient {
    readonly connection: MessageConnection;
    private approvalHandlers = new Map<string, ApprovalHandler>();
    private elicitationHandlers = new Map<string, ElicitationHandler>();
    readonly mcpStartup = new McpStartupTracker();
    readonly mcpOauthCompletions = new McpOauthCompletions();
    private readonly pendingTurnCompletionResolvers = new Map<string, Map<string, (event: TurnCompletedNotification) => void>>();
    private readonly pendingCompactionCompletionResolvers = new Map<string, Set<(event: CompactionCompletedNotification) => void>>();
    private readonly turnCompletionCaptures = new Map<string, Set<(event: TurnCompletedNotification) => void>>();
    private readonly turnRoutingCaptures = new Map<string, Set<(turnId: string, notification: ServerNotification) => void>>();
    private readonly threadStatusCaptures = new Map<string, Set<(status: ThreadStatus) => void>>();
    private readonly threadGoalUpdateCaptures = new Map<string, Set<(event: ThreadGoalUpdatedNotification) => void>>();
    private readonly threadGoalClearedCaptures = new Map<string, Set<() => void>>();
    private readonly threadSettings = new Map<string, ThreadSettings>();
    private readonly staleTurnIds = new Map<string, Set<string>>();
    /** Ends the notification waits below when the connection is gone, see {@link waitWhileConnected}. */
    readonly connectionLoss: ConnectionLoss;

    constructor(connection: MessageConnection) {
        this.connection = connection;
        this.connectionLoss = new ConnectionLoss(connection);
        // The process exit disposes the connection and does not close it, so both events end the MCP waits.
        this.connection.onClose?.(() => this.disposeMcpWaits());
        this.connection.onDispose?.(() => this.disposeMcpWaits());
        this.connection.onUnhandledNotification((data) => {
            const serverNotification = data as ServerNotification;
            if (isMcpServerStatusUpdatedNotification(serverNotification)) {
                this.mcpStartup.record(serverNotification.params);
            }
            if (serverNotification.method === "mcpServer/oauthLogin/completed") {
                this.mcpOauthCompletions.complete(serverNotification.params);
            }
            if (isTurnCompletedNotification(serverNotification)) {
                this.recordTurnCompleted(serverNotification.params);
            }
            if (isCompactionCompletedNotification(serverNotification)) {
                this.recordCompactionCompleted(serverNotification);
            }
            if (isThreadStatusChangedNotification(serverNotification)) {
                this.recordThreadStatusChanged(serverNotification.params);
            }
            if (isThreadGoalUpdatedNotification(serverNotification)) {
                this.recordThreadGoalUpdated(serverNotification.params);
            }
            if (isThreadGoalClearedNotification(serverNotification)) {
                this.recordThreadGoalCleared(serverNotification.params);
            }
            if (serverNotification.method === "thread/settings/updated") {
                this.threadSettings.set(serverNotification.params.threadId, serverNotification.params.threadSettings);
            }
            const routing = extractTurnRouting(serverNotification);
            if (this.handleStaleTurnNotification(serverNotification, routing)) {
                return;
            }
            this.recordTurnRouting(routing, serverNotification);
            if (this.handleStaleTurnNotification(serverNotification, routing)) {
                return;
            }
            this.notify(serverNotification);
            for (const callback of this.codexEventHandlers) {
                callback({ eventType: "notification", ...serverNotification });
            }
        });

        this.connection.onRequest(CommandExecutionApprovalRequest, async (params) => {
            if (this.isStaleTurn(params.threadId, params.turnId)) {
                return { decision: "cancel" };
            }
            const handler = this.approvalHandlers.get(params.threadId);
            if (!handler) {
                return { decision: "cancel" };
            }
            return await handler.handleCommandExecution(params);
        });

        this.connection.onRequest(FileChangeApprovalRequest, async (params) => {
            if (this.isStaleTurn(params.threadId, params.turnId)) {
                return { decision: "cancel" };
            }
            const handler = this.approvalHandlers.get(params.threadId);
            if (!handler) {
                return { decision: "cancel" };
            }
            return await handler.handleFileChange(params);
        });

        this.connection.onRequest(PermissionsApprovalRequest, async (params) => {
            if (this.isStaleTurn(params.threadId, params.turnId)) {
                return { permissions: {}, scope: "turn", strictAutoReview: false };
            }
            const handler = this.approvalHandlers.get(params.threadId);
            if (!handler) {
                return { permissions: {}, scope: "turn", strictAutoReview: false };
            }
            return await handler.handlePermissionsRequest(params);
        });

        this.connection.onRequest(McpServerElicitationRequest, async (params) => {
            if (this.isStaleTurn(params.threadId, params.turnId)) {
                return { action: "cancel", content: null, _meta: null };
            }
            const handler = this.elicitationHandlers.get(params.threadId);
            if (!handler) {
                return { action: "cancel", content: null, _meta: null };
            }
            return await handler.handleElicitation(params);
        });

        this.connection.onRequest(ToolRequestUserInputRequest, async (params) => {
            if (this.isStaleTurn(params.threadId, params.turnId)) {
                return { answers: {} };
            }
            const handler = this.elicitationHandlers.get(params.threadId);
            if (!handler) {
                return { answers: {} };
            }
            return await handler.handleUserInput(params);
        });
    }

    onApprovalRequest(threadId: string, handler: ApprovalHandler): void {
        this.approvalHandlers.set(threadId, handler);
    }

    onElicitationRequest(threadId: string, handler: ElicitationHandler): void {
        this.elicitationHandlers.set(threadId, handler);
    }

    clearThreadHandlers(threadId: string): void {
        this.notificationHandlers.delete(threadId);
        this.approvalHandlers.delete(threadId);
        this.elicitationHandlers.delete(threadId);
        this.threadSettings.delete(threadId);
    }

    async initialize(params: InitializeParams): Promise<InitializeResponse> {
        return await this.sendRequest({ method: "initialize", params: params });
    }

    async turnStart(params: TurnStartParams): Promise<TurnStartResponse> {
        return await this.sendRequest({ method: "turn/start", params: params });
    }

    async runTurn(params: TurnStartParams, onTurnStarted?: (turnId: string) => void): Promise<TurnCompletedNotification> {
        const capturedCompletions: Array<TurnCompletedNotification> = [];
        const releaseCapture = this.captureTurnCompletions(params.threadId, (event) => {
            capturedCompletions.push(event);
        });

        try {
            const turnStarted = await this.turnStart(params);
            onTurnStarted?.(turnStarted.turn.id);
            const earlyCompletion = capturedCompletions.find(event => event.turn.id === turnStarted.turn.id);
            releaseCapture();
            if (earlyCompletion) {
                return earlyCompletion;
            }
            // Wait for turn completion
            // If turnInterrupt() was called, Codex will send turn/completed event with status "interrupted"
            return await this.awaitTurnCompleted(params.threadId, turnStarted.turn.id);
        } finally {
            releaseCapture();
        }
    }

    async runReview(
        params: ReviewStartParams,
        onTurnStarted?: (turnId: string, threadId: string) => void,
    ): Promise<TurnCompletedNotification> {
        const capturedCompletions: Array<TurnCompletedNotification> = [];
        const releaseCapture = this.captureTurnCompletions(params.threadId, (event) => {
            capturedCompletions.push(event);
        });

        try {
            const reviewStarted = await this.reviewStart(params);
            onTurnStarted?.(reviewStarted.turn.id, reviewStarted.reviewThreadId);
            const earlyCompletion = capturedCompletions.find(event => event.turn.id === reviewStarted.turn.id);
            releaseCapture();
            if (earlyCompletion) {
                return earlyCompletion;
            }
            return await this.awaitTurnCompleted(reviewStarted.reviewThreadId, reviewStarted.turn.id);
        } finally {
            releaseCapture();
        }
    }

    async runGoalSet(
        params: ThreadGoalSetParams,
        onTurnStarted?: (turnId: string) => void,
        runtimeEffectsGraceMs = GOAL_RUNTIME_EFFECTS_GRACE_MS,
        onGoalSet?: (goal: ThreadGoal) => void,
    ): Promise<TurnCompletedNotification | null> {
        let goalTurnId: string | null = null;
        const capturedCompletions: Array<TurnCompletedNotification> = [];
        let resolveGoalTurnCompleted: (event: TurnCompletedNotification) => void = () => {};
        const goalTurnCompleted = new Promise<TurnCompletedNotification>((resolve) => {
            resolveGoalTurnCompleted = resolve;
        });
        const releaseCompletionCapture = this.captureTurnCompletions(params.threadId, (event) => {
            capturedCompletions.push(event);
            if (goalTurnId === event.turn.id) {
                resolveGoalTurnCompleted(event);
            }
        });
        let resolveGoalTurnStarted: (turnId: string) => void = () => {};
        const goalTurnStarted = new Promise<string>((resolve) => {
            resolveGoalTurnStarted = resolve;
        });
        let resolveGoalUpdateHandled: () => void = () => {};
        const matchingGoalUpdateHandled = new Promise<null>((resolve) => {
            resolveGoalUpdateHandled = () => resolve(null);
        });
        let goalUpdateHandled = false;
        let expectedGoal: ThreadGoal | null = null;
        const noGoalTurnStarted = this.createNoGoalTurnStartedPromise(runtimeEffectsGraceMs);
        const capturedGoalUpdates: Array<ThreadGoalUpdatedNotification> = [];
        const releaseRoutingCapture = this.captureTurnRoutings(params.threadId, (turnId) => {
            if (!goalUpdateHandled || goalTurnId !== null) {
                return;
            }
            goalTurnId = turnId;
            onTurnStarted?.(turnId);
            resolveGoalTurnStarted(turnId);
        });
        const releaseGoalUpdateCapture = this.captureThreadGoalUpdates(params.threadId, (event) => {
            capturedGoalUpdates.push(event);
            if (expectedGoal !== null && goalsMatch(event.goal, expectedGoal)) {
                goalUpdateHandled = true;
                resolveGoalUpdateHandled();
                noGoalTurnStarted.goalUpdated();
            }
        });
        const releaseStatusCapture = this.captureThreadStatuses(params.threadId, (status) => {
            if (!goalUpdateHandled || goalTurnId !== null) {
                return;
            }
            noGoalTurnStarted.threadStatusChanged(status);
        });

        const whileConnected = <T>(wait: Promise<T>) => this.waitWhileConnected("the goal update", wait);
        try {
            const goalSetResponse = await this.threadGoalSet(params);
            expectedGoal = goalSetResponse.goal;
            onGoalSet?.(expectedGoal);
            if (capturedGoalUpdates.some(event => goalsMatch(event.goal, expectedGoal!))) {
                goalUpdateHandled = true;
                resolveGoalUpdateHandled();
                noGoalTurnStarted.goalUpdated();
            }
            if (expectedGoal.status !== "active") {
                await whileConnected(matchingGoalUpdateHandled);
                return null;
            }
            const turnId = goalTurnId ?? await whileConnected(Promise.race([goalTurnStarted, noGoalTurnStarted.promise]));
            noGoalTurnStarted.release();
            releaseRoutingCapture();
            releaseStatusCapture();
            releaseGoalUpdateCapture();
            if (turnId === null) {
                return null;
            }
            const earlyCompletion = capturedCompletions.find(event => event.turn.id === turnId);
            if (earlyCompletion) {
                return earlyCompletion;
            }
            return await whileConnected(goalTurnCompleted);
        } finally {
            noGoalTurnStarted.release();
            releaseCompletionCapture();
            releaseRoutingCapture();
            releaseStatusCapture();
            releaseGoalUpdateCapture();
        }
    }

    async runGoalClear(params: ThreadGoalClearParams): Promise<void> {
        let goalClearedHandled = false;
        let resolveGoalClearedHandled: () => void = () => {};
        const matchingGoalClearedHandled = new Promise<void>((resolve) => {
            resolveGoalClearedHandled = () => resolve();
        });
        const releaseGoalClearedCapture = this.captureThreadGoalClears(params.threadId, () => {
            goalClearedHandled = true;
            resolveGoalClearedHandled();
        });

        try {
            const response = await this.threadGoalClear(params);
            if (!response.cleared || goalClearedHandled) {
                return;
            }
            await this.waitWhileConnected("the goal clear", matchingGoalClearedHandled);
        } finally {
            releaseGoalClearedCapture();
        }
    }

    private createNoGoalTurnStartedPromise(
        runtimeEffectsGraceMs: number,
    ): {
        promise: Promise<null>,
        release: () => void,
        goalUpdated: () => void,
        threadStatusChanged: (status: ThreadStatus) => void,
    } {
        let released = false;
        let resolved = false;
        let goalUpdated = false;
        let activeAfterGoalUpdate = false;
        let timeout: ReturnType<typeof setTimeout> | null = null;
        let resolveNoGoalTurnStarted: () => void = () => {};
        const clearTimer = () => {
            if (timeout !== null) {
                clearTimeout(timeout);
                timeout = null;
            }
        };
        const resolveNoTurn = () => {
            if (released || resolved) {
                return;
            }
            resolved = true;
            clearTimer();
            resolveNoGoalTurnStarted();
        };
        const scheduleNoTurnTimer = () => {
            if (released || resolved || !goalUpdated || activeAfterGoalUpdate || timeout !== null) {
                return;
            }
            timeout = setTimeout(resolveNoTurn, runtimeEffectsGraceMs);
        };
        const release = () => {
            if (released) {
                return;
            }
            released = true;
            clearTimer();
        };
        const promise = new Promise<null>((resolve) => {
            resolveNoGoalTurnStarted = () => {
                resolve(null);
            };
        });
        const handleGoalUpdated = () => {
            goalUpdated = true;
            scheduleNoTurnTimer();
        };
        const handleThreadStatusChanged = (status: ThreadStatus) => {
            if (!goalUpdated || released || resolved) {
                return;
            }
            if (status.type === "active") {
                activeAfterGoalUpdate = true;
                clearTimer();
                return;
            }
            if (activeAfterGoalUpdate) {
                resolveNoTurn();
            }
        };
        return {
            promise,
            release,
            goalUpdated: handleGoalUpdated,
            threadStatusChanged: handleThreadStatusChanged,
        };
    }

    async runCompact(
        params: ThreadCompactStartParams,
        onTurnStarted?: (turnId: string) => void,
    ): Promise<CompactionCompletedNotification | Extract<ServerNotification, {method: "turn/completed"}>> {
        type Result = CompactionCompletedNotification | Extract<ServerNotification, {method: "turn/completed"}>;
        let compactTurnId: string | null = null;
        let resolveCompleted: (event: Result) => void = () => {};
        let rejectCompleted: (error: Error) => void = () => {};
        const completed = new Promise<Result>((resolve, reject) => {
            resolveCompleted = resolve;
            rejectCompleted = reject;
        });
        // The request acknowledgement can still be pending when the connection closes.
        void completed.catch(() => {});
        // The process exit disposes the connection and does not close it, so both events end the wait.
        const rejectClosed = () => rejectCompleted(new Error("Codex connection closed during compaction."));
        const closed = this.connection.onClose?.(rejectClosed);
        const disposed = this.connection.onDispose?.(rejectClosed);
        const completeCompaction = (event: CompactionCompletedNotification) => {
            if (compactTurnId !== null && event.params.turnId !== compactTurnId) return;
            resolveCompleted(event);
        };
        const releaseCompactionCapture = this.captureCompactionCompletions(params.threadId, completeCompaction);
        const releaseTurnCapture = this.captureTurnCompletions(params.threadId, (event) => {
            if (compactTurnId === null || event.turn.id !== compactTurnId) return;
            if (event.turn.status !== "inProgress") {
                resolveCompleted({method: "turn/completed", params: event});
            }
        });
        const releaseRoutingCapture = this.captureTurnRoutings(params.threadId, (turnId, notification) => {
            if (compactTurnId !== null) return;
            if (notification.method !== "turn/started"
                && !(notification.method === "item/started" && notification.params.item.type === "contextCompaction")) return;
            compactTurnId = turnId;
            onTurnStarted?.(turnId);
        });
        try {
            await this.threadCompactStart(params);
            return await completed;
        } finally {
            releaseTurnCapture();
            releaseRoutingCapture();
            releaseCompactionCapture();
            closed?.dispose();
            disposed?.dispose();
        }
    }

    async turnInterrupt(params: TurnInterruptParams): Promise<TurnInterruptResponse> {
        return await this.sendRequest({ method: "turn/interrupt", params: params });
    }

    async turnSteer(params: TurnSteerParams): Promise<TurnSteerResponse> {
        return await this.sendRequest({ method: "turn/steer", params: params });
    }

    async reviewStart(params: ReviewStartParams): Promise<ReviewStartResponse> {
        return await this.sendRequest({ method: "review/start", params: params });
    }

    markTurnStale(threadId: string, turnId: string): void {
        const threadStaleTurns = this.staleTurnIds.get(threadId) ?? new Set<string>();
        threadStaleTurns.add(turnId);
        this.staleTurnIds.set(threadId, threadStaleTurns);
    }

    async threadStart(params: ThreadStartParams): Promise<ThreadStartResponse> {
        return await this.sendRequest({ method: "thread/start", params: params });
    }

    async threadSetName(params: ThreadSetNameParams): Promise<ThreadSetNameResponse> {
        return await this.sendRequest({ method: "thread/name/set", params });
    }

    async threadResume(params: ThreadResumeParams): Promise<ThreadResumeResponse> {
        return await this.sendRequest({ method: "thread/resume", params: params });
    }

    async threadFork(params: ThreadForkParams): Promise<ThreadForkResponse> {
        return await this.sendRequest({ method: "thread/fork", params: params });
    }

    getThreadSettings(threadId: string): ThreadSettings | undefined {
        return this.threadSettings.get(threadId);
    }

    async threadSettingsUpdate(params: ExperimentalThreadSettingsUpdateParams): Promise<void> {
        await this.connection.sendRequest("thread/settings/update", params);
    }

    async threadList(params: ThreadListParams): Promise<ThreadListResponse> {
        return await this.sendRequest({ method: "thread/list", params: params });
    }

    async threadLoadedList(params: ThreadLoadedListParams): Promise<ThreadLoadedListResponse> {
        return await this.sendRequest({ method: "thread/loaded/list", params: params });
    }

    async threadRead(params: ThreadReadParams): Promise<ThreadReadResponse> {
        return await this.sendRequest({ method: "thread/read", params: params });
    }

    async threadTurnsList(params: ThreadTurnsListParams): Promise<ThreadTurnsListResponse> {
        return await this.sendRequest({method: "thread/turns/list", params});
    }

    async threadItemsList(params: ThreadItemsListParams): Promise<ThreadItemsListResponse> {
        return await this.sendRequest({method: "thread/items/list", params});
    }

    /** The turns of a thread in pages, from the first page. See {@link historyPages}. */
    threadTurnPages({threadId, ...params}: Omit<ThreadTurnsListParams, "cursor">): AsyncGenerator<Turn[]> {
        return historyPages(threadId, "thread/turns/list", cursor => this.threadTurnsList({threadId, cursor, ...params}));
    }

    /**
     * The items of a thread, or of one turn, oldest first, in pages.
     *
     * A caller can send each page and drop it, so the history is never in
     * memory at once, even for a turn with thousands of items. The pages end
     * at the item of `lastItemCursor`, an `itemsBackwardsCursor` of
     * thread/resume. Without it, they end at the newest item when the read
     * starts, so an item that arrives during the read is not in the pages.
     */
    async *threadItemPages(
        threadId: string,
        options: {lastItemCursor?: string | null; turnId?: string} = {},
    ): AsyncGenerator<ThreadItem[]> {
        const turnId = options.turnId ?? null;
        const last = await withHistoryTimeout(this.threadItemsList({
            threadId,
            turnId,
            cursor: options.lastItemCursor ?? null,
            limit: 1,
            sortDirection: "desc",
        }), "thread/items/list", threadId);
        const lastItemId = last.data[0]?.item.id;
        if (lastItemId === undefined) return;
        const pages = historyPages(threadId, "thread/items/list", cursor => this.threadItemsList({
            threadId,
            turnId,
            cursor,
            limit: HISTORY_PAGE_ITEMS,
            sortDirection: "asc",
        }), page => page.some(entry => entry.item.id === lastItemId));
        for await (const page of pages) {
            const items = page.map(entry => entry.item);
            const lastIndex = items.findIndex(item => item.id === lastItemId);
            if (lastIndex >= 0) {
                yield items.slice(0, lastIndex + 1);
                return;
            }
            yield items;
        }
    }

    async threadReadWithHistory(threadId: string): Promise<ThreadReadResponse> {
        const response = await this.threadRead({threadId});
        // Legacy stores reconstruct the rollout on each read; paging would repeat
        // that work. Full-history reads are only deprecated for paginated threads.
        if (response.thread.historyMode === "legacy") {
            return await this.threadRead({threadId, includeTurns: true});
        }
        const turns: Turn[] = [];
        for await (const page of this.threadHistoryPages(threadId)) {
            turns.push(...page);
        }
        return {...response, thread: {...response.thread, turns}};
    }

    /**
     * The turns of a thread, oldest first, in pages of full turns. The pages
     * end at the newest turn when the read starts, so a turn that arrives
     * during the read is not in the pages.
     */
    private async *threadHistoryPages(threadId: string): AsyncGenerator<Turn[]> {
        const last = await withHistoryTimeout(this.threadTurnsList({
            threadId,
            cursor: null,
            limit: 1,
            sortDirection: "desc",
            itemsView: "notLoaded",
        }), "thread/turns/list", threadId);
        const lastTurnId = last.data[0]?.id;
        if (lastTurnId === undefined) return;
        const pages = this.threadTurnPages({threadId, limit: HISTORY_PAGE_TURNS, sortDirection: "asc", itemsView: "full"});
        for await (const page of pages) {
            const lastIndex = page.findIndex(turn => turn.id === lastTurnId);
            if (lastIndex >= 0) {
                yield page.slice(0, lastIndex + 1);
                return;
            }
            yield page;
        }
    }

    async threadArchive(params: ThreadArchiveParams): Promise<ThreadArchiveResponse> {
        return await this.sendRequest({ method: "thread/archive", params: params });
    }

    async threadUnarchive(params: ThreadUnarchiveParams): Promise<ThreadUnarchiveResponse> {
        return await this.sendRequest({ method: "thread/unarchive", params: params });
    }

    async threadDelete(params: ThreadDeleteParams): Promise<ThreadDeleteResponse> {
        return await this.sendRequest({ method: "thread/delete", params: params });
    }

    async threadUnsubscribe(params: ThreadUnsubscribeParams): Promise<ThreadUnsubscribeResponse> {
        return await this.sendRequest({ method: "thread/unsubscribe", params: params });
    }

    async threadCompactStart(params: ThreadCompactStartParams): Promise<ThreadCompactStartResponse> {
        return await this.sendRequest({ method: "thread/compact/start", params: params });
    }

    async threadBackgroundTerminalsList(params: ThreadBackgroundTerminalsListParams): Promise<ThreadBackgroundTerminalsListResponse> {
        return await this.sendRequest({method: "thread/backgroundTerminals/list", params});
    }

    async threadBackgroundTerminalsTerminate(params: ThreadBackgroundTerminalsTerminateParams): Promise<ThreadBackgroundTerminalsTerminateResponse> {
        return await this.sendRequest({method: "thread/backgroundTerminals/terminate", params});
    }

    async threadGoalSet(params: ThreadGoalSetParams): Promise<ThreadGoalSetResponse> {
        return await this.sendRequest({ method: "thread/goal/set", params: params });
    }

    async threadGoalGet(params: ThreadGoalGetParams): Promise<ThreadGoalGetResponse> {
        return await this.sendRequest({ method: "thread/goal/get", params: params });
    }

    async threadGoalClear(params: ThreadGoalClearParams): Promise<ThreadGoalClearResponse> {
        return await this.sendRequest({ method: "thread/goal/clear", params: params });
    }

    async listMcpServerStatus(params: ListMcpServerStatusParams): Promise<ListMcpServerStatusResponse> {
        return await this.sendRequest({ method: "mcpServerStatus/list", params });
    }

    async mcpServerReload(): Promise<McpServerRefreshResponse> {
        return await this.sendRequest({ method: "config/mcpServer/reload", params: undefined });
    }

    async mcpServerOauthLogin(params: McpServerOauthLoginParams): Promise<McpServerOauthLoginResponse> {
        return await this.sendRequest({ method: "mcpServer/oauth/login", params });
    }

    async accountLogin(params: LoginAccountParams): Promise<LoginAccountResponse> {
        return await this.sendRequest({ method: "account/login/start", params: params });
    }

    async accountLoginCancel(params: CancelLoginAccountParams): Promise<CancelLoginAccountResponse> {
        return await this.sendRequest({ method: "account/login/cancel", params: params });
    }

    async accountLogout(): Promise<LogoutAccountResponse> {
        return await this.sendRequest({ method: "account/logout", params: undefined });
    }

    async configRead(params: ConfigReadParams): Promise<ConfigReadResponse> {
        return await this.sendRequest({ method: "config/read", params: params });
    }

    async hooksList(params: HooksListParams): Promise<HooksListResponse> {
        return await this.sendRequest({method: "hooks/list", params});
    }

    async configBatchWrite(params: ConfigBatchWriteParams): Promise<ConfigWriteResponse> {
        return await this.sendRequest({method: "config/batchWrite", params});
    }
    async accountRead(params: GetAccountParams): Promise<GetAccountResponse> {
        return await this.sendRequest({ method: "account/read", params: params });
    }

    async accountRateLimitsRead(): Promise<GetAccountRateLimitsResponse> {
        return await this.sendRequest({ method: "account/rateLimits/read", params: undefined });
    }

    //TODO create type-safe helper
    async awaitTurnCompleted(threadId: string, turnId: string): Promise<TurnCompletedNotification> {
        let resolver: ((event: TurnCompletedNotification) => void) | undefined;
        const completed = new Promise<TurnCompletedNotification>((resolve) => {
            resolver = resolve;
            const threadResolvers = this.getOrCreatePendingTurnCompletionResolvers(threadId);
            threadResolvers.set(turnId, resolve);
        });
        return await this.waitWhileConnected("the end of the turn", completed, () => {
            const threadResolvers = this.pendingTurnCompletionResolvers.get(threadId);
            if (!threadResolvers || threadResolvers.get(turnId) !== resolver) return;
            threadResolvers.delete(turnId);
            if (threadResolvers.size === 0) {
                this.pendingTurnCompletionResolvers.delete(threadId);
            }
        });
    }

    async awaitCompactionCompleted(threadId: string): Promise<CompactionCompletedNotification> {
        let releaseCapture: () => void = () => {};
        const completed = new Promise<CompactionCompletedNotification>((resolve) => {
            releaseCapture = this.captureCompactionCompletions(threadId, (event) => {
                releaseCapture();
                resolve(event);
            });
        });
        return await this.waitWhileConnected("the end of the compaction", completed, () => releaseCapture());
    }

    /**
     * Waits for `wait`, or rejects with {@link AppServerConnectionLostError} when the connection is lost first.
     * A JSON-RPC response wait needs no such guard: vscode-jsonrpc rejects it on dispose. A notification wait does.
     * `release` removes the registration behind `wait`; it runs once the wait ends either way.
     */
    waitWhileConnected<T>(what: string, wait: Promise<T>, release: () => void = () => {}): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            let ended = false;
            const end = () => {
                if (ended) return false;
                ended = true;
                removeListener();
                release();
                return true;
            };
            let removeListener: () => void = () => {};
            removeListener = this.connectionLoss.onLost(() => {
                if (end()) reject(new AppServerConnectionLostError(what));
            });
            wait.then(
                value => { if (end()) resolve(value); },
                error => { if (end()) reject(error); },
            );
        });
    }

    resolveTurnInterrupted(threadId: string, turnId: string): void {
        this.recordTurnCompleted({
            threadId,
            turn: {
                id: turnId,
                items: [],
                itemsView: "notLoaded",
                status: "interrupted",
                error: null,
                startedAt: null,
                completedAt: null,
                durationMs: null,
            },
        });
    }

    async listModels(params: ModelListParams): Promise<ModelListResponse> {
        return await this.sendRequest({ method: "model/list", params });
    }

    async skillsExtraRootsSet(params: SkillsExtraRootsSetParams): Promise<void> {
        return await this.sendRequest({ method: "skills/extraRoots/set", params });
    }

    async listSkills(params: SkillsListParams): Promise<SkillsListResponse> {
        return await this.sendRequest({ method: "skills/list", params });
    }

    /**
     * Registers a notification handler for a specific session.
     * Replaces any existing handler for the same session, preventing handler accumulation.
     */
    onServerNotification(sessionId: string, callback: (event: ServerNotification) => void) {
        this.notificationHandlers.set(sessionId, callback);
    }

    private codexEventHandlers: Array<(event: CodexConnectionEvent) => void> = [];
    onClientTransportEvent(callback: (event: CodexConnectionEvent) => void){
        this.codexEventHandlers.push(callback);
    }

    private notificationHandlers = new Map<string, (event: ServerNotification) => void>();
    private notify(notification: ServerNotification) {
        const threadId = extractThreadId(notification);
        if (threadId !== null) {
            const handler = this.notificationHandlers.get(threadId);
            if (handler) {
                handler(notification);
            }
            return;
        }
        for (const notificationHandler of this.notificationHandlers.values()) {
            notificationHandler(notification);
        }
    }

    private recordTurnCompleted(event: TurnCompletedNotification): void {
        const threadResolvers = this.pendingTurnCompletionResolvers.get(event.threadId);
        const resolve = threadResolvers?.get(event.turn.id);
        if (resolve) {
            threadResolvers!.delete(event.turn.id);
            if (threadResolvers!.size === 0) {
                this.pendingTurnCompletionResolvers.delete(event.threadId);
            }
            resolve(event);
            return;
        }

        const captures = this.turnCompletionCaptures.get(event.threadId);
        if (!captures) {
            return;
        }
        for (const capture of captures) {
            capture(event);
        }
    }

    private recordCompactionCompleted(event: CompactionCompletedNotification): void {
        const threadId = extractThreadId(event);
        if (threadId === null) {
            return;
        }
        const resolvers = this.pendingCompactionCompletionResolvers.get(threadId);
        if (!resolvers) {
            return;
        }
        for (const resolve of resolvers) {
            resolve(event);
        }
    }

    private captureCompactionCompletions(
        threadId: string,
        capture: (event: CompactionCompletedNotification) => void,
    ): () => void {
        const captures = this.pendingCompactionCompletionResolvers.get(threadId) ?? new Set();
        captures.add(capture);
        this.pendingCompactionCompletionResolvers.set(threadId, captures);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            captures.delete(capture);
            if (captures.size === 0) {
                this.pendingCompactionCompletionResolvers.delete(threadId);
            }
        };
    }

    private recordThreadStatusChanged(event: ThreadStatusChangedNotification): void {
        const captures = this.threadStatusCaptures.get(event.threadId);
        if (!captures) {
            return;
        }
        for (const capture of captures) {
            capture(event.status);
        }
    }

    private recordThreadGoalUpdated(event: ThreadGoalUpdatedNotification): void {
        const captures = this.threadGoalUpdateCaptures.get(event.threadId);
        if (!captures) {
            return;
        }
        for (const capture of captures) {
            capture(event);
        }
    }

    private recordThreadGoalCleared(event: ThreadGoalClearedNotification): void {
        const captures = this.threadGoalClearedCaptures.get(event.threadId);
        if (!captures) {
            return;
        }
        for (const capture of captures) {
            capture();
        }
    }

    private recordTurnRouting(
        routing: { threadId: string | null, turnId: string | null },
        notification: ServerNotification,
    ): void {
        if (routing.threadId === null || routing.turnId === null) {
            return;
        }
        const captures = this.turnRoutingCaptures.get(routing.threadId);
        if (!captures) {
            return;
        }
        for (const capture of captures) {
            capture(routing.turnId, notification);
        }
    }

    private handleStaleTurnNotification(
        notification: ServerNotification,
        routing: { threadId: string | null, turnId: string | null },
    ): boolean {
        if (!this.isStaleTurn(routing.threadId, routing.turnId)) {
            return false;
        }
        if (isTurnCompletedNotification(notification) && routing.threadId !== null && routing.turnId !== null) {
            this.clearStaleTurn(routing.threadId, routing.turnId);
        }
        for (const callback of this.codexEventHandlers) {
            callback({ eventType: "notification", ...notification });
        }
        return true;
    }

    private isStaleTurn(threadId: string | null, turnId: string | null): boolean {
        if (threadId === null || turnId === null) {
            return false;
        }
        return this.staleTurnIds.get(threadId)?.has(turnId) ?? false;
    }

    private clearStaleTurn(threadId: string, turnId: string): void {
        const threadStaleTurns = this.staleTurnIds.get(threadId);
        if (!threadStaleTurns) {
            return;
        }
        threadStaleTurns.delete(turnId);
        if (threadStaleTurns.size === 0) {
            this.staleTurnIds.delete(threadId);
        }
    }

    private getOrCreatePendingTurnCompletionResolvers(threadId: string): Map<string, (event: TurnCompletedNotification) => void> {
        const existing = this.pendingTurnCompletionResolvers.get(threadId);
        if (existing) {
            return existing;
        }
        const created = new Map<string, (event: TurnCompletedNotification) => void>();
        this.pendingTurnCompletionResolvers.set(threadId, created);
        return created;
    }

    private captureTurnCompletions(threadId: string, capture: (event: TurnCompletedNotification) => void): () => void {
        const captures = this.turnCompletionCaptures.get(threadId) ?? new Set<(event: TurnCompletedNotification) => void>();
        captures.add(capture);
        this.turnCompletionCaptures.set(threadId, captures);
        let released = false;
        return () => {
            if (released) {
                return;
            }
            released = true;
            captures.delete(capture);
            if (captures.size === 0) {
                this.turnCompletionCaptures.delete(threadId);
            }
        };
    }

    private captureTurnRoutings(threadId: string, capture: (turnId: string, notification: ServerNotification) => void): () => void {
        const captures = this.turnRoutingCaptures.get(threadId) ?? new Set<(turnId: string, notification: ServerNotification) => void>();
        captures.add(capture);
        this.turnRoutingCaptures.set(threadId, captures);
        let released = false;
        return () => {
            if (released) {
                return;
            }
            released = true;
            captures.delete(capture);
            if (captures.size === 0) {
                this.turnRoutingCaptures.delete(threadId);
            }
        };
    }

    private captureThreadStatuses(threadId: string, capture: (status: ThreadStatus) => void): () => void {
        const captures = this.threadStatusCaptures.get(threadId) ?? new Set<(status: ThreadStatus) => void>();
        captures.add(capture);
        this.threadStatusCaptures.set(threadId, captures);
        let released = false;
        return () => {
            if (released) {
                return;
            }
            released = true;
            captures.delete(capture);
            if (captures.size === 0) {
                this.threadStatusCaptures.delete(threadId);
            }
        };
    }

    private captureThreadGoalUpdates(threadId: string, capture: (event: ThreadGoalUpdatedNotification) => void): () => void {
        const captures = this.threadGoalUpdateCaptures.get(threadId) ?? new Set<(event: ThreadGoalUpdatedNotification) => void>();
        captures.add(capture);
        this.threadGoalUpdateCaptures.set(threadId, captures);
        let released = false;
        return () => {
            if (released) {
                return;
            }
            released = true;
            captures.delete(capture);
            if (captures.size === 0) {
                this.threadGoalUpdateCaptures.delete(threadId);
            }
        };
    }

    private captureThreadGoalClears(threadId: string, capture: () => void): () => void {
        const captures = this.threadGoalClearedCaptures.get(threadId) ?? new Set<() => void>();
        captures.add(capture);
        this.threadGoalClearedCaptures.set(threadId, captures);
        let released = false;
        return () => {
            if (released) {
                return;
            }
            released = true;
            captures.delete(capture);
            if (captures.size === 0) {
                this.threadGoalClearedCaptures.delete(threadId);
            }
        };
    }

    private disposeMcpWaits(): void {
        this.mcpStartup.dispose();
        this.mcpOauthCompletions.dispose();
    }

    /**
     * The thread ids of the requests in flight that read a whole rollout into the app-server, with their count.
     * When the app-server dies, these tell which thread it was opening, see `AppServerRecovery`.
     */
    private readonly threadLoads = new Map<string, number>();

    /**
     * Runs each request that reads a whole rollout, see `AppServerRecovery.loadThread`: it can refuse a thread that
     * crashed the app-server too often, or run such requests one at a time. By default it runs the request at once.
     */
    threadLoadGate: <T>(threadId: string, request: () => Promise<T>) => Promise<T> = (_threadId, request) => request();

    threadLoadsInFlight(): string[] {
        return [...this.threadLoads.keys()];
    }

    private async sendRequest<R>(request: CodexRequest): Promise<R> {
        for (const callback of this.codexEventHandlers) {
            callback({ eventType: "request", ...request});
        }
        const loadedThreadId = threadLoadOf(request);
        let result: any;
        if (loadedThreadId === null) {
            if (request.params) {
                result = await this.connection.sendRequest<R>(request.method, request.params)
            }
            else {
                result = await this.connection.sendRequest<R>(request.method);
            }
        } else {
            result = await this.threadLoadGate(loadedThreadId, () => this.sendThreadLoad<R>(loadedThreadId, request));
        }
        for (const callback of this.codexEventHandlers) {
            callback({ eventType: "response", ...result});
        }
        return result;
    }

    private async sendThreadLoad<R>(threadId: string, request: CodexRequest): Promise<R> {
        this.threadLoads.set(threadId, (this.threadLoads.get(threadId) ?? 0) + 1);
        try {
            return await this.connection.sendRequest<R>(request.method, (request as {params?: unknown}).params);
        } finally {
            const count = (this.threadLoads.get(threadId) ?? 1) - 1;
            if (count > 0) this.threadLoads.set(threadId, count);
            else this.threadLoads.delete(threadId);
        }
    }
}

/** The thread whose rollout `request` reads: a resume, a fork (of the source thread) or a history read. */
function threadLoadOf(request: CodexRequest): string | null {
    const params = (request as {params?: unknown}).params as {threadId?: unknown, includeTurns?: unknown} | undefined;
    if (typeof params?.threadId !== "string") return null;
    switch (request.method) {
        case "thread/resume":
        case "thread/fork":
        case "thread/turns/list":
        case "thread/items/list":
            return params.threadId;
        case "thread/read":
            return params.includeTurns === true ? params.threadId : null;
        default:
            return null;
    }
}

export type CodexConnectionEvent =
    | ({ eventType: "request" } & CodexRequest)
    | ({ eventType: "response" } & unknown)
    | ({ eventType: "notification" } & ServerNotification);

export type CompactionCompletedNotification =
    | { method: "thread/compacted", params: Extract<ServerNotification, { method: "thread/compacted" }>["params"] }
    | { method: "item/completed", params: ItemCompletedNotification & { item: Extract<ItemCompletedNotification["item"], { type: "contextCompaction" }> } };

type CodexRequest = DistributiveOmit<ClientRequest, "id"> | ThreadBackgroundTerminalsRequest

type DistributiveOmit<T, K extends keyof any> = T extends any
    ? Omit<T, K>
    : never;

export interface ExperimentalThreadSettingsUpdateParams {
    threadId: string;
    collaborationMode: {
        mode: "default" | "plan";
        settings: {
            model: string;
            reasoning_effort: string | null;
            developer_instructions: string | null;
        };
    };
}

function isMcpServerStatusUpdatedNotification(notification: ServerNotification): notification is {
    method: "mcpServer/startupStatus/updated";
    params: McpServerStatusUpdatedNotification;
} {
    return notification.method === "mcpServer/startupStatus/updated";
}

function isTurnCompletedNotification(notification: ServerNotification): notification is {
    method: "turn/completed";
    params: TurnCompletedNotification;
} {
    return notification.method === "turn/completed";
}

function isThreadStatusChangedNotification(notification: ServerNotification): notification is {
    method: "thread/status/changed";
    params: ThreadStatusChangedNotification;
} {
    return notification.method === "thread/status/changed";
}

function isThreadGoalUpdatedNotification(notification: ServerNotification): notification is {
    method: "thread/goal/updated";
    params: ThreadGoalUpdatedNotification;
} {
    return notification.method === "thread/goal/updated";
}

function isThreadGoalClearedNotification(notification: ServerNotification): notification is {
    method: "thread/goal/cleared";
    params: ThreadGoalClearedNotification;
} {
    return notification.method === "thread/goal/cleared";
}

function isCompactionCompletedNotification(notification: ServerNotification): notification is CompactionCompletedNotification {
    if (notification.method === "thread/compacted") {
        return true;
    }
    return notification.method === "item/completed" && notification.params.item.type === "contextCompaction";
}

function goalsMatch(left: ThreadGoal, right: ThreadGoal): boolean {
    return left.threadId === right.threadId
        && left.objective === right.objective
        && left.status === right.status
        && left.tokenBudget === right.tokenBudget
        && left.updatedAt === right.updatedAt;
}

function extractThreadId(notification: ServerNotification): string | null {
    const params = notification.params as { threadId?: unknown } | undefined;
    if (params && typeof params.threadId === "string") {
        return params.threadId;
    }
    return null;
}

function extractTurnRouting(notification: ServerNotification): { threadId: string | null, turnId: string | null } {
    const params = notification.params as {
        threadId?: unknown,
        turnId?: unknown,
        turn?: { id?: unknown },
    } | undefined;
    const threadId = extractThreadId(notification);
    if (params && typeof params.turnId === "string") {
        return {threadId, turnId: params.turnId};
    }
    if (params && typeof params.turn?.id === "string") {
        return {threadId, turnId: params.turn.id};
    }
    return {threadId, turnId: null};
}

/**
 * The pages of a history list, from the first page. A page request fails when Codex does not answer
 * within {@link HISTORY_PAGE_TIMEOUT_MS}. The read fails when Codex returns a cursor a second time.
 *
 * With `endsHistory`, the next page is requested while the caller uses a page, so at most two pages are in memory.
 * No page is requested after the page that `endsHistory` accepts. Without it, a page is requested when the caller asks.
 */
async function* historyPages<T>(
    threadId: string,
    method: string,
    requestPage: (cursor: string | null) => Promise<{data: T[]; nextCursor: string | null}>,
    endsHistory?: (page: T[]) => boolean,
): AsyncGenerator<T[]> {
    type Page = {data: T[]; nextCursor: string | null};
    const request = (cursor: string | null): Promise<Page> => {
        const page = withHistoryTimeout(requestPage(cursor), method, threadId);
        // A caller that stops early never reads the next page. Its failure is not an unhandled rejection.
        page.catch(() => {});
        return page;
    };
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    let next: Promise<Page> | null = null;
    do {
        const page: Page = await (next ?? request(cursor));
        next = null;
        cursor = page.nextCursor;
        const repeated = cursor !== null && seenCursors.has(cursor);
        if (cursor !== null && !repeated) {
            seenCursors.add(cursor);
            if (endsHistory && !endsHistory(page.data)) next = request(cursor);
        }
        yield page.data;
        if (repeated) {
            throw new Error("Codex returned a repeated thread history cursor");
        }
    } while (cursor !== null);
}

/** The page, or an error when Codex does not answer within {@link HISTORY_PAGE_TIMEOUT_MS}. */
async function withHistoryTimeout<T>(page: Promise<T>, method: string, threadId: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(
            `Codex did not answer ${method} for thread ${threadId} within ${HISTORY_PAGE_TIMEOUT_MS / 1000} s`,
        )), HISTORY_PAGE_TIMEOUT_MS);
    });
    try {
        return await Promise.race([page, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

import {type MessageConnection, RequestType} from "vscode-jsonrpc/node";
import type {
    ClientRequest,
    InitializeParams,
    InitializeResponse,
    ServerNotification
} from "./app-server";
import type {
    ConfigReadParams,
    ConfigReadResponse,
    GetAccountParams,
    GetAccountResponse,
    ListMcpServerStatusParams,
    ListMcpServerStatusResponse,
    LoginAccountParams,
    LoginAccountResponse,
    LogoutAccountResponse,
    McpServerElicitationRequestParams,
    McpServerElicitationRequestResponse,
    McpServerStartupState,
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
    ThreadCompactStartParams,
    ThreadCompactStartResponse,
    ThreadGoalClearedNotification,
    ThreadGoalClearParams,
    ThreadGoalClearResponse,
    ThreadGoalGetParams,
    ThreadGoalGetResponse,
    ThreadGoalSetParams,
    ThreadGoalSetResponse,
    ThreadLoadedListParams,
    ThreadLoadedListResponse,
    ThreadListParams,
    ThreadListResponse,
    ThreadReadParams,
    ThreadReadResponse,
    ThreadResumeParams,
    ThreadResumeResponse,
    ThreadSettings,
    ThreadStartParams,
    ThreadStartResponse,
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

export interface ApprovalHandler {
    handleCommandExecution(params: CommandExecutionRequestApprovalParams): Promise<CommandExecutionRequestApprovalResponse>;
    handleFileChange(params: FileChangeRequestApprovalParams): Promise<FileChangeRequestApprovalResponse>;
    handlePermissionsRequest(params: PermissionsRequestApprovalParams): Promise<PermissionsRequestApprovalResponse>;
}

export interface ElicitationHandler {
    handleElicitation(params: McpServerElicitationRequestParams): Promise<McpServerElicitationRequestResponse>;
    handleUserInput(params: ToolRequestUserInputParams): Promise<ToolRequestUserInputResponse>;
}

export type McpStartupFailure = {
    server: string;
    error: string;
};

export type McpStartupResult = {
    ready: Array<string>;
    failed: Array<McpStartupFailure>;
    cancelled: Array<string>;
};

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

/**
 * A type-safe client over the Codex App Server's JSON-RPC API.
 * Maps each request to its expected response and exposes clear, typed methods for supported JSON-RPC operations.
 */
export class CodexAppServerClient {
    readonly connection: MessageConnection;
    private approvalHandlers = new Map<string, ApprovalHandler>();
    private elicitationHandlers = new Map<string, ElicitationHandler>();
    private mcpServerStartupVersion = 0;
    private readonly mcpServerStartupStates = new Map<string, McpServerStartupSnapshot>();
    private readonly mcpServerStartupResolvers: Array<McpServerStartupResolver> = [];
    private readonly pendingTurnCompletionResolvers = new Map<string, Map<string, (event: TurnCompletedNotification) => void>>();
    private readonly pendingCompactionCompletionResolvers = new Map<string, Set<(event: CompactionCompletedNotification) => void>>();
    private readonly turnCompletionCaptures = new Map<string, Set<(event: TurnCompletedNotification) => void>>();
    private readonly turnRoutingCaptures = new Map<string, Set<(turnId: string) => void>>();
    private readonly threadStatusCaptures = new Map<string, Set<(status: ThreadStatus) => void>>();
    private readonly threadGoalUpdateCaptures = new Map<string, Set<(event: ThreadGoalUpdatedNotification) => void>>();
    private readonly threadGoalClearedCaptures = new Map<string, Set<() => void>>();
    private readonly threadSettings = new Map<string, ThreadSettings>();
    private readonly staleTurnIds = new Map<string, Set<string>>();

    constructor(connection: MessageConnection) {
        this.connection = connection;
        this.connection.onUnhandledNotification((data) => {
            const serverNotification = data as ServerNotification;
            if (isMcpServerStatusUpdatedNotification(serverNotification)) {
                this.mcpServerStartupVersion += 1;
                this.mcpServerStartupStates.set(serverNotification.params.name, {
                    status: serverNotification.params.status,
                    error: serverNotification.params.error,
                    version: this.mcpServerStartupVersion,
                });
                this.resolveMcpServerStartupResolvers();
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
            this.recordTurnRouting(routing);
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
                return { permissions: {}, scope: "turn", strictAutoReview: true };
            }
            const handler = this.approvalHandlers.get(params.threadId);
            if (!handler) {
                return { permissions: {}, scope: "turn", strictAutoReview: true };
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
                await matchingGoalUpdateHandled;
                return null;
            }
            const turnId = goalTurnId ?? await Promise.race([goalTurnStarted, noGoalTurnStarted.promise]);
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
            return await goalTurnCompleted;
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
            await matchingGoalClearedHandled;
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

    async runCompact(params: ThreadCompactStartParams): Promise<CompactionCompletedNotification> {
        const compactionCompleted = this.awaitCompactionCompleted(params.threadId);
        await this.threadCompactStart(params);
        return await compactionCompleted;
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

    async threadResume(params: ThreadResumeParams): Promise<ThreadResumeResponse> {
        return await this.sendRequest({ method: "thread/resume", params: params });
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

    async threadArchive(params: ThreadArchiveParams): Promise<ThreadArchiveResponse> {
        return await this.sendRequest({ method: "thread/archive", params: params });
    }

    async threadUnsubscribe(params: ThreadUnsubscribeParams): Promise<ThreadUnsubscribeResponse> {
        return await this.sendRequest({ method: "thread/unsubscribe", params: params });
    }

    async threadCompactStart(params: ThreadCompactStartParams): Promise<ThreadCompactStartResponse> {
        return await this.sendRequest({ method: "thread/compact/start", params: params });
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

    async accountLogin(params: LoginAccountParams): Promise<LoginAccountResponse> {
        return await this.sendRequest({ method: "account/login/start", params: params });
    }

    async accountLogout(): Promise<LogoutAccountResponse> {
        return await this.sendRequest({ method: "account/logout", params: undefined });
    }

    async configRead(params: ConfigReadParams): Promise<ConfigReadResponse> {
        return await this.sendRequest({ method: "config/read", params: params });
    }

    getMcpServerStartupVersion(): number {
        return this.mcpServerStartupVersion;
    }

    async awaitMcpServerStartup(serverNames: Array<string>, afterVersion: number): Promise<McpStartupResult> {
        const uniqueServerNames = Array.from(new Set(serverNames.map(serverName => serverName.trim()).filter(serverName => serverName.length > 0)));
        if (uniqueServerNames.length === 0) {
            return { ready: [], failed: [], cancelled: [] };
        }

        const result = this.tryBuildMcpStartupResult(uniqueServerNames, afterVersion);
        if (result !== null) {
            return result;
        }

        return await new Promise((resolve) => {
            this.mcpServerStartupResolvers.push({
                serverNames: uniqueServerNames,
                afterVersion,
                resolve,
            });
        });
    }

    async accountRead(params: GetAccountParams): Promise<GetAccountResponse> {
        return await this.sendRequest({ method: "account/read", params: params });
    }

    //TODO create type-safe helper
    async awaitTurnCompleted(threadId: string, turnId: string): Promise<TurnCompletedNotification> {
        return await new Promise((resolve) => {
            const threadResolvers = this.getOrCreatePendingTurnCompletionResolvers(threadId);
            threadResolvers.set(turnId, resolve);
        });
    }

    async awaitCompactionCompleted(threadId: string): Promise<CompactionCompletedNotification> {
        return await new Promise((resolve) => {
            const resolvers = this.pendingCompactionCompletionResolvers.get(threadId) ?? new Set();
            resolvers.add(resolve);
            this.pendingCompactionCompletionResolvers.set(threadId, resolvers);
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
        this.pendingCompactionCompletionResolvers.delete(threadId);
        for (const resolve of resolvers) {
            resolve(event);
        }
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

    private recordTurnRouting(routing: { threadId: string | null, turnId: string | null }): void {
        if (routing.threadId === null || routing.turnId === null) {
            return;
        }
        const captures = this.turnRoutingCaptures.get(routing.threadId);
        if (!captures) {
            return;
        }
        for (const capture of captures) {
            capture(routing.turnId);
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

    private captureTurnRoutings(threadId: string, capture: (turnId: string) => void): () => void {
        const captures = this.turnRoutingCaptures.get(threadId) ?? new Set<(turnId: string) => void>();
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

    private resolveMcpServerStartupResolvers(): void {
        const pendingResolvers: Array<McpServerStartupResolver> = [];
        for (const resolver of this.mcpServerStartupResolvers) {
            const result = this.tryBuildMcpStartupResult(resolver.serverNames, resolver.afterVersion);
            if (result !== null) {
                resolver.resolve(result);
            } else {
                pendingResolvers.push(resolver);
            }
        }
        this.mcpServerStartupResolvers.splice(0, this.mcpServerStartupResolvers.length, ...pendingResolvers);
    }

    private tryBuildMcpStartupResult(serverNames: Array<string>, afterVersion: number): McpStartupResult | null {
        const ready: Array<string> = [];
        const failed: Array<McpStartupFailure> = [];
        const cancelled: Array<string> = [];

        for (const serverName of serverNames) {
            const state = this.mcpServerStartupStates.get(serverName);
            if (!state || state.version <= afterVersion) {
                return null;
            }

            switch (state.status) {
                case "starting":
                    return null;
                case "ready":
                    ready.push(serverName);
                    break;
                case "failed":
                    failed.push({
                        server: serverName,
                        error: state.error ?? "unknown MCP startup error",
                    });
                    break;
                case "cancelled":
                    cancelled.push(serverName);
                    break;
            }
        }

        return { ready, failed, cancelled };
    }

    private async sendRequest<R>(request: CodexRequest): Promise<R> {
        for (const callback of this.codexEventHandlers) {
            callback({ eventType: "request", ...request});
        }
        let result: any;
        if (request.params) {
            result = await this.connection.sendRequest<R>(request.method, request.params)
        }
        else {
            result = await this.connection.sendRequest<R>(request.method);
        }
        for (const callback of this.codexEventHandlers) {
            callback({ eventType: "response", ...result});
        }
        return result;
    }
}

export type CodexConnectionEvent =
    | ({ eventType: "request" } & CodexRequest)
    | ({ eventType: "response" } & unknown)
    | ({ eventType: "notification" } & ServerNotification);

export type CompactionCompletedNotification =
    | { method: "thread/compacted", params: Extract<ServerNotification, { method: "thread/compacted" }>["params"] }
    | { method: "item/completed", params: ItemCompletedNotification & { item: Extract<ItemCompletedNotification["item"], { type: "contextCompaction" }> } };

type CodexRequest = DistributiveOmit<ClientRequest, "id">

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

type McpServerStartupSnapshot = {
    status: McpServerStartupState;
    error: string | null;
    version: number;
};

type McpServerStartupResolver = {
    serverNames: Array<string>;
    afterVersion: number;
    resolve: (result: McpStartupResult) => void;
};

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

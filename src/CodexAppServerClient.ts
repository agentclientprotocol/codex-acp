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
    SkillsListParams,
    SkillsListResponse,
    ThreadLoadedListParams,
    ThreadLoadedListResponse,
    ThreadListParams,
    ThreadListResponse,
    ThreadReadParams,
    ThreadReadResponse,
    ThreadResumeParams,
    ThreadResumeResponse,
    ThreadStartParams,
    ThreadStartResponse,
    ThreadUnsubscribeParams,
    ThreadUnsubscribeResponse,
    TurnCompletedNotification,
    TurnInterruptParams,
    TurnInterruptResponse,
    TurnStartParams,
    TurnStartResponse,
    CommandExecutionRequestApprovalParams,
    CommandExecutionRequestApprovalResponse,
    FileChangeRequestApprovalParams,
    FileChangeRequestApprovalResponse,
} from "./app-server/v2";

export interface ApprovalHandler {
    handleCommandExecution(params: CommandExecutionRequestApprovalParams): Promise<CommandExecutionRequestApprovalResponse>;
    handleFileChange(params: FileChangeRequestApprovalParams): Promise<FileChangeRequestApprovalResponse>;
}

export interface ElicitationHandler {
    handleElicitation(params: McpServerElicitationRequestParams): Promise<McpServerElicitationRequestResponse>;
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

const McpServerElicitationRequest = new RequestType<
    McpServerElicitationRequestParams,
    McpServerElicitationRequestResponse,
    void
>('mcpServer/elicitation/request');

const PENDING_TURN_START_FENCE_TIMEOUT_MS = 1000;

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
    private readonly turnCompletionCaptures = new Map<string, Set<(event: TurnCompletedNotification) => void>>();
    private readonly cancelledTurnStartFences = new Map<string, CancelledTurnStartFence[]>();

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
            const fenced = this.handleFencedTurnNotification(serverNotification);
            if (!fenced) {
                this.notify(serverNotification);
            }
            for (const callback of this.codexEventHandlers) {
                callback({ eventType: "notification", ...serverNotification });
            }
        });

        this.connection.onRequest(CommandExecutionApprovalRequest, async (params) => {
            if (this.isFencedTurnRequest(params)) {
                return { decision: "cancel" };
            }
            const handler = this.approvalHandlers.get(params.threadId);
            if (!handler) {
                return { decision: "cancel" };
            }
            return await handler.handleCommandExecution(params);
        });

        this.connection.onRequest(FileChangeApprovalRequest, async (params) => {
            if (this.isFencedTurnRequest(params)) {
                return { decision: "cancel" };
            }
            const handler = this.approvalHandlers.get(params.threadId);
            if (!handler) {
                return { decision: "cancel" };
            }
            return await handler.handleFileChange(params);
        });

        this.connection.onRequest(McpServerElicitationRequest, async (params) => {
            if (this.isFencedTurnRequest(params)) {
                return { action: "cancel", content: null, _meta: null };
            }
            const handler = this.elicitationHandlers.get(params.threadId);
            if (!handler) {
                return { action: "cancel", content: null, _meta: null };
            }
            return await handler.handleElicitation(params);
        });
    }

    onApprovalRequest(threadId: string, handler: ApprovalHandler): void {
        this.approvalHandlers.set(threadId, handler);
    }

    onElicitationRequest(threadId: string, handler: ElicitationHandler): void {
        this.elicitationHandlers.set(threadId, handler);
    }

    async initialize(params: InitializeParams): Promise<InitializeResponse> {
        return await this.sendRequest({ method: "initialize", params: params });
    }

    async turnStart(params: TurnStartParams): Promise<TurnStartResponse> {
        return await this.sendRequest({ method: "turn/start", params: params });
    }

    async runTurn(
        params: TurnStartParams,
        onTurnStarted?: (turnId: string) => void,
        cancellation?: Promise<TurnCompletedNotification>
    ): Promise<TurnCompletedNotification> {
        const capturedCompletions: Array<TurnCompletedNotification> = [];
        const releaseCapture = this.captureTurnCompletions(params.threadId, (event) => {
            capturedCompletions.push(event);
        });

        try {
            const turnStartPromise = this.turnStart(params);
            const turnStartedResult = cancellation
                ? await Promise.race([
                    turnStartPromise.then(response => ({type: "started" as const, response})),
                    cancellation.then(completion => ({type: "cancelled" as const, completion})),
                ])
                : {type: "started" as const, response: await turnStartPromise};
            if (turnStartedResult.type === "cancelled") {
                const fence = this.fenceCancelledTurnStart(params.threadId, onTurnStarted);
                void turnStartPromise.then((response) => {
                    this.identifyCancelledTurnStart(fence, response.turn.id);
                }).catch(() => {
                    this.releaseCancelledTurnStartFence(fence, "rejected");
                });
                return turnStartedResult.completion;
            }

            const turnStarted = turnStartedResult.response;
            const earlyCompletion = capturedCompletions.find(event => event.turn.id === turnStarted.turn.id);
            if (earlyCompletion) {
                onTurnStarted?.(turnStarted.turn.id);
                return earlyCompletion;
            }
            const completionPromise = this.awaitTurnCompleted(params.threadId, turnStarted.turn.id);
            onTurnStarted?.(turnStarted.turn.id);
            releaseCapture();
            // Wait for turn completion
            // If turnInterrupt() was called, Codex will send turn/completed event with status "interrupted"
            if (!cancellation) {
                return await completionPromise;
            }
            const completionResult = await Promise.race([
                completionPromise.then(completion => ({type: "completed" as const, completion})),
                cancellation.then(completion => ({type: "cancelled" as const, completion})),
            ]);
            if (completionResult.type === "cancelled") {
                this.clearPendingTurnCompletion(params.threadId, turnStarted.turn.id);
            }
            return completionResult.completion;
        } finally {
            releaseCapture();
        }
    }

    async turnInterrupt(params: TurnInterruptParams): Promise<TurnInterruptResponse> {
        return await this.sendRequest({ method: "turn/interrupt", params: params });
    }

    pendingTurnStartFence(threadId: string): Promise<void> | null {
        const fences = this.cancelledTurnStartFences.get(threadId) ?? [];
        if (!fences.some(fence => !fence.identified)) {
            return null;
        }
        return this.waitForPendingTurnStartFences(threadId);
    }

    fenceCancelledTurn(threadId: string, turnId: string): void {
        const fences = this.cancelledTurnStartFences.get(threadId) ?? [];
        if (fences.some(fence => fence.turnIds.has(turnId))) {
            return;
        }

        const unidentifiedFence = fences.find(fence => !fence.identified);
        if (unidentifiedFence) {
            this.identifyCancelledTurnStart(unidentifiedFence, turnId, false);
            return;
        }

        const fence = this.fenceCancelledTurnStart(threadId);
        this.identifyCancelledTurnStart(fence, turnId, false);
    }

    private async waitForPendingTurnStartFences(threadId: string): Promise<void> {
        while (true) {
            const fences = this.cancelledTurnStartFences.get(threadId) ?? [];
            const unidentifiedFences = fences.filter(fence => !fence.identified);
            if (unidentifiedFences.length === 0) {
                return;
            }
            const result = await this.waitForFenceIdentification(unidentifiedFences);
            if (result === "timeout") {
                for (const fence of unidentifiedFences) {
                    if (!fence.identified) {
                        this.releaseCancelledTurnStartFence(fence, "timeout");
                    }
                }
            }
        }
    }

    private async waitForFenceIdentification(
        unidentifiedFences: CancelledTurnStartFence[],
    ): Promise<"identified" | "timeout"> {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([
                Promise.all(unidentifiedFences.map(fence => fence.identifiedPromise))
                    .then(() => "identified" as const),
                new Promise<"timeout">((resolve) => {
                    timeout = setTimeout(
                        () => resolve("timeout"),
                        PENDING_TURN_START_FENCE_TIMEOUT_MS,
                    );
                }),
            ]);
        } finally {
            if (timeout) {
                clearTimeout(timeout);
            }
        }
    }

    async threadStart(params: ThreadStartParams): Promise<ThreadStartResponse> {
        return await this.sendRequest({ method: "thread/start", params: params });
    }

    async threadResume(params: ThreadResumeParams): Promise<ThreadResumeResponse> {
        return await this.sendRequest({ method: "thread/resume", params: params });
    }

    async threadUnsubscribe(params: ThreadUnsubscribeParams): Promise<ThreadUnsubscribeResponse> {
        return await this.sendRequest({ method: "thread/unsubscribe", params: params });
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

    resolveTurnInterrupted(threadId: string, turnId: string): void {
        this.recordTurnCompleted({
            threadId,
            turn: {
                id: turnId,
                items: [],
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

    clearSessionHandlers(sessionId: string): void {
        this.notificationHandlers.delete(sessionId);
        this.approvalHandlers.delete(sessionId);
        this.elicitationHandlers.delete(sessionId);
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

    private fenceCancelledTurnStart(
        threadId: string,
        onTurnStarted?: (turnId: string) => void,
    ): CancelledTurnStartFence {
        let resolveIdentified!: () => void;
        const fence: CancelledTurnStartFence = {
            threadId,
            turnIds: new Set(),
            startedCallbacks: new Set(),
            identified: false,
            identifiedPromise: new Promise((resolve) => {
                resolveIdentified = resolve;
            }),
            resolveIdentified,
            onTurnStarted,
            releaseReason: null,
        };
        const fences = this.cancelledTurnStartFences.get(threadId) ?? [];
        fences.push(fence);
        this.cancelledTurnStartFences.set(threadId, fences);
        return fence;
    }

    private identifyCancelledTurnStart(
        fence: CancelledTurnStartFence,
        turnId: string,
        notifyStarted = true,
    ): boolean {
        if (!this.ensureCancelledTurnStartFenceRegistered(fence)) {
            return false;
        }
        fence.turnIds.add(turnId);
        if (notifyStarted && !fence.startedCallbacks.has(turnId)) {
            fence.startedCallbacks.add(turnId);
            fence.onTurnStarted?.(turnId);
        }
        if (!fence.identified) {
            fence.identified = true;
            fence.resolveIdentified();
        }
        return true;
    }

    private handleFencedTurnNotification(notification: ServerNotification): boolean {
        const threadId = extractThreadId(notification);
        const turnId = extractTurnId(notification);
        if (threadId === null || turnId === null) {
            return false;
        }

        const matchingFences = this.matchCancelledTurnFences(threadId, turnId);
        if (matchingFences.length === 0) {
            return false;
        }

        if (isTurnCompletedNotification(notification)) {
            for (const matchingFence of matchingFences) {
                this.releaseCancelledTurnId(matchingFence, turnId);
            }
        }
        return true;
    }

    private isFencedTurnRequest(params: { threadId: string; turnId?: string | null }): boolean {
        if (!params.turnId) {
            return false;
        }
        return this.matchCancelledTurnFences(params.threadId, params.turnId).length > 0;
    }

    private matchCancelledTurnFences(threadId: string, turnId: string): CancelledTurnStartFence[] {
        const fences = this.cancelledTurnStartFences.get(threadId);
        if (!fences || fences.length === 0) {
            return [];
        }

        const matchingFences = fences.filter(fence => fence.turnIds.has(turnId));
        if (matchingFences.length > 0) {
            return matchingFences;
        }

        const unidentifiedFence = fences.find(fence => !fence.identified);
        if (!unidentifiedFence) {
            return [];
        }

        if (!this.identifyCancelledTurnStart(unidentifiedFence, turnId)) {
            return [];
        }
        return [unidentifiedFence];
    }

    private releaseCancelledTurnId(fence: CancelledTurnStartFence, turnId: string): void {
        fence.turnIds.delete(turnId);
        if (fence.turnIds.size === 0 && fence.identified) {
            this.releaseCancelledTurnStartFence(fence, "completed");
        }
    }

    private ensureCancelledTurnStartFenceRegistered(fence: CancelledTurnStartFence): boolean {
        const fences = this.cancelledTurnStartFences.get(fence.threadId) ?? [];
        if (fences.includes(fence)) {
            return true;
        }
        if (fence.releaseReason !== "timeout") {
            return false;
        }
        fences.push(fence);
        this.cancelledTurnStartFences.set(fence.threadId, fences);
        fence.releaseReason = null;
        return true;
    }

    private releaseCancelledTurnStartFence(
        fence: CancelledTurnStartFence,
        reason: CancelledTurnStartFenceReleaseReason,
    ): void {
        fence.releaseReason = reason;
        const fences = this.cancelledTurnStartFences.get(fence.threadId);
        if (!fences) {
            return;
        }
        const remainingFences = fences.filter(candidate => candidate !== fence);
        if (remainingFences.length === 0) {
            this.cancelledTurnStartFences.delete(fence.threadId);
        } else {
            this.cancelledTurnStartFences.set(fence.threadId, remainingFences);
        }
        if (!fence.identified) {
            fence.identified = true;
            fence.resolveIdentified();
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

    private clearPendingTurnCompletion(threadId: string, turnId: string): void {
        const threadResolvers = this.pendingTurnCompletionResolvers.get(threadId);
        if (!threadResolvers) {
            return;
        }
        threadResolvers.delete(turnId);
        if (threadResolvers.size === 0) {
            this.pendingTurnCompletionResolvers.delete(threadId);
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

type CodexRequest = DistributiveOmit<ClientRequest, "id">

type DistributiveOmit<T, K extends keyof any> = T extends any
    ? Omit<T, K>
    : never;

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

type CancelledTurnStartFence = {
    threadId: string;
    turnIds: Set<string>;
    startedCallbacks: Set<string>;
    identified: boolean;
    identifiedPromise: Promise<void>;
    resolveIdentified: () => void;
    onTurnStarted: ((turnId: string) => void) | undefined;
    releaseReason: CancelledTurnStartFenceReleaseReason | null;
};

type CancelledTurnStartFenceReleaseReason = "completed" | "rejected" | "timeout";

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

function extractThreadId(notification: ServerNotification): string | null {
    const params = notification.params as { threadId?: unknown } | undefined;
    if (params && typeof params.threadId === "string") {
        return params.threadId;
    }
    return null;
}

function extractTurnId(notification: ServerNotification): string | null {
    const params = notification.params as { turnId?: unknown; turn?: { id?: unknown } } | undefined;
    if (!params) {
        return null;
    }
    if (typeof params.turnId === "string") {
        return params.turnId;
    }
    if (params.turn && typeof params.turn.id === "string") {
        return params.turn.id;
    }
    return null;
}

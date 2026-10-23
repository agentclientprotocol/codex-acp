import type {ServerNotification} from "../app-server";
import type {StateUpdate} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type {Thread, ThreadItem} from "../app-server/v2";
import {ACPSessionConnection} from "../ACPSessionConnection";
import {AcpV2ForegroundState} from "../AcpV2ForegroundState";
import {CodexPlanStream} from "../CodexPlanStream";
import {CodexSessionToolCalls} from "../CodexSessionToolCalls";
import {CodexItemStreamState} from "../CodexItemStreamState";
import {ClientCapabilities} from "../tool-calls/ClientCapabilities";
import {readableServiceErrorMessage} from "../ServiceErrorMessage";
import {toV2IdleState} from "../AcpV2Prompt";
import {normalizeSessionTitle} from "../SessionTitle";
import {CollabAgentReporter} from "../tool-calls/reporters/CollabAgentReporter";
import {SubagentActivityReporter} from "../tool-calls/reporters/SubagentActivityReporter";
import type {SubagentState} from "./AcpSubagents";
import type {ClosingChildSession} from "./CodexSubagentEventRouter";
import {isRootAgentPath, nameFromAgentPath, normalizeAgentPath} from "./CodexAgentPath";
import {PendingNotificationBuffer} from "./PendingNotificationBuffer";
import {SubagentAssociations, type SubagentAssociation} from "./SubagentAssociations";
import type {SubagentEventRouter} from "./SubagentEventRouter";
import {runSubagentInteraction} from "./SubagentInteraction";
import {logger} from "../Logger";

type Child = SubagentAssociation & {
    path?: string;
    title?: string | null;
    description?: string;
    /** Last turn admitted for presentation; native requests can advance before buffered events. */
    turnId: string | null;
    foregroundTurnId: string | null;
    foreground: AcpV2ForegroundState;
    toolCalls: CodexSessionToolCalls;
    streams: CodexItemStreamState;
    requests: AbortController;
    workRequests: Map<string, {controller: AbortController; count: number}>;
    closedRequestTurns: Set<string>;
    endedTurns: Set<string>;
    live: boolean;
};
type Pending = {
    parentThreadId?: string;
    path?: string;
    description?: string;
    notifications: PendingNotificationBuffer;
};

/** A child is a reusable conversation; work endings never terminate or rename its association. */
export class StandardSubagentEventRouter implements SubagentEventRouter {
    private readonly children = new Map<string, Child>();
    private readonly pending = new Map<string, Pending>();
    private readonly replayQueue: ServerNotification[] = [];
    private readonly deferredLive: PendingNotificationBuffer;
    private readonly legacyActivities = new Set<string>();
    private readonly announced = new Set<string>();
    private readonly replayedItems = new Map<string, Set<string>>();
    private retired = false;
    private snapshotting = false;
    private readonly snapshots = new Map<string, {child: Child; state: StateUpdate}>();
    private interactionObserver?: (event: ServerNotification, sessionId: string) => Promise<void>;

    constructor(
        private readonly rootSessionId: string,
        private readonly session: ACPSessionConnection,
        private readonly associations: SubagentAssociations,
        private readonly onChildWorkEnded: (sessionId: string) => void,
        private readonly capabilities = ClientCapabilities.DEFAULT,
        private deferLive = false,
        private readonly ready: Promise<void> = Promise.resolve(),
        private readonly runningTurnId: (threadId: string) => string | undefined = () => undefined,
    ) {
        this.deferredLive = new PendingNotificationBuffer(rootSessionId);
    }

    /** Admit child events before any renderer, cleanup, or other presentation side effect. */
    async prepareNotification(notification: ServerNotification): Promise<boolean> {
        const threadId = (notification.params as {threadId?: unknown}).threadId;
        if (typeof threadId !== "string" || threadId === this.rootSessionId) return true;
        if (this.retired) return false;
        const params = notification.params as {itemId?: string; item?: {id: string}};
        const itemId = params.itemId ?? params.item?.id;
        if (itemId !== undefined && this.replayedItems.get(threadId)?.has(itemId)) return false;
        if (this.deferLive) {
            this.deferredLive.push(notification);
            return false;
        }
        const child = this.children.get(threadId);
        if (!child) {
            const pending = this.pendingFor(threadId);
            pending.notifications.push(notification);
            if (await this.restoreKnown(threadId)) {
                this.pending.delete(threadId);
                for (const event of pending.notifications.take()) this.replayQueue.push(event);
            }
            return false;
        }
        await this.ensureAnnounced(child);
        return !this.retired;
    }

    async handle(notification: ServerNotification): Promise<boolean> {
        const threadId = (notification.params as {threadId?: unknown}).threadId;
        if (typeof threadId !== "string") return false;
        if (this.retired) {
            return threadId !== this.rootSessionId
                || ((notification.method === "item/started" || notification.method === "item/completed")
                    && (notification.params.item.type === "subAgentActivity"
                        || notification.params.item.type === "collabAgentToolCall"));
        }
        if (notification.method === "item/started" || notification.method === "item/completed") {
            const item = notification.params.item;
            if (item.type === "collabAgentToolCall" && item.tool === "spawnAgent") {
                for (const id of item.receiverThreadIds) {
                    if (!id.trim() || id === item.senderThreadId || id === this.rootSessionId) continue;
                    if (this.children.has(id)) continue;
                    const pending = this.pendingFor(id);
                    // The sender, not whichever stream carried the callback, establishes parentage.
                    pending.parentThreadId = item.senderThreadId;
                    if (item.prompt) pending.description = item.prompt;
                }
                await this.materializePending();
                // A started spawn can have no receiver yet; never leave an orphan legacy tool call.
                return true;
            }
            if (item.type === "subAgentActivity") {
                if (isRootAgentPath(item.agentPath)) return true;
                const child = this.children.get(item.agentThreadId);
                if (child) {
                    await this.ensureAnnounced(child);
                    child.path = normalizeAgentPath(item.agentPath);
                    const title = nameFromAgentPath(item.agentPath, child.title ?? "Agent");
                    if (title !== child.title) {
                        child.title = title;
                        await this.session.update({sessionUpdate: "subagent_update", sessionId: child.sessionId, title}, child.parentSessionId);
                    }
                } else {
                    this.pendingFor(item.agentThreadId).path = normalizeAgentPath(item.agentPath);
                }
                await this.materializePending();
                return true;
            }
        }
        const child = this.children.get(threadId);
        if (!child) return false;
        await this.ensureAnnounced(child);
        if (this.retired) return true;
        await this.interactionObserver?.(notification, child.sessionId);
        child.live = true;
        const progressTurnId = (notification.params as {turnId?: string}).turnId;
        const modelProgress = notification.method === "item/agentMessage/delta"
            || notification.method === "item/plan/delta"
            || notification.method === "item/reasoning/textDelta"
            || notification.method === "item/reasoning/summaryTextDelta";
        if (progressTurnId !== undefined && modelProgress && !child.endedTurns.has(progressTurnId)
            && (child.turnId === null || child.turnId === progressTurnId)) {
            if (child.turnId === null) {
                child.turnId = progressTurnId;
            }
            if (this.isCurrentForeground(child, progressTurnId)) {
                this.beginForegroundTurn(child, progressTurnId);
                await child.foreground.update({state: "running"});
            }
        }
        switch (notification.method) {
            case "turn/started":
                if (child.endedTurns.has(notification.params.turn.id)) return true;
                if (child.turnId !== notification.params.turn.id) {
                    if (child.turnId !== null) this.endWorkRequests(child, child.turnId);
                }
                child.turnId = notification.params.turn.id;
                if (this.isCurrentForeground(child, child.turnId)) {
                    this.beginForegroundTurn(child, child.turnId);
                    await child.foreground.start();
                }
                return true;
            case "thread/name/updated": {
                const title = normalizeSessionTitle(notification.params.threadName);
                child.title = title;
                await this.session.update({sessionUpdate: "session_info_update", title}, child.sessionId);
                await this.session.update({sessionUpdate: "subagent_update", sessionId: child.sessionId, title}, child.parentSessionId);
                return true;
            }
            case "thread/closed":
            case "thread/archived":
                await this.unknown(child);
                return true;
            case "error":
            case "thread/unarchived":
            case "thread/goal/updated":
            case "thread/goal/cleared":
            case "model/rerouted":
                // Runtime configuration and retry incidents of a child must not mutate its parent.
                return true;
            case "turn/completed": {
                const turn = notification.params.turn;
                if (turn.status === "inProgress") return true;
                this.endWorkRequests(child, turn.id);
                child.endedTurns.add(turn.id);
                if (child.turnId !== null && child.turnId !== turn.id) return true;
                child.turnId = null;
                if (child.foregroundTurnId !== null && child.foregroundTurnId !== turn.id) return true;
                await child.foreground.update(toV2IdleState(
                    {stopReason: turn.status === "interrupted" ? "cancelled" : "end_turn"},
                    turn.status === "failed" ? {
                        code: -32603,
                        message: turn.error ? readableServiceErrorMessage(turn.error.message) : "Subagent work failed",
                    } : undefined,
                ));
                child.foregroundTurnId = null;
                this.onChildWorkEnded(child.sessionId);
                return true;
            }
            case "thread/status/changed":
                if (notification.params.status.type === "notLoaded") {
                    await this.unknown(child);
                } else if (notification.params.status.type === "active"
                    && notification.params.status.activeFlags.length === 0) {
                    await child.foreground.start();
                }
                return true;
            case "item/started":
                if (child.turnId !== null && child.foregroundTurnId === notification.params.turnId
                    && notification.params.item.type !== "userMessage") {
                    await child.foreground.startItem(notification.params.item.id);
                }
                if (notification.params.item.type === "plan") return true;
                break;
            case "item/completed": {
                if (child.foregroundTurnId === notification.params.turnId) await child.foreground.completeItem(notification.params.item.id);
                const item = notification.params.item;
                if (item.type === "plan") {
                    // Completed snapshots avoid replaying a partial draft over newer history.
                    const plans = new CodexPlanStream(this.session.forSession(child.sessionId), this.capabilities);
                    const plan = await plans.completed(item.id, item.text);
                    if (plan?.update) await this.session.update(plan.update, child.sessionId);
                    return true;
                }
                break;
            }
            case "item/plan/delta":
                return true;
        }
        return false;
    }

    private pendingFor(threadId: string): Pending {
        let pending = this.pending.get(threadId);
        if (!pending) {
            pending = {notifications: new PendingNotificationBuffer(threadId)};
            this.pending.set(threadId, pending);
        }
        return pending;
    }

    private parentFor(pending: Pending): string | undefined {
        if (pending.parentThreadId !== undefined) {
            if (pending.parentThreadId === this.rootSessionId) return this.rootSessionId;
            return this.children.get(pending.parentThreadId)?.sessionId;
        }
        if (pending.path === undefined) return undefined;
        const parentPath = pending.path.slice(0, pending.path.lastIndexOf("/"));
        if (isRootAgentPath(parentPath) || parentPath === this.rootSessionId || parentPath === `/${this.rootSessionId}`) {
            return this.rootSessionId;
        }
        return [...this.children.values()].find(child => child.path === parentPath)?.sessionId;
    }

    private async materializePending(): Promise<void> {
        let changed: boolean;
        do {
            changed = false;
            for (const [threadId, pending] of this.pending) {
                const parent = this.parentFor(pending);
                if (parent === undefined) continue;
                await this.announce(threadId, parent, pending.path, pending.description, true);
                this.pending.delete(threadId);
                for (const event of pending.notifications.take()) this.replayQueue.push(event);
                changed = true;
            }
        } while (changed);
    }

    private async restoreKnown(threadId: string): Promise<boolean> {
        if (this.children.has(threadId)) return true;
        const stored = this.associations.forRoot(this.rootSessionId).find(child => child.threadId === threadId);
        if (!stored) return false;
        if (stored.parentSessionId !== this.rootSessionId) {
            const parent = this.associations.get(stored.parentSessionId);
            if (!parent || !await this.restoreKnown(parent.threadId)) return false;
        }
        await this.announce(threadId, stored.parentSessionId);
        return true;
    }

    private async ensureAnnounced(child: Child): Promise<void> {
        await this.ready;
        if (this.retired) return;
        if (this.announced.has(child.threadId)) return;
        const parent = [...this.children.values()].find(candidate => candidate.sessionId === child.parentSessionId);
        if (parent) await this.ensureAnnounced(parent);
        await this.session.update({
            sessionUpdate: "subagent_update", sessionId: child.sessionId, capabilities: {},
            ...(child.title !== undefined ? {title: child.title} : {}),
            ...(child.description !== undefined ? {description: child.description} : {}),
        }, child.parentSessionId);
        this.announced.add(child.threadId);
    }

    async announce(threadId: string, parentSessionId: string, path?: string, description?: string, live = false): Promise<string> {
        const existing = this.children.get(threadId);
        if (existing) {
            existing.live ||= live;
            await this.ensureAnnounced(existing);
            return existing.sessionId;
        }
        const association = this.associations.register(this.rootSessionId, parentSessionId, threadId);
        const title = path === undefined ? undefined : nameFromAgentPath(path, "Agent");
        const child: Child = {
            ...association, turnId: null, foregroundTurnId: null,
            ...(path !== undefined ? {path: normalizeAgentPath(path)} : {}),
            ...(title !== undefined ? {title} : {}),
            ...(description !== undefined ? {description} : {}),
            foreground: new AcpV2ForegroundState(async state => {
                if (this.retired) {
                    if (state.state === "unknown" && this.announced.has(threadId)) {
                        await this.session.updateSubagentState(association.sessionId, parentSessionId, state);
                    }
                    return;
                }
                if (this.deferLive || this.snapshotting) {
                    this.snapshots.set(threadId, {child, state});
                    return;
                }
                await this.session.updateSubagentState(association.sessionId, parentSessionId, state);
            }, "unknown"),
            toolCalls: new CodexSessionToolCalls(),
            streams: new CodexItemStreamState(),
            requests: new AbortController(),
            workRequests: new Map(),
            closedRequestTurns: new Set(),
            endedTurns: new Set(),
            live,
        };
        this.children.set(threadId, child);
        await this.ensureAnnounced(child);
        return child.sessionId;
    }

    /** Historical announcements provide routing, never a claim about current work. */
    async announceHistory(threadId: string, path: string): Promise<string | null> {
        if (threadId === this.rootSessionId) return null;
        const existing = this.children.get(threadId);
        if (existing) {
            await this.ensureAnnounced(existing);
            existing.path = normalizeAgentPath(path);
            const title = nameFromAgentPath(path, "Agent");
            if (title !== existing.title) {
                existing.title = title;
                await this.session.update({sessionUpdate: "subagent_update", sessionId: existing.sessionId, title}, existing.parentSessionId);
            }
            return existing.sessionId;
        }
        const pending: Pending = {path: normalizeAgentPath(path), notifications: new PendingNotificationBuffer(threadId)};
        const parent = this.parentFor(pending);
        return parent === undefined ? null : this.announce(threadId, parent, path);
    }

    releaseReplay(): ServerNotification[] {
        this.snapshotting = this.deferLive;
        this.deferLive = false;
        return this.deferredLive.take();
    }

    async publishReplaySnapshots(): Promise<void> {
        try {
            while (this.snapshots.size > 0) {
                for (const {child} of [...this.snapshots.values()]) {
                    await child.foreground.serializePublication(async () => {
                        const snapshot = this.snapshots.get(child.threadId);
                        this.snapshots.delete(child.threadId);
                        if (!snapshot || this.retired) return;
                        await this.ensureAnnounced(child);
                        await this.session.updateSubagentState(child.sessionId, child.parentSessionId, snapshot.state);
                    });
                }
            }
        } finally {
            this.snapshotting = false;
        }
    }

    pauseForSetup(): void {
        this.deferLive = true;
        this.announced.clear();
        for (const child of this.children.values()) {
            void child.foreground.snapshot().catch(error => logger.error("Failed to snapshot child work", error));
        }
    }

    async withUserAction<T>(sessionId: string, itemId: string | undefined, request: () => Promise<T>, turnId?: string | null): Promise<T> {
        const child = [...this.children.values()].find(child => child.sessionId === sessionId);
        if (!child) return request();
        child.live = true;
        await this.ensureAnnounced(child);
        const work = typeof turnId === "string"
            ? child.workRequests.get(turnId) ?? {controller: new AbortController(), count: 0}
            : undefined;
        if (work && typeof turnId === "string") {
            child.workRequests.set(turnId, work);
            work.count++;
        }
        const obsolete = typeof turnId === "string" && (child.closedRequestTurns.has(turnId) || child.endedTurns.has(turnId));
        const signal = this.retired || obsolete ? AbortSignal.abort() : work
            ? AbortSignal.any([child.requests.signal, work.controller.signal]) : child.requests.signal;
        const foreground = !this.retired && !obsolete && typeof turnId === "string"
            && (this.runningTurnId(child.threadId) ?? child.turnId) === turnId;
        if (foreground) this.beginForegroundTurn(child, turnId);
        try {
            return await runSubagentInteraction({
                sessionId, signal,
                nextToolCallId: serverName => this.associations.nextToolCallId(sessionId, serverName),
                beforeRequest: () => this.ensureAnnounced(child),
                ...(foreground ? {foreground: child.foreground} : {}),
                ...(itemId !== undefined ? {itemId} : {}),
            }, request);
        } finally {
            if (work && --work.count === 0 && typeof turnId === "string" && child.workRequests.get(turnId) === work) {
                child.workRequests.delete(turnId);
            }
        }
    }

    private endWorkRequests(child: Child, turnId: string): void {
        child.workRequests.get(turnId)?.controller.abort();
        child.workRequests.delete(turnId);
    }

    private beginForegroundTurn(child: Child, turnId: string): void {
        if (child.foregroundTurnId === turnId) return;
        child.foregroundTurnId = turnId;
        child.foreground.invalidate();
    }

    private isCurrentForeground(child: Child, turnId: string): boolean {
        const current = this.runningTurnId(child.threadId);
        return current === undefined || current === turnId;
    }

    /** Withdraw requests at receipt time, before output backpressure can delay terminal rendering. */
    observeWorkEnd(notification: ServerNotification): void {
        if (this.retired || notification.method !== "turn/completed" || notification.params.turn.status === "inProgress") return;
        this.closeWorkRequests(notification.params.threadId, notification.params.turn.id);
    }

    closeWorkRequests(threadId: string, turnId: string): void {
        const child = this.children.get(threadId);
        if (!child) return;
        child.closedRequestTurns.add(turnId);
        this.endWorkRequests(child, turnId);
    }

    cancelInteractions(): void {
        for (const child of this.children.values()) {
            if (child.turnId !== null) child.closedRequestTurns.add(child.turnId);
            child.requests.abort();
            child.requests = new AbortController();
            for (const [turnId, work] of child.workRequests) {
                child.closedRequestTurns.add(turnId);
                work.controller.abort();
            }
            child.workRequests.clear();
        }
    }

    private async unknown(child: Child): Promise<void> {
        child.requests.abort();
        child.requests = new AbortController();
        for (const work of child.workRequests.values()) work.controller.abort();
        child.workRequests.clear();
        await child.foreground.update({state: "unknown"});
        child.turnId = null;
        child.foregroundTurnId = null;
    }

    async finishOutstanding(state: SubagentState): Promise<void> {
        // A parent's failure/cancellation alone is not evidence that its children stopped.
        if (state !== "disconnected") return;
        this.retired = true;
        this.cancelInteractions();
        for (const child of this.children.values()) {
            if (this.announced.has(child.threadId)) await this.unknown(child);
            else child.foreground.invalidate();
            child.turnId = null;
        }
    }

    activeTurns(): Array<{threadId: string; turnId: string | null}> {
        return [...this.children.values()].filter(child => child.live)
            .map(child => ({threadId: child.threadId, turnId: child.turnId}));
    }

    setInteractionObserver(observer: (event: ServerNotification, sessionId: string) => Promise<void>): void {
        this.interactionObserver = observer;
    }

    isRetired(): boolean {
        return this.retired;
    }

    openToolCalls(threadId: string): CodexSessionToolCalls | undefined {
        return this.children.get(threadId)?.toolCalls;
    }

    itemStreams(threadId: string): CodexItemStreamState | undefined {
        return this.children.get(threadId)?.streams;
    }

    parentThreadId(threadId: string): string | undefined {
        const parentId = this.children.get(threadId)?.parentSessionId;
        return parentId === this.rootSessionId ? this.rootSessionId
            : parentId === undefined ? undefined : this.associations.get(parentId)?.threadId;
    }

    async restoreRuntime(thread: Thread, turnId: string | undefined): Promise<void> {
        const child = this.children.get(thread.id);
        if (!child || this.retired) return;
        child.live = true;
        if (thread.status.type === "idle") {
            child.turnId = null;
            child.foregroundTurnId = null;
            await child.foreground.update({state: "idle"});
        } else if (thread.status.type === "active" && thread.status.activeFlags.length === 0) {
            child.turnId ??= turnId ?? null;
            if (child.turnId !== null) this.beginForegroundTurn(child, child.turnId);
            await child.foreground.start();
        }
    }

    reconcileHistoryItem(threadId: string, item: ThreadItem, completed: boolean, turnId?: string): void {
        const child = this.children.get(threadId);
        if (!child) return;
        child.toolCalls.restore(item, completed, turnId);
        if (item.type === "commandExecution") child.streams.commands.restore(item);
        if (item.type === "agentMessage") child.streams.agentMessagePhases.set(item.id, item.phase);
        if (item.type === "imageView" && !completed) child.streams.emittedImageViewItems.add(item.id);
        if (!completed) return;
        const items = this.replayedItems.get(threadId) ?? new Set<string>();
        items.add(item.id);
        this.replayedItems.set(threadId, items);
    }

    childSessionIds(): string[] { return [...this.children.values()].map(child => child.sessionId); }
    isNativeSubagentThread(threadId: string): boolean { return this.children.has(threadId); }
    shouldIgnore(): boolean { return false; }
    notificationSessionId(notification: ServerNotification): string {
        const threadId = (notification.params as {threadId?: unknown}).threadId;
        return typeof threadId === "string" ? this.children.get(threadId)?.sessionId ?? this.rootSessionId : this.rootSessionId;
    }
    takeBufferedNotifications(): ServerNotification[] { return this.replayQueue.splice(0); }
    async waitForMaterializedSession(threadId: string): Promise<string | null> {
        if (this.retired) return null;
        await this.materializePending();
        const child = this.children.get(threadId);
        if (child) await this.ensureAnnounced(child);
        return child?.sessionId ?? null;
    }
    closingChildSessions(notification: ServerNotification): ClosingChildSession[] {
        if (notification.method !== "turn/completed") return [];
        const child = this.children.get(notification.params.threadId);
        const turn = notification.params.turn;
        if (!child || turn.status === "inProgress" || (child.turnId !== null && child.turnId !== turn.id)) return [];
        return [{threadId: child.threadId, sessionId: child.sessionId,
            state: turn.status === "interrupted" ? "cancelled" : turn.status === "failed" ? "failed" : "completed"}];
    }
    // A child's independent work must not prolong its parent's completed foreground turn.
    async wait(_signal: AbortSignal): Promise<"settled"> { return "settled"; }
    hasOutstanding(): boolean { return [...this.children.values()].some(child => child.turnId !== null); }
    legacyActivityStarted(item: ThreadItem & {type: "subAgentActivity"}) {
        this.legacyActivities.add(item.id);
        return SubagentActivityReporter.activity(item, "in_progress", "start");
    }
    legacyActivityCompleted(item: ThreadItem & {type: "subAgentActivity"}) {
        return SubagentActivityReporter.activity(item, "completed", this.legacyActivities.delete(item.id) ? "update" : "start");
    }
    legacyCollaborationStarted(item: ThreadItem & {type: "collabAgentToolCall"}) { return CollabAgentReporter.started(item); }
    legacyCollaborationCompleted(item: ThreadItem & {type: "collabAgentToolCall"}) { return CollabAgentReporter.completed(item); }
}

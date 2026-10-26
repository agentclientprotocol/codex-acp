import type {ReasoningEffort, ServerNotification} from "../app-server";
import type {StateUpdate} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type {Thread, ThreadItem, Turn} from "../app-server/v2";
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
import {
    MODEL_SOURCE_RANK, preferredModel, type ChildModel, type ClosingChildSession, type SubagentModels,
} from "./CodexSubagentEventRouter";
import {subagentConfigurationOptions, type ObservedSubagentConfiguration} from "./SubagentConfiguration";
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
type Configuration = {
    model?: ChildModel;
    effort?: {value: ReasoningEffort | null; source: ChildModel["source"]};
    published?: string;
};

/** Work ends; the reusable child conversation and its restrictions remain. */
export class StandardSubagentEventRouter implements SubagentEventRouter {
    private readonly children = new Map<string, Child>();
    private readonly pending = new Map<string, Pending>();
    private readonly replayQueue: ServerNotification[] = [];
    private readonly deferredLive: PendingNotificationBuffer;
    private readonly legacyActivities = new Set<string>();
    private readonly announced = new Set<string>();
    private readonly replayedItems = new Map<string, Map<string, boolean>>();
    private readonly completedItems = new Map<string, Set<string>>();
    private readonly configurations = new Map<string, Configuration>();
    private readonly pendingConfigurations = new Set<string>();
    private readonly configurationRequests = new Map<string, object>();
    private readonly spawnsInFlight = new Set<string>();
    private readonly appliedSettings = new WeakSet<object>();
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
        private readonly rootModels: () => SubagentModels | null = () => null,
        private readonly configurationRuntime?: {
            read(threadId: string, parentThreadId: string): Promise<ObservedSubagentConfiguration | null>;
            enqueuePublication(publish: () => Promise<void>): Promise<void>;
        },
    ) {
        this.deferredLive = new PendingNotificationBuffer(rootSessionId);
    }

    /** Admission precedes rendering, including terminal/tool cleanup. */
    async prepareNotification(notification: ServerNotification): Promise<boolean> {
        const threadId = (notification.params as {threadId?: unknown}).threadId;
        if (typeof threadId !== "string" || threadId === this.rootSessionId) return true;
        if (this.retired) return false;
        if (notification.method === "thread/settings/updated" && !this.appliedSettings.has(notification.params)) {
            this.appliedSettings.add(notification.params);
            const settings = notification.params.threadSettings;
            await this.observeConfiguration(threadId, {model: settings.model, effort: settings.effort}, "settings");
        }
        if (this.deferLive) { this.deferredLive.push(notification); return false; }
        const child = this.children.get(threadId);
        if (!child) {
            const pending = this.pendingFor(threadId);
            pending.notifications.push(notification);
            if (await this.restoreKnown(threadId)) {
                this.pending.delete(threadId);
                this.replayQueue.push(...pending.notifications.take());
            }
            return false;
        }
        await this.ensureAnnounced(child);
        return !this.retired;
    }

    async handle(notification: ServerNotification): Promise<boolean> {
        if (notification.method === "thread/started") {
            const thread = notification.params.thread;
            const child = this.children.get(thread.id);
            const parent = this.children.get(thread.parentThreadId ?? "");
            if (thread.parentThreadId === this.rootSessionId || parent?.live || child?.live
                || (!child && this.spawnsInFlight.size > 0)) {
                await this.observeConfiguration(thread.id, {model: thread.model, effort: thread.reasoningEffort}, "threadStarted");
            }
            return false;
        }
        const threadId = (notification.params as {threadId?: unknown}).threadId;
        if (typeof threadId !== "string") return false;
        if (this.retired) return threadId !== this.rootSessionId
            || ((notification.method === "item/started" || notification.method === "item/completed")
                && (notification.params.item.type === "subAgentActivity" || notification.params.item.type === "collabAgentToolCall"));
        if (notification.method === "item/started" || notification.method === "item/completed") {
            const item = notification.params.item;
            if (item.type === "collabAgentToolCall" && item.tool === "spawnAgent") {
                if (notification.method === "item/started") this.spawnsInFlight.add(item.id);
                else this.spawnsInFlight.delete(item.id);
                for (const id of item.receiverThreadIds) {
                    if (!id.trim() || id === item.senderThreadId || id === this.rootSessionId || this.children.has(id)) continue;
                    const pending = this.pendingFor(id);
                    pending.parentThreadId = item.senderThreadId;
                    if (item.prompt) pending.description = item.prompt;
                }
                await this.materializePending();
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
                } else this.pendingFor(item.agentThreadId).path = normalizeAgentPath(item.agentPath);
                await this.observeConfiguration(item.agentThreadId, {model: item.model, effort: item.reasoningEffort}, "activity");
                await this.materializePending();
                return true;
            }
        }
        if (threadId === this.rootSessionId && notification.method === "turn/completed") {
            this.spawnsInFlight.clear();
            for (const id of this.configurations.keys()) if (!this.children.has(id)) this.configurations.delete(id);
        }
        const child = this.children.get(threadId);
        if (!child) return false;
        await this.ensureAnnounced(child);
        if (this.retired) return true;
        await this.interactionObserver?.(notification, child.sessionId);
        child.live = true;
        const params = notification.params as {itemId?: string; item?: {id: string}};
        const itemId = params.itemId ?? params.item?.id;
        const replayed = itemId === undefined ? undefined : this.replayedItems.get(threadId)?.get(itemId);
        const progressTurnId = (notification.params as {turnId?: string}).turnId;
        const progress = notification.method === "item/agentMessage/delta" || notification.method === "item/plan/delta"
            || notification.method === "item/reasoning/textDelta" || notification.method === "item/reasoning/summaryTextDelta";
        if (replayed !== true && progressTurnId !== undefined && progress && !child.endedTurns.has(progressTurnId)
            && (child.turnId === null || child.turnId === progressTurnId)) {
            child.turnId ??= progressTurnId;
            if (this.isCurrentForeground(child, progressTurnId)) {
                this.beginForegroundTurn(child, progressTurnId);
                await child.foreground.start();
            }
        }
        switch (notification.method) {
            case "turn/started":
                if (child.endedTurns.has(notification.params.turn.id)) return true;
                if (child.turnId !== null && child.turnId !== notification.params.turn.id) this.endWorkRequests(child, child.turnId);
                child.turnId = notification.params.turn.id;
                if (this.isCurrentForeground(child, child.turnId)) {
                    this.beginForegroundTurn(child, child.turnId);
                    await child.foreground.start();
                }
                void this.refreshConfiguration(child);
                return true;
            case "thread/settings/updated":
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
                // Child incidents and execution settings must not mutate the parent.
                return true;
            case "turn/completed": {
                const turn = notification.params.turn;
                const state = turnEndState(turn);
                if (state === undefined || child.endedTurns.has(turn.id)) return true;
                this.endWorkRequests(child, turn.id);
                child.endedTurns.add(turn.id);
                if (child.turnId !== null && child.turnId !== turn.id) return true;
                child.turnId = null;
                if (child.foregroundTurnId !== null && child.foregroundTurnId !== turn.id) return true;
                await child.foreground.update(state);
                child.foregroundTurnId = null;
                this.onChildWorkEnded(child.sessionId);
                return true;
            }
            case "thread/status/changed":
                if (notification.params.status.type === "notLoaded") await this.unknown(child);
                else if (notification.params.status.type === "active" && notification.params.status.activeFlags.length === 0) {
                    await child.foreground.start();
                }
                return true;
            case "item/started":
                if (replayed === true) return true;
                if (notification.params.item.type === "userMessage") return true;
                if (child.turnId !== null && child.foregroundTurnId === notification.params.turnId) {
                    await child.foreground.startItem(notification.params.item.id);
                }
                if (notification.params.item.type === "plan") return true;
                if (replayed === false) return true;
                break;
            case "item/completed": {
                if (child.foregroundTurnId === notification.params.turnId) await child.foreground.completeItem(notification.params.item.id);
                const item = notification.params.item;
                this.rememberCompletedItem(threadId, item.id);
                if (replayed === true) {
                    child.toolCalls.complete(item.id);
                    if (item.type === "commandExecution") child.streams.commands.restore(item);
                    return true;
                }
                if (item.type === "userMessage") return true;
                if (item.type === "plan") {
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
        return replayed === true;
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
        if (pending.parentThreadId !== undefined) return pending.parentThreadId === this.rootSessionId
            ? this.rootSessionId : this.children.get(pending.parentThreadId)?.sessionId;
        if (pending.path === undefined) return undefined;
        const parentPath = pending.path.slice(0, pending.path.lastIndexOf("/"));
        if (isRootAgentPath(parentPath) || parentPath === this.rootSessionId || parentPath === `/${this.rootSessionId}`) return this.rootSessionId;
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
                this.replayQueue.push(...pending.notifications.take());
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
        if (this.retired || this.announced.has(child.threadId)) return;
        const parent = [...this.children.values()].find(candidate => candidate.sessionId === child.parentSessionId);
        if (parent) await this.ensureAnnounced(parent);
        await this.session.update({sessionUpdate: "subagent_update", sessionId: child.sessionId, capabilities: {},
            ...(child.title !== undefined ? {title: child.title} : {}),
            ...(child.description !== undefined ? {description: child.description} : {})}, child.parentSessionId);
        this.announced.add(child.threadId);
        if (this.configurations.has(child.threadId)) {
            this.pendingConfigurations.add(child.threadId);
            if (!this.deferLive && !this.snapshotting) await this.publishConfiguration(child);
        }
    }

    async announce(threadId: string, parentSessionId: string, path?: string, description?: string, live = false): Promise<string> {
        const existing = this.children.get(threadId);
        if (existing) { existing.live ||= live; await this.ensureAnnounced(existing); return existing.sessionId; }
        const association = this.associations.register(this.rootSessionId, parentSessionId, threadId);
        const child: Child = {
            ...association, turnId: null, foregroundTurnId: null,
            ...(path !== undefined ? {path: normalizeAgentPath(path), title: nameFromAgentPath(path, "Agent")} : {}),
            ...(description !== undefined ? {description} : {}),
            foreground: new AcpV2ForegroundState(async state => {
                if (this.retired) {
                    if (state.state === "unknown" && this.announced.has(threadId)) {
                        await this.session.updateSubagentState(association.sessionId, parentSessionId, state);
                    }
                    return;
                }
                if (this.deferLive || this.snapshotting) { this.snapshots.set(threadId, {child, state}); return; }
                await this.session.updateSubagentState(association.sessionId, parentSessionId, state);
            }, "unknown"),
            toolCalls: new CodexSessionToolCalls(), streams: new CodexItemStreamState(),
            requests: new AbortController(), workRequests: new Map(), closedRequestTurns: new Set(), endedTurns: new Set(), live,
        };
        this.children.set(threadId, child);
        await this.ensureAnnounced(child);
        if (live) void this.refreshConfiguration(child);
        return child.sessionId;
    }

    async announceHistory(threadId: string, path: string): Promise<string | null> {
        if (threadId === this.rootSessionId) return null;
        if (await this.restoreKnown(threadId)) return this.children.get(threadId)!.sessionId;
        const parent = this.parentFor({path: normalizeAgentPath(path), notifications: new PendingNotificationBuffer(threadId)});
        return parent === undefined ? null : this.announce(threadId, parent, path);
    }

    private async observeConfiguration(threadId: string, observed: ObservedSubagentConfiguration, source: ChildModel["source"]): Promise<void> {
        const previous = this.configurations.get(threadId);
        if (this.retired || (!previous && !observed.model && observed.effort === null && source !== "settings")) return;
        this.configurationRequests.delete(threadId);
        const next: Configuration = {...previous};
        if (observed.model) next.model = preferredModel(previous?.model, {model: observed.model, source});
        const changedModel = next.model?.model !== previous?.model?.model;
        // A new model cannot retain the old model's effort; null removes an unset or unavailable effort.
        if (changedModel || !previous?.effort || MODEL_SOURCE_RANK[source] >= MODEL_SOURCE_RANK[previous.effort.source]) {
            next.effort = {value: observed.effort, source};
        }
        this.configurations.set(threadId, next);
        const child = this.children.get(threadId);
        if (!child) return;
        this.pendingConfigurations.add(threadId);
        if (!this.deferLive && !this.snapshotting) await this.publishConfiguration(child);
    }

    private async publishConfiguration(child: Child): Promise<void> {
        this.pendingConfigurations.delete(child.threadId);
        await this.ensureAnnounced(child);
        const configuration = this.configurations.get(child.threadId);
        if (!configuration || this.retired) return;
        const options = subagentConfigurationOptions(this.rootModels(), {
            model: configuration.model?.model ?? null, effort: configuration.effort?.value ?? null,
        });
        const signature = JSON.stringify(options);
        if (signature === configuration.published || (options.length === 0 && configuration.published === undefined)) return;
        try {
            await this.session.update({sessionUpdate: "config_option_update", configOptions: options}, child.sessionId);
            configuration.published = signature;
        } catch (error) { logger.error(`Failed to report subagent configuration ${child.threadId}`, error); }
    }

    /** Optional reads stay off the notification lane; only publication rejoins it. */
    private async refreshConfiguration(child: Child): Promise<void> {
        const runtime = this.configurationRuntime;
        const parent = this.parentThreadId(child.threadId);
        if (!runtime || parent === undefined || this.retired) return;
        const request = {};
        this.configurationRequests.set(child.threadId, request);
        try {
            const observed = await runtime.read(child.threadId, parent);
            if (observed === null) return;
            await runtime.enqueuePublication(async () => {
                if (this.retired || this.configurationRequests.get(child.threadId) !== request) return;
                await this.observeConfiguration(child.threadId, observed, "threadStarted");
            });
        } catch (error) { logger.log(`Configuration unavailable for subagent ${child.threadId}`, {error: String(error)}); }
        finally {
            if (this.configurationRequests.get(child.threadId) === request) this.configurationRequests.delete(child.threadId);
        }
    }

    releaseReplay(): ServerNotification[] {
        this.snapshotting = this.deferLive;
        this.deferLive = false;
        return this.deferredLive.take();
    }

    async publishReplaySnapshots(): Promise<void> {
        try {
            for (const child of this.children.values()) if (child.live) void this.refreshConfiguration(child);
            while (this.snapshots.size > 0 || this.pendingConfigurations.size > 0) {
                for (const {child} of [...this.snapshots.values()]) {
                    await child.foreground.serializePublication(async () => {
                        const snapshot = this.snapshots.get(child.threadId);
                        this.snapshots.delete(child.threadId);
                        if (!snapshot || this.retired) return;
                        await this.ensureAnnounced(child);
                        await this.session.updateSubagentState(child.sessionId, child.parentSessionId, snapshot.state);
                    });
                }
                for (const id of [...this.pendingConfigurations]) {
                    const child = this.children.get(id);
                    if (child && !this.retired) await this.publishConfiguration(child);
                    else this.pendingConfigurations.delete(id);
                }
            }
        } finally { this.snapshotting = false; }
    }

    pauseForSetup(): void {
        this.deferLive = true;
        this.announced.clear();
        this.configurations.clear();
        this.pendingConfigurations.clear();
        this.configurationRequests.clear();
        for (const child of this.children.values()) {
            void child.foreground.snapshot().catch(error => logger.error("Failed to snapshot child work", error));
        }
    }

    async withUserAction<T>(sessionId: string, itemId: string | undefined, request: () => Promise<T>, turnId?: string | null): Promise<T> {
        const child = [...this.children.values()].find(child => child.sessionId === sessionId);
        if (!child) return request();
        child.live = true;
        await this.ensureAnnounced(child);
        const work = typeof turnId === "string" ? child.workRequests.get(turnId) ?? {controller: new AbortController(), count: 0} : undefined;
        if (work && typeof turnId === "string") { child.workRequests.set(turnId, work); work.count++; }
        const obsolete = typeof turnId === "string" && (child.closedRequestTurns.has(turnId) || child.endedTurns.has(turnId));
        const signal = this.retired || obsolete ? AbortSignal.abort() : work
            ? AbortSignal.any([child.requests.signal, work.controller.signal]) : child.requests.signal;
        const currentTurn = this.runningTurnId(child.threadId) ?? child.turnId ?? child.foregroundTurnId;
        const foreground = !this.retired && !obsolete && typeof turnId === "string"
            && (currentTurn === null || currentTurn === turnId);
        if (foreground) this.beginForegroundTurn(child, turnId);
        try {
            return await runSubagentInteraction({sessionId, signal,
                nextToolCallId: server => this.associations.nextToolCallId(sessionId, server),
                beforeRequest: () => this.ensureAnnounced(child),
                ...(foreground ? {foreground: child.foreground} : {}), ...(itemId !== undefined ? {itemId} : {})}, request);
        } finally {
            if (work && --work.count === 0 && typeof turnId === "string" && child.workRequests.get(turnId) === work) child.workRequests.delete(turnId);
        }
    }

    private endWorkRequests(child: Child, turnId: string): void { child.workRequests.get(turnId)?.controller.abort(); child.workRequests.delete(turnId); }
    private beginForegroundTurn(child: Child, turnId: string): void {
        if (child.foregroundTurnId === turnId) return;
        child.foregroundTurnId = turnId;
        child.foreground.invalidate();
    }
    private isCurrentForeground(child: Child, turnId: string): boolean {
        const current = this.runningTurnId(child.threadId);
        return current === undefined || current === turnId;
    }
    observeWorkEnd(notification: ServerNotification): void {
        if (!this.retired && notification.method === "turn/completed" && notification.params.turn.status !== "inProgress") {
            this.closeWorkRequests(notification.params.threadId, notification.params.turn.id);
        }
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
            for (const [turnId, work] of child.workRequests) { child.closedRequestTurns.add(turnId); work.controller.abort(); }
            child.workRequests.clear();
        }
    }
    private async unknown(child: Child): Promise<void> {
        this.configurations.delete(child.threadId);
        this.pendingConfigurations.delete(child.threadId);
        this.configurationRequests.delete(child.threadId);
        child.requests.abort();
        child.requests = new AbortController();
        for (const work of child.workRequests.values()) work.controller.abort();
        child.workRequests.clear();
        await child.foreground.update({state: "unknown"});
        child.turnId = null;
        child.foregroundTurnId = null;
    }
    async finishOutstanding(state: SubagentState): Promise<void> {
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
        return [...this.children.values()].filter(child => child.live).map(child => ({threadId: child.threadId, turnId: child.turnId}));
    }
    setInteractionObserver(observer: (event: ServerNotification, sessionId: string) => Promise<void>): void { this.interactionObserver = observer; }
    isRetired(): boolean { return this.retired; }
    openToolCalls(threadId: string): CodexSessionToolCalls | undefined { return this.children.get(threadId)?.toolCalls; }
    itemStreams(threadId: string): CodexItemStreamState | undefined { return this.children.get(threadId)?.streams; }
    parentThreadId(threadId: string): string | undefined {
        const parentId = this.children.get(threadId)?.parentSessionId;
        return parentId === this.rootSessionId ? parentId : parentId === undefined ? undefined : this.associations.get(parentId)?.threadId;
    }

    /** Reconcile bookkeeping before suppressing duplicate presentation; history does not start work. */
    async reconcileHistoryItem(threadId: string, item: ThreadItem, completed: boolean, turnId?: string): Promise<boolean> {
        const child = this.children.get(threadId);
        if (!child || this.retired) return false;
        if (!completed && (this.completedItems.get(threadId)?.has(item.id) || (turnId !== undefined && child.endedTurns.has(turnId)))) return false;
        child.toolCalls.restore(item, completed, turnId);
        if (item.type === "commandExecution") child.streams.commands.restore(item);
        if (item.type === "agentMessage") child.streams.agentMessagePhases.set(item.id, item.phase);
        const items = this.replayedItems.get(threadId) ?? new Map<string, boolean>();
        items.set(item.id, completed);
        this.replayedItems.set(threadId, items);
        if (completed) {
            this.rememberCompletedItem(threadId, item.id);
            await child.foreground.completeItem(item.id);
        }
        return true;
    }

    private rememberCompletedItem(threadId: string, itemId: string): void {
        const items = this.completedItems.get(threadId) ?? new Set<string>();
        items.add(itemId);
        this.completedItems.set(threadId, items);
    }

    async restoreRuntime(thread: Thread, turnId: string | undefined): Promise<void> {
        const child = this.children.get(thread.id);
        if (!child || this.retired) return;
        child.live = true;
        await this.observeConfiguration(thread.id, {model: thread.model, effort: thread.reasoningEffort}, "threadStarted");
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

    /** Historical state bypasses the current foreground cache and grants no runtime ownership. */
    async replayTurnOutcome(threadId: string, turn: Turn): Promise<void> {
        const child = this.children.get(threadId);
        const state = turnEndState(turn);
        if (!child || state === undefined || this.retired) return;
        await this.ensureAnnounced(child);
        if (this.retired) return;
        await this.session.updateSubagentState(child.sessionId, child.parentSessionId, state);
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
        if (!child || turn.status === "inProgress" || child.endedTurns.has(turn.id)
            || (child.turnId !== null && child.turnId !== turn.id)) return [];
        return [{threadId: child.threadId, sessionId: child.sessionId,
            state: turn.status === "interrupted" ? "cancelled" : turn.status === "failed" ? "failed" : "completed"}];
    }
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

function turnEndState(turn: Turn): StateUpdate | undefined {
    switch (turn.status) {
        case "inProgress":
            return undefined;
        case "completed":
            return toV2IdleState({stopReason: "end_turn"});
        case "interrupted":
            return toV2IdleState({stopReason: "cancelled"});
        case "failed":
            return toV2IdleState({stopReason: "end_turn"}, {
                code: -32603,
                message: turn.error ? readableServiceErrorMessage(turn.error.message) : "Subagent work failed",
            });
    }
}

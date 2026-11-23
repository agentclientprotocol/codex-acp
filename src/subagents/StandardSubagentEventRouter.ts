import type {ContentBlock} from "@agentclientprotocol/sdk/unstable";
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
import type {ToolFacts} from "../tool-calls/ToolFacts";
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
import {outgoingMessageId, sendsMessage, SubagentMessages, userMessageText} from "./SubagentMessages";
import {logger} from "../Logger";
import {isAbsoluteProtocolPath} from "../PathUtils";

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
    detached: boolean;
    cancelAdvertised: boolean;
    cancellingTurn?: string;
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
    cwd?: {value: string; source: ChildModel["source"]};
    publishedCwd?: string;
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
    private readonly waits = new Map<string, Map<string, {turnId: string; receivers: string[]}>>();
    private readonly spawnsInFlight = new Set<string>();
    private readonly appliedSettings = new WeakSet<object>();
    // Receipt-time facts fence cancellation while presentation is backpressured.
    private readonly unobservable = new Set<string>();
    private readonly receivedTurnEnds = new Map<string, Set<string>>();
    private retired = false;
    private attachment = 0;
    private cancellationReady = true;
    private snapshotting = false;
    private readonly snapshots = new Map<string, {child: Child; state: StateUpdate}>();
    private interactionObserver?: (event: ServerNotification, sessionId: string) => Promise<void>;
    private readonly messages = new SubagentMessages((update, sessionId) => this.session.update(update, sessionId));

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
        private readonly userMessageContent: (item: ThreadItem & {type: "userMessage"}) => ContentBlock[]
            = item => [{type: "text", text: userMessageText(item)}],
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
            await this.observeConfiguration(threadId, {model: settings.model, effort: settings.effort,
                ...(this.children.has(threadId) ? {cwd: settings.cwd} : {})}, "settings");
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
                await this.observeRole(thread.id, thread.agentRole);
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
            if (this.session.protocolVersion === 2 && item.type === "collabAgentToolCall" && item.tool === "wait") {
                await this.observeWait(item, notification.params.turnId, notification.method === "item/started");
            }
            if (item.type === "collabAgentToolCall" && item.tool === "spawnAgent") {
                if (notification.method === "item/started") this.spawnsInFlight.add(item.id);
                else this.spawnsInFlight.delete(item.id);
                for (const id of item.receiverThreadIds) {
                    if (!id.trim() || id === item.senderThreadId || id === this.rootSessionId || this.children.has(id)) continue;
                    const pending = this.pendingFor(id);
                    pending.parentThreadId = item.senderThreadId;
                }
                await this.materializePending();
                await this.reportOutgoingMessages(item);
                return true;
            }
            if (item.type === "collabAgentToolCall") await this.reportOutgoingMessages(item);
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
        if (this.session.protocolVersion === 2 && notification.method === "turn/completed"
            && notification.params.turn.status !== "inProgress") {
            await this.detachChildren(threadId, notification.params.turn.id);
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
        try { return await this.handleChild(notification, child, threadId); }
        finally { await this.publishCancellation(child); }
    }

    private async handleChild(notification: ServerNotification, child: Child, threadId: string): Promise<boolean> {
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
                if (notification.params.item.type === "userMessage") {
                    await this.reportIncomingMessage(threadId, notification.params.item);
                    return true;
                }
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
                if (item.type === "userMessage") {
                    await this.reportIncomingMessage(threadId, item);
                    return true;
                }
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
            foreground: this.session.createChildForeground(association.sessionId, async state => {
                if (this.retired) {
                    if (state.state === "unknown" && this.announced.has(threadId)) {
                        await this.session.updateSubagentState(association.sessionId, parentSessionId, state);
                    }
                    return;
                }
                if (this.deferLive || this.snapshotting) { this.snapshots.set(threadId, {child, state}); return; }
                await this.session.updateSubagentState(association.sessionId, parentSessionId, state);
                await this.updateParentBackground(child, state);
            }),
            toolCalls: new CodexSessionToolCalls(), streams: new CodexItemStreamState(),
            requests: new AbortController(), workRequests: new Map(), closedRequestTurns: new Set(), endedTurns: new Set(), live,
            detached: false, cancelAdvertised: false,
        };
        this.children.set(threadId, child);
        await this.ensureAnnounced(child);
        if (live) await this.publishCancellation(child);
        if (live) void this.refreshConfiguration(child);
        return child.sessionId;
    }

    async announceHistory(threadId: string, path: string): Promise<string | null> {
        if (threadId === this.rootSessionId) return null;
        if (await this.restoreKnown(threadId)) {
            const child = this.children.get(threadId)!;
            child.path ??= normalizeAgentPath(path);
            return child.sessionId;
        }
        const parent = this.parentFor({path: normalizeAgentPath(path), notifications: new PendingNotificationBuffer(threadId)});
        return parent === undefined ? null : this.announce(threadId, parent, path);
    }

    /** The role Codex assigned describes the child. The task it was given is a message, not a description. */
    async observeRole(threadId: string, description: string | null): Promise<void> {
        if (!description?.trim() || this.retired) return;
        const child = this.children.get(threadId);
        if (!child) { this.pendingFor(threadId).description = description; return; }
        if (child.description === description) return;
        child.description = description;
        if (!this.announced.has(threadId)) return;
        await this.session.update({sessionUpdate: "subagent_update", sessionId: child.sessionId, description}, child.parentSessionId);
    }

    /** The sender's view of a prompt it sent to announced children. A failed or unfinished call sent nothing. */
    async reportOutgoingMessages(item: ThreadItem & {type: "collabAgentToolCall"}): Promise<void> {
        if (this.retired || !sendsMessage(item)) return;
        const sender = item.senderThreadId === this.rootSessionId ? this.rootSessionId : this.children.get(item.senderThreadId)?.sessionId;
        if (sender === undefined) return;
        for (const id of new Set(item.receiverThreadIds)) {
            const receiver = this.children.get(id);
            if (!receiver || receiver.sessionId === sender) continue;
            await this.ensureAnnounced(receiver);
            if (!this.announced.has(id)) continue;
            await this.messages.outgoing(sender, receiver.sessionId, outgoingMessageId(item, id), item.prompt);
        }
    }

    /** What the child received. The sender is named only when its outgoing view was observed. */
    async reportIncomingMessage(threadId: string, item: ThreadItem & {type: "userMessage"}): Promise<void> {
        const child = this.children.get(threadId);
        if (!child || this.retired) return;
        await this.ensureAnnounced(child);
        if (!this.announced.has(threadId)) return;
        await this.messages.incoming(child.sessionId, item.id, userMessageText(item), this.userMessageContent(item));
    }

    /** A replay reports the recorded messages again. */
    beginHistoryReplay(): void { this.messages.reset(); }

    private async observeConfiguration(threadId: string, observed: ObservedSubagentConfiguration, source: ChildModel["source"]): Promise<void> {
        const previous = this.configurations.get(threadId);
        const cwd = observed.cwd !== undefined && isAbsoluteProtocolPath(observed.cwd) ? observed.cwd : null;
        if (this.retired || (!previous && !observed.model && observed.effort === null && cwd === null && source !== "settings")) return;
        this.configurationRequests.delete(threadId);
        const next: Configuration = {...previous};
        if (observed.model) next.model = preferredModel(previous?.model, {model: observed.model, source});
        if (cwd !== null && (!previous?.cwd || MODEL_SOURCE_RANK[source] >= MODEL_SOURCE_RANK[previous.cwd.source])) {
            next.cwd = {value: cwd, source};
        }
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
        if (configuration.cwd && configuration.cwd.value !== configuration.publishedCwd) {
            await this.session.update({sessionUpdate: "subagent_update", sessionId: child.sessionId,
                cwd: configuration.cwd.value}, child.parentSessionId);
            configuration.publishedCwd = configuration.cwd.value;
        }
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
        this.cancellationReady = true;
        return this.deferredLive.take();
    }

    /** A live child absent from retained history still needs its replay boundary. */
    async announceLiveChildrenForReplay(): Promise<void> {
        if (this.session.protocolVersion !== 2) return;
        for (const child of this.children.values()) {
            if (child.live || this.session.forSession(child.parentSessionId)
                .hasBackgroundItem({type: "subagent", sessionId: child.sessionId})) await this.ensureAnnounced(child);
        }
    }

    private async observeWait(item: Extract<ThreadItem, {type: "collabAgentToolCall"}>, turnId: string, started: boolean): Promise<void> {
        const waits = this.waits.get(item.senderThreadId) ?? new Map<string, {turnId: string; receivers: string[]}>();
        if (started) waits.set(item.id, {turnId, receivers: item.receiverThreadIds});
        else waits.delete(item.id);
        if (waits.size > 0) this.waits.set(item.senderThreadId, waits);
        else this.waits.delete(item.senderThreadId);
        for (const child of this.children.values()) {
            if (this.parentThreadId(child.threadId) === item.senderThreadId) {
                await this.updateParentBackground(child, child.foreground.current());
            }
        }
    }

    private async detachChildren(parentThreadId: string, turnId: string): Promise<void> {
        const waits = this.waits.get(parentThreadId);
        if (waits) {
            for (const [id, wait] of waits) if (wait.turnId === turnId) waits.delete(id);
            if (waits.size === 0) this.waits.delete(parentThreadId);
        }
        for (const child of this.children.values()) {
            if (this.parentThreadId(child.threadId) !== parentThreadId || !this.announced.has(child.threadId)) continue;
            child.detached = true;
            await this.updateParentBackground(child, child.foreground.current());
        }
    }

    private async updateParentBackground(child: Child, state: StateUpdate): Promise<void> {
        if (this.session.protocolVersion !== 2) return;
        const parent = this.session.forSession(child.parentSessionId);
        const item = {type: "subagent", sessionId: child.sessionId} as const;
        const waits = this.waits.get(this.parentThreadId(child.threadId) ?? "");
        // Codex's wait-for-any operation has no explicit receivers.
        const waiting = waits !== undefined && [...waits.values()].some(wait =>
            wait.receivers.length === 0 || wait.receivers.includes(child.threadId));
        const active = state.state === "running" || state.state === "requires_action"
            || this.session.forSession(child.sessionId).hasBackgroundWork()
            || state.state === "unknown" && parent.hasBackgroundItem(item);
        if (!active) child.detached = false;
        else if (parent.isForegroundIdle()) child.detached = true;
        await parent.setBackgroundItem(item, child.detached && active && !waiting);
    }

    /** Reannounce live children deepest first so a parent's list only refers to current entities. */
    async snapshotBackground(refreshTerminals: (threadId: string, sessionId: string, idle: boolean) => Promise<void>): Promise<void> {
        if (this.session.protocolVersion !== 2) return;
        const children = [...this.children.values()].reverse();
        for (const child of children) this.session.forSession(child.sessionId).setBackgroundSync(true);
        for (const child of children) {
            const view = this.session.forSession(child.sessionId);
            const parent = this.session.forSession(child.parentSessionId);
            const item = {type: "subagent", sessionId: child.sessionId} as const;
            if (!child.live && !parent.hasBackgroundItem(item)) {
                view.setBackgroundSync(false);
                continue;
            }
            await this.ensureAnnounced(child);
            await refreshTerminals(child.threadId, child.sessionId, child.foreground.isIdle);
            await child.foreground.serializePublication(async () => {
                view.setBackgroundSync(false);
                const state = child.foreground.current();
                // Defer ordinary child snapshots to their existing delivery path unless needed
                // to describe an entity in this resume's background list.
                await this.updateParentBackground(child, state);
                if (!parent.hasBackgroundItem(item) && !view.hasBackgroundWork()) return;
                const cancel = this.currentTurn(child) !== null ? {} : null;
                await this.session.updateSubagentState(child.sessionId, child.parentSessionId, state, {cancel});
                child.cancelAdvertised = cancel !== null;
                this.snapshots.delete(child.threadId);
            });
        }
    }

    async publishReplaySnapshots(): Promise<void> {
        try {
            for (const child of this.children.values()) if (child.live) void this.refreshConfiguration(child);
            while (this.snapshots.size > 0 || this.pendingConfigurations.size > 0) {
                await this.publishStateSnapshots();
                for (const id of [...this.pendingConfigurations]) {
                    const child = this.children.get(id);
                    if (child && !this.retired) await this.publishConfiguration(child);
                    else this.pendingConfigurations.delete(id);
                }
            }
            for (const child of this.children.values()) await this.publishCancellation(child, true);
        } finally { this.snapshotting = false; }
    }

    private async publishStateSnapshots(): Promise<void> {
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

    pauseForSetup(): void {
        this.deferLive = true;
        this.suspendCancellation();
        this.attachment++;
        this.announced.clear();
        this.configurations.clear();
        this.pendingConfigurations.clear();
        this.configurationRequests.clear();
        for (const child of this.children.values()) {
            child.cancelAdvertised = false;
            if (child.live) void child.foreground.snapshot().catch(error => logger.error("Failed to snapshot child work", error));
        }
    }

    async withUserAction<T>(sessionId: string, itemId: string | undefined, request: () => Promise<T>, turnId?: string | null): Promise<T> {
        const child = [...this.children.values()].find(child => child.sessionId === sessionId);
        if (!child) return request();
        await this.ensureAnnounced(child);
        const work = typeof turnId === "string" ? child.workRequests.get(turnId) ?? {controller: new AbortController(), count: 0} : undefined;
        if (work && typeof turnId === "string") { child.workRequests.set(turnId, work); work.count++; }
        const obsolete = typeof turnId === "string" && (child.closedRequestTurns.has(turnId) || child.endedTurns.has(turnId));
        if (!obsolete && !this.retired) child.live = true;
        const signal = this.retired || obsolete ? AbortSignal.abort() : work
            ? AbortSignal.any([child.requests.signal, work.controller.signal]) : child.requests.signal;
        const currentTurn = this.runningTurnId(child.threadId) ?? child.turnId ?? child.foregroundTurnId;
        const foreground = !this.retired && !obsolete && typeof turnId === "string"
            && (currentTurn === null || currentTurn === turnId);
        if (foreground) this.beginForegroundTurn(child, turnId);
        await this.publishCancellation(child);
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
        if (notification.method === "turn/started" || notification.method === "thread/status/changed" && notification.params.status.type !== "notLoaded") {
            this.unobservable.delete(notification.params.threadId);
        }
        if (!this.retired && (notification.method === "thread/closed" || notification.method === "thread/archived"
            || notification.method === "thread/status/changed" && notification.params.status.type === "notLoaded")) {
            this.unobservable.add(notification.params.threadId);
            const child = this.children.get(notification.params.threadId);
            if (child) child.live = false;
        }
        if (!this.retired && notification.method === "turn/completed" && notification.params.turn.status !== "inProgress") {
            const turns = this.receivedTurnEnds.get(notification.params.threadId) ?? new Set<string>();
            turns.add(notification.params.turn.id);
            this.receivedTurnEnds.set(notification.params.threadId, turns);
            this.closeWorkRequests(notification.params.threadId, notification.params.turn.id);
        }
    }
    closeWorkRequests(threadId: string, turnId: string): void {
        const child = this.children.get(threadId);
        if (!child) return;
        child.closedRequestTurns.add(turnId);
        this.endWorkRequests(child, turnId);
    }
    cancelInteractions(threadIds?: ReadonlySet<string>): void {
        for (const child of this.children.values()) {
            if (threadIds === undefined || threadIds.has(child.threadId)) this.cancelChildInteractions(child);
        }
    }

    private cancelChildInteractions(child: Child): void {
        if (child.turnId !== null) child.closedRequestTurns.add(child.turnId);
        child.requests.abort();
        child.requests = new AbortController();
        for (const [turnId, work] of child.workRequests) { child.closedRequestTurns.add(turnId); work.controller.abort(); }
        child.workRequests.clear();
    }

    private currentTurn(child: Child): string | null {
        if (this.retired || !child.live || this.unobservable.has(child.threadId)) return null;
        const native = this.runningTurnId(child.threadId);
        const turn = native ?? child.turnId ?? child.foregroundTurnId;
        return turn === null || child.endedTurns.has(turn)
            || this.receivedTurnEnds.get(child.threadId)?.has(turn) ? null : turn;
    }

    private async publishCancellation(child: Child, replayFlush = false): Promise<void> {
        if (this.deferLive || this.snapshotting && !replayFlush) return;
        const attachment = this.attachment;
        await this.ensureAnnounced(child);
        if (!this.announced.has(child.threadId)) return;
        for (;;) {
            const available = this.cancellationReady && this.currentTurn(child) !== null;
            if (available === child.cancelAdvertised) return;
            await this.session.update({sessionUpdate: "subagent_update", sessionId: child.sessionId,
                capabilities: {cancel: available ? {} : null}}, child.parentSessionId);
            if (attachment !== this.attachment) return;
            child.cancelAdvertised = available;
        }
    }

    /** Cancel the addressed foreground work. ACP v1 also cancels descendant work. */
    async cancelChild(sessionId: string, interrupt: (threadId: string, turnId: string) => Promise<void>): Promise<void> {
        const child = [...this.children.values()].find(child => child.sessionId === sessionId);
        if (!child || !this.cancellationReady || this.deferLive || !child.cancelAdvertised || this.currentTurn(child) === null) return;
        const targets = this.interruptionTree(sessionId, false).map(target => ({child: target, turnId: this.currentTurn(target)}));
        await Promise.all(targets.map(async ({child: target, turnId}) => {
            if (turnId === null || target.cancellingTurn === turnId) return;
            target.cancellingTurn = turnId;
            this.cancelChildInteractions(target);
            this.closeWorkRequests(target.threadId, turnId);
            try { await interrupt(target.threadId, turnId); }
            catch (error) { logger.error(`Failed to interrupt child ${target.threadId}`, error); }
            finally {
                if (target.cancellingTurn === turnId) delete target.cancellingTurn;
            }
        }));
    }

    suspendCancellation(): void { this.cancellationReady = false; }

    private async unknown(child: Child): Promise<void> {
        child.live = false;
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
        await this.publishCancellation(child);
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

    private interruptionTree(sessionId: string, includeBackground: boolean): Child[] {
        const reachable = new Set([sessionId]);
        // Announcements insert ancestors before descendants.
        for (const child of this.children.values()) {
            if (!reachable.has(child.parentSessionId)) continue;
            const parent = this.session.forSession(child.parentSessionId);
            if (!includeBackground && parent.hasBackgroundItem({type: "subagent", sessionId: child.sessionId})) continue;
            reachable.add(child.sessionId);
        }
        return [...this.children.values()].filter(child => reachable.has(child.sessionId));
    }

    activeTurns(includeBackground = true): Array<{threadId: string; turnId: string | null}> {
        return this.interruptionTree(this.rootSessionId, includeBackground).filter(child => child.live)
            .map(child => ({threadId: child.threadId, turnId: this.currentTurn(child)}));
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
        await this.observeRole(thread.id, thread.agentRole);
        if (thread.status.type === "idle") {
            child.turnId = null;
            child.foregroundTurnId = null;
            await child.foreground.update({state: "idle"});
        } else if (thread.status.type === "active" && thread.status.activeFlags.length === 0) {
            child.turnId ??= turnId ?? null;
            if (child.turnId !== null) this.beginForegroundTurn(child, child.turnId);
            await child.foreground.start();
        }
        await this.publishCancellation(child);
    }

    /** Historical state bypasses the current foreground cache and grants no runtime ownership. */
    async replayTurnOutcome(threadId: string, turn: Turn): Promise<void> {
        const child = this.children.get(threadId);
        const state = turnEndState(turn);
        if (!child || state === undefined || this.retired) return;
        await this.ensureAnnounced(child);
        if (this.retired) return;
        // This is a historical association on the parent, not a live child state_update.
        await this.session.update({sessionUpdate: "subagent_update", sessionId: child.sessionId, state}, child.parentSessionId);
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
    legacyCollaborationStarted(item: ThreadItem & {type: "collabAgentToolCall"}) { return this.withSessionReferences(item, CollabAgentReporter.started(item)); }
    legacyCollaborationCompleted(item: ThreadItem & {type: "collabAgentToolCall"}) { return this.withSessionReferences(item, CollabAgentReporter.completed(item)); }

    /** A visible collaboration call links to the announced children it operates on. */
    private withSessionReferences(item: ThreadItem & {type: "collabAgentToolCall"}, facts: ToolFacts): ToolFacts {
        const content = [...new Set(item.receiverThreadIds)].flatMap(id => {
            const child = this.children.get(id);
            return child && this.announced.has(id) ? [{type: "session" as const, sessionId: child.sessionId}] : [];
        });
        return content.length === 0 ? facts : {...facts, standard: {...facts.standard, content}};
    }
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

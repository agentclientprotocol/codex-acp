import type {
    ApprovalHandler,
    CodexAppServerClient,
    ElicitationHandler,
} from "../CodexAppServerClient";
import type {ServerNotification} from "../app-server";
import {isRootAgentPath} from "./CodexAgentPath";

export type Subscription = {
    rootSessionId: string;
    supportsSubagents: boolean;
    dispatch(event: ServerNotification): void | Promise<void>;
    enqueueInteraction(event: ServerNotification): void | Promise<void>;
    approvalHandler: ApprovalHandler;
    elicitationHandler: ElicitationHandler;
    waitForRootNotifications(): Promise<void>;
    waitForChildSession(childThreadId: string): Promise<string | null>;
    captureChild?: ((childThreadId: string) => Subscription) | undefined;
};

type SessionSubscription = {
    current: Subscription;
    children: Map<string, ChildSubscription>;
};

type ChildSubscription = {
    turnId: string | null;
    ended: boolean;
    retiredTurnIds: Set<string>;
    reused: boolean;
};

/** Discovers child threads and keeps their output/interaction boundary negotiated. */
export class CodexSubagentSubscriptions {
    private readonly sessions = new Map<string, SessionSubscription>();

    constructor(private readonly client: CodexAppServerClient) {}

    subscribe(subscription: Subscription): void {
        const existing = this.sessions.get(subscription.rootSessionId);
        if (existing) {
            existing.current = subscription;
            return;
        }

        const session: SessionSubscription = {current: subscription, children: new Map()};
        this.sessions.set(subscription.rootSessionId, session);
        this.client.onServerNotification(subscription.rootSessionId, (event) => {
            if (this.sessions.get(subscription.rootSessionId) !== session) return;
            // Register synchronously: app-server may emit child output directly
            // after the spawning collaboration item.
            this.discover(session, event);
            session.current.dispatch(event);
        });
        this.registerInteractiveHandlers(session, subscription.rootSessionId);
    }

    clear(rootSessionId: string): void {
        for (const childSessionId of this.sessions.get(rootSessionId)?.children.keys() ?? []) {
            this.client.clearThreadHandlers(childSessionId);
        }
        this.sessions.delete(rootSessionId);
    }

    private discover(session: SessionSubscription, event: ServerNotification, parent?: Subscription): void {
        if (event.method !== "item/started" && event.method !== "item/completed") {
            return;
        }
        const item = event.params.item;
        const resumesChild = item.type === "collabAgentToolCall"
            && ["resumeAgent", "sendInput", "followupTask"].includes(item.tool);
        const childSessionIds = item.type === "collabAgentToolCall" && (item.tool === "spawnAgent" || resumesChild)
            ? item.receiverThreadIds
            : item.type === "subAgentActivity" && item.kind !== "interrupted" && !isRootAgentPath(item.agentPath)
                ? [item.agentThreadId]
                : [];
        for (const childSessionId of childSessionIds) {
            if (childSessionId.trim() === "") continue;
            const previous = session.children.get(childSessionId);
            if (childSessionId === session.current.rootSessionId
                || childSessionId === event.params.threadId
                || (previous && !(resumesChild && previous.ended))) {
                continue;
            }
            const child: ChildSubscription = {
                turnId: null, ended: false, reused: previous !== undefined,
                retiredTurnIds: new Set(previous?.retiredTurnIds),
            };
            if (previous?.turnId) child.retiredTurnIds.add(previous.turnId);
            session.children.set(childSessionId, child);
            // A child keeps the turn's event/permission context even after the root
            // starts another queued turn. Do not resolve it from session.current later.
            const owner = parent?.captureChild?.(childSessionId) ?? parent ?? session.current.captureChild?.(childSessionId);
            this.client.onServerNotification(childSessionId, (childEvent) => {
                if (this.sessions.get(session.current.rootSessionId) !== session
                    || session.children.get(childSessionId) !== child) return;
                const eventThreadId = (childEvent.params as {threadId?: unknown}).threadId;
                if (eventThreadId !== childSessionId) return;
                const turnId = childEvent.method === "turn/started" || childEvent.method === "turn/completed"
                    ? childEvent.params.turn.id : (childEvent.params as {turnId?: string}).turnId;
                if (turnId && child.retiredTurnIds.has(turnId)) return;
                if (childEvent.method === "turn/started") {
                    if (child.turnId !== turnId && child.turnId !== null) child.retiredTurnIds.add(child.turnId);
                    child.turnId = childEvent.params.turn.id;
                    child.ended = false;
                } else if (turnId && child.turnId !== null && turnId !== child.turnId) return;
                if (childEvent.method === "turn/completed") {
                    child.turnId = childEvent.params.turn.id;
                    child.ended = true;
                    child.retiredTurnIds.add(childEvent.params.turn.id);
                }
                this.discover(session, childEvent, owner);
                const current = owner ?? session.current;
                if (current.supportsSubagents) current.dispatch(childEvent);
                else current.enqueueInteraction(owner ? childEvent : this.rootAttributed(childEvent, current.rootSessionId));
            });
            // Hidden children keep only root-attributed permission requests.
            this.registerInteractiveHandlers(session, childSessionId, owner, child);
        }
    }

    private registerInteractiveHandlers(session: SessionSubscription, targetSessionId: string, owner?: Subscription, child?: ChildSubscription): void {
        const resolveSession = async (current: Subscription, turnId?: string | null): Promise<string | null> => {
            // Capture even uncorrelated elicitations before waiting: they must not
            // cross a child turn or subscription replacement while materializing.
            const requestedTurn = child?.turnId;
            const isCurrent = () => this.sessions.get(current.rootSessionId) === session
                && (!child || (session.children.get(targetSessionId) === child && !child.ended
                    && (turnId == null ? child.turnId === requestedTurn : child.turnId === turnId
                        || (child.turnId === null && !child.reused && !child.retiredTurnIds.has(turnId)))));
            await current.waitForRootNotifications();
            if (!isCurrent()) return null;
            const sessionId = await this.interactionSessionId(current, targetSessionId);
            return isCurrent() ? sessionId : null;
        };
        this.client.onApprovalRequest(targetSessionId, {
            handleCommandExecution: async (params) => {
                const current = owner ?? session.current;
                const sessionId = await resolveSession(current, params.turnId);
                if (sessionId === null) return {decision: "cancel"};
                return await current.approvalHandler.handleCommandExecution(
                    {...params, threadId: sessionId},
                );
            },
            handleFileChange: async (params) => {
                const current = owner ?? session.current;
                const sessionId = await resolveSession(current, params.turnId);
                if (sessionId === null) return {decision: "cancel"};
                return await current.approvalHandler.handleFileChange(
                    {...params, threadId: sessionId},
                );
            },
            handlePermissionsRequest: async (params) => {
                const current = owner ?? session.current;
                const sessionId = await resolveSession(current, params.turnId);
                if (sessionId === null) return {permissions: {}, scope: "turn", strictAutoReview: false};
                return await current.approvalHandler.handlePermissionsRequest(
                    {...params, threadId: sessionId},
                );
            },
        });
        this.client.onElicitationRequest(targetSessionId, {
            handleElicitation: async (params) => {
                const current = owner ?? session.current;
                const sessionId = await resolveSession(current, params.turnId);
                if (sessionId === null) return {action: "cancel", content: null, _meta: null};
                return await current.elicitationHandler.handleElicitation(
                    {...params, threadId: sessionId},
                );
            },
            handleUserInput: async (params) => {
                const current = owner ?? session.current;
                const sessionId = await resolveSession(current, params.turnId);
                if (sessionId === null) return {answers: {}};
                return await current.elicitationHandler.handleUserInput(
                    {...params, threadId: sessionId},
                );
            },
        });
    }

    private async interactionSessionId(
        subscription: Subscription,
        targetSessionId: string,
    ): Promise<string | null> {
        if (targetSessionId === subscription.rootSessionId) return targetSessionId;
        if (!subscription.supportsSubagents) return subscription.rootSessionId;
        return await subscription.waitForChildSession(targetSessionId);
    }

    private rootAttributed(event: ServerNotification, rootSessionId: string): ServerNotification {
        if (typeof (event.params as {threadId?: unknown}).threadId !== "string") return event;
        return {
            ...event,
            params: {...event.params, threadId: rootSessionId},
        } as ServerNotification;
    }
}

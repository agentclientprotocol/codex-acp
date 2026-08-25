import type {
    ApprovalHandler,
    CodexAppServerClient,
    ElicitationHandler,
} from "../CodexAppServerClient";
import type {ServerNotification} from "../app-server";
import {isRootAgentPath} from "./CodexAgentPath";

type Subscription = {
    rootSessionId: string;
    supportsSubagents: boolean;
    dispatch(event: ServerNotification): void;
    enqueueInteraction(event: ServerNotification): void;
    approvalHandler: ApprovalHandler;
    elicitationHandler: ElicitationHandler;
    waitForRootNotifications(): Promise<void>;
    waitForChildSession(childThreadId: string): Promise<string | null>;
};

type SessionSubscription = {
    current: Subscription;
    children: Set<string>;
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

        const session = {current: subscription, children: new Set<string>()};
        this.sessions.set(subscription.rootSessionId, session);
        this.client.onServerNotification(subscription.rootSessionId, (event) => {
            // Register synchronously: app-server may emit child output directly
            // after the spawning collaboration item.
            this.discover(session, event);
            session.current.dispatch(event);
        });
        this.registerInteractiveHandlers(session, subscription.rootSessionId);
    }

    clear(rootSessionId: string): void {
        for (const childSessionId of this.sessions.get(rootSessionId)?.children ?? []) {
            this.client.clearThreadHandlers(childSessionId);
        }
        this.sessions.delete(rootSessionId);
    }

    private discover(session: SessionSubscription, event: ServerNotification): void {
        if (event.method !== "item/started" && event.method !== "item/completed") {
            return;
        }
        const item = event.params.item;
        const childSessionIds = item.type === "collabAgentToolCall" && item.tool === "spawnAgent"
            ? item.receiverThreadIds
            : item.type === "subAgentActivity" && item.kind !== "interrupted" && !isRootAgentPath(item.agentPath)
                ? [item.agentThreadId]
                : [];
        for (const childSessionId of childSessionIds) {
            if (childSessionId.trim() === "") continue;
            if (childSessionId === session.current.rootSessionId
                || childSessionId === event.params.threadId
                || session.children.has(childSessionId)) {
                continue;
            }
            session.children.add(childSessionId);
            this.client.onServerNotification(childSessionId, (childEvent) => {
                const eventThreadId = (childEvent.params as {threadId?: unknown}).threadId;
                if (eventThreadId !== childSessionId) return;
                this.discover(session, childEvent);
                if (session.current.supportsSubagents) session.current.dispatch(childEvent);
                else session.current.enqueueInteraction(this.rootAttributed(childEvent, session.current.rootSessionId));
            });
            // Hidden children keep only root-attributed permission requests.
            this.registerInteractiveHandlers(session, childSessionId);
        }
    }

    private registerInteractiveHandlers(session: SessionSubscription, targetSessionId: string): void {
        this.client.onApprovalRequest(targetSessionId, {
            handleCommandExecution: async (params) => {
                const current = session.current;
                await current.waitForRootNotifications();
                const sessionId = await this.interactionSessionId(current, targetSessionId);
                if (sessionId === null) return {decision: "cancel"};
                return await current.approvalHandler.handleCommandExecution(
                    {...params, threadId: sessionId},
                );
            },
            handleFileChange: async (params) => {
                const current = session.current;
                await current.waitForRootNotifications();
                const sessionId = await this.interactionSessionId(current, targetSessionId);
                if (sessionId === null) return {decision: "cancel"};
                return await current.approvalHandler.handleFileChange(
                    {...params, threadId: sessionId},
                );
            },
            handlePermissionsRequest: async (params) => {
                const current = session.current;
                await current.waitForRootNotifications();
                const sessionId = await this.interactionSessionId(current, targetSessionId);
                if (sessionId === null) return {permissions: {}, scope: "turn", strictAutoReview: false};
                return await current.approvalHandler.handlePermissionsRequest(
                    {...params, threadId: sessionId},
                );
            },
        });
        this.client.onElicitationRequest(targetSessionId, {
            handleElicitation: async (params) => {
                const current = session.current;
                await current.waitForRootNotifications();
                const sessionId = await this.interactionSessionId(current, targetSessionId);
                if (sessionId === null) return {action: "cancel", content: null, _meta: null};
                return await current.elicitationHandler.handleElicitation(
                    {...params, threadId: sessionId},
                );
            },
            handleUserInput: async (params) => {
                const current = session.current;
                await current.waitForRootNotifications();
                const sessionId = await this.interactionSessionId(current, targetSessionId);
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

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
    approvalHandler: ApprovalHandler;
    elicitationHandler: ElicitationHandler;
    waitForRootNotifications(): Promise<void>;
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
                return await current.approvalHandler.handleCommandExecution(
                    this.rootPermissionParams(current, targetSessionId, params),
                );
            },
            handleFileChange: async (params) => {
                const current = session.current;
                await current.waitForRootNotifications();
                return await current.approvalHandler.handleFileChange(
                    this.rootPermissionParams(current, targetSessionId, params),
                );
            },
            handlePermissionsRequest: async (params) => {
                const current = session.current;
                await current.waitForRootNotifications();
                return await current.approvalHandler.handlePermissionsRequest(
                    this.rootPermissionParams(current, targetSessionId, params),
                );
            },
        });
        this.client.onElicitationRequest(targetSessionId, {
            handleElicitation: async (params) => {
                const current = session.current;
                await current.waitForRootNotifications();
                return await current.elicitationHandler.handleElicitation(params);
            },
            handleUserInput: async (params) => {
                const current = session.current;
                await current.waitForRootNotifications();
                return await current.elicitationHandler.handleUserInput(params);
            },
        });
    }

    private rootPermissionParams<T extends {threadId: string}>(
        subscription: Subscription,
        targetSessionId: string,
        params: T,
    ): T {
        return !subscription.supportsSubagents && targetSessionId !== subscription.rootSessionId
            ? {...params, threadId: subscription.rootSessionId}
            : params;
    }
}

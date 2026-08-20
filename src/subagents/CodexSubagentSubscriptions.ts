import type {
    ApprovalHandler,
    CodexAppServerClient,
    ElicitationHandler,
} from "../CodexAppServerClient";
import type {ServerNotification} from "../app-server";

type Subscription = {
    rootSessionId: string;
    supportsSubagents: boolean;
    dispatch(event: ServerNotification): void;
    approvalHandler: ApprovalHandler;
    elicitationHandler: ElicitationHandler;
    waitForRootNotifications(): Promise<void>;
};

/** Discovers child threads and keeps their output/interaction boundary negotiated. */
export class CodexSubagentSubscriptions {
    private readonly childrenByRoot = new Map<string, Set<string>>();

    constructor(private readonly client: CodexAppServerClient) {}

    subscribe(subscription: Subscription): void {
        const registerInteractiveHandlers = (
            targetSessionId: string,
            includeElicitations = true,
        ): void => {
            this.client.onApprovalRequest(targetSessionId, {
                handleCommandExecution: async (params) => {
                    await subscription.waitForRootNotifications();
                    return await subscription.approvalHandler.handleCommandExecution(
                        this.rootPermissionParams(subscription, targetSessionId, params),
                    );
                },
                handleFileChange: async (params) => {
                    await subscription.waitForRootNotifications();
                    return await subscription.approvalHandler.handleFileChange(
                        this.rootPermissionParams(subscription, targetSessionId, params),
                    );
                },
                handlePermissionsRequest: async (params) => {
                    await subscription.waitForRootNotifications();
                    return await subscription.approvalHandler.handlePermissionsRequest(
                        this.rootPermissionParams(subscription, targetSessionId, params),
                    );
                },
            });
            if (!includeElicitations) return;
            this.client.onElicitationRequest(targetSessionId, {
                handleElicitation: async (params) => {
                    await subscription.waitForRootNotifications();
                    return await subscription.elicitationHandler.handleElicitation(params);
                },
                handleUserInput: async (params) => {
                    await subscription.waitForRootNotifications();
                    return await subscription.elicitationHandler.handleUserInput(params);
                },
            });
        };

        const discover = (event: ServerNotification): void => {
            if ((event.method !== "item/started" && event.method !== "item/completed")
                || event.params.item.type !== "collabAgentToolCall"
                || event.params.item.tool !== "spawnAgent") {
                return;
            }
            const children = this.childrenByRoot.get(subscription.rootSessionId) ?? new Set<string>();
            this.childrenByRoot.set(subscription.rootSessionId, children);
            for (const childSessionId of event.params.item.receiverThreadIds) {
                if (childSessionId.trim() === "") continue;
                if (childSessionId === subscription.rootSessionId
                    || childSessionId === event.params.threadId
                    || children.has(childSessionId)) {
                    continue;
                }
                children.add(childSessionId);
                this.client.onServerNotification(childSessionId, (childEvent) => {
                    const eventThreadId = (childEvent.params as {threadId?: unknown}).threadId;
                    if (eventThreadId !== childSessionId) return;
                    discover(childEvent);
                    if (subscription.supportsSubagents) subscription.dispatch(childEvent);
                });
                // Hidden children keep only root-attributed permission requests.
                registerInteractiveHandlers(childSessionId, subscription.supportsSubagents);
            }
        };

        this.client.onServerNotification(subscription.rootSessionId, (event) => {
            // Register synchronously: app-server may emit child output directly
            // after the spawning collaboration item.
            discover(event);
            subscription.dispatch(event);
        });
        registerInteractiveHandlers(subscription.rootSessionId);
    }

    clear(rootSessionId: string): void {
        for (const childSessionId of this.childrenByRoot.get(rootSessionId) ?? []) {
            this.client.clearThreadHandlers(childSessionId);
        }
        this.childrenByRoot.delete(rootSessionId);
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

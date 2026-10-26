import type * as acpV2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {logger} from "./Logger";

type Activity = "idle" | "running" | "requires_action" | "unknown";

/** Session state and its wire order are independent of prompt acceptance and individual requests. */
export class AcpV2ForegroundState {
    private activity: Activity;
    private readonly items = new Set<string>();
    private readonly actions = new Map<symbol, string | undefined>();
    private sending: Promise<void> = Promise.resolve();

    constructor(
        private readonly notify: (state: acpV2.StateUpdate) => Promise<void>,
        running: boolean | "unknown" = false,
    ) {
        this.activity = running === "unknown" ? "unknown" : running ? "running" : "idle";
    }

    async update(state: acpV2.StateUpdate): Promise<void> {
        if (state.state === "idle" || state.state === "unknown") {
            this.items.clear();
            this.actions.clear();
            if (this.activity === state.state) return this.sending;
            this.activity = state.state;
        } else if (state.state === "running" || state.state === "requires_action") {
            if (this.activity === state.state) return this.sending;
            this.activity = state.state;
        }
        await this.publish(state);
    }

    /** A newly accepted runtime turn or local command is evidence of foreground work. */
    async start(): Promise<void> {
        if (this.activity === "idle" || this.actions.size === 0) await this.update({state: "running"});
    }

    /** Snapshots never repeat completion usage or failure metadata. */
    snapshot(): Promise<void> {
        switch (this.activity) {
            case "idle":
                return this.publish({state: "idle"});
            case "running":
                return this.publish({state: "running"});
            case "requires_action":
                return this.publish({state: "requires_action"});
            case "unknown":
                return this.publish({state: "unknown"});
        }
    }

    async startItem(itemId: string): Promise<void> {
        if (this.activity === "idle") return;
        this.items.add(itemId);
        await this.reportActionState();
    }

    async completeItem(itemId: string): Promise<void> {
        this.items.delete(itemId);
        if (this.activity !== "idle" && this.actions.size > 0) await this.reportActionState();
    }

    async withUserAction<T>(itemId: string | undefined, request: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        if (signal?.aborted) return request();
        const action = Symbol();
        this.actions.set(action, itemId);
        // The caller only registers actions that belong to active foreground work.
        if (this.activity === "idle") this.activity = "running";
        try {
            await this.reportActionStateSafely();
            return await request();
        } finally {
            // An idle boundary invalidates old waits, even if a new turn has already started.
            if (this.actions.delete(action) && !signal?.aborted) await this.reportActionStateSafely();
        }
    }

    dispose(): void {
        this.activity = "idle";
        this.items.clear();
        this.actions.clear();
    }

    invalidate(): void {
        this.activity = "unknown";
        this.items.clear();
        this.actions.clear();
    }

    private reportActionState(): Promise<void> {
        const blockedItems = new Set(this.actions.values());
        const runnable = [...this.items].some(itemId => !blockedItems.has(itemId));
        if (runnable) return this.update({state: "running"});
        if (this.actions.size > 0) return this.update({state: "requires_action"});
        // An answer alone does not establish that foreground progress has resumed.
        return this.sending;
    }

    private async reportActionStateSafely(): Promise<void> {
        try {
            await this.reportActionState();
        } catch (error) {
            logger.error("Failed to report foreground user-action state", error);
        }
    }

    private publish(state: acpV2.StateUpdate): Promise<void> {
        return this.serializePublication(() => this.notify(state));
    }

    serializePublication(publish: () => Promise<void>): Promise<void> {
        const sent = this.sending.then(publish);
        this.sending = sent.catch(() => {});
        return sent;
    }
}

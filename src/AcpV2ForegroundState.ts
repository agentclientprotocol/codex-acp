import type * as acpV2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {logger} from "./Logger";

type Activity = "idle" | "running" | "requires_action" | "unknown";

/** Session state and its wire order are independent of prompt acceptance and individual requests. */
export class AcpV2ForegroundState {
    private activity: Activity;
    private readonly items = new Set<string>();
    private readonly actions = new Map<AbortController, string | undefined>();
    private sending: Promise<void> = Promise.resolve();
    private disposed = false;

    constructor(
        private readonly notify: (state: acpV2.StateUpdate) => Promise<void>,
        running: boolean | "unknown" = false,
        private readonly background?: () => acpV2.BackgroundWork[] | null,
    ) {
        this.activity = running === "unknown" ? "unknown" : running ? "running" : "idle";
    }

    get isIdle(): boolean { return this.activity === "idle"; }

    /** Current state, without replaying a prior stop reason or turn usage. */
    current(): acpV2.StateUpdate {
        return this.withBackground(this.snapshotState());
    }

    private snapshotState(): acpV2.StateUpdate {
        switch (this.activity) {
            case "idle": return {state: "idle"};
            case "running": return {state: "running"};
            case "requires_action": return {state: "requires_action"};
            case "unknown": return {state: "unknown"};
        }
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
    snapshot(skipIdle = false): Promise<void> {
        if (skipIdle && this.isIdle && !this.background?.()?.length) return this.sending;
        return this.publish(this.snapshotState());
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

    async withUserAction<T>(itemId: string | undefined, request: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
        if (signal?.aborted) return request(signal);
        const action = new AbortController();
        const lifetime = signal ? AbortSignal.any([signal, action.signal]) : action.signal;
        this.actions.set(action, itemId);
        // The caller only registers actions that belong to active foreground work.
        if (this.activity === "idle") this.activity = "running";
        try {
            await this.reportActionStateSafely();
            return await request(lifetime);
        } finally {
            // An idle boundary invalidates old waits, even if a new turn has already started.
            if (this.actions.delete(action) && !lifetime.aborted) await this.reportActionStateSafely();
        }
    }

    cancelActions(): void {
        for (const action of this.actions.keys()) action.abort();
    }

    /** A fresh observation can replace unknown without overwriting a live requires_action snapshot. */
    restore(running: boolean | "unknown"): void {
        if (running === "unknown") this.invalidate();
        else if (this.activity === "unknown") this.activity = running ? "running" : "idle";
    }

    dispose(): void {
        this.disposed = true;
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
        return this.serializePublication(() => this.notify(this.withBackground(state)));
    }

    private withBackground(state: acpV2.StateUpdate): acpV2.StateUpdate {
        return this.background === undefined ? state : {...state, background: this.background()};
    }

    serializePublication(publish: () => Promise<void>): Promise<void> {
        const sent = this.sending.then(() => this.disposed ? undefined : publish());
        this.sending = sent.catch(() => {});
        return sent;
    }
}

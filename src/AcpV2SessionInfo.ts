import type * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {isRecord} from "./permissions/json";

type Update = acp.SessionInfoUpdate & {sessionUpdate: "session_info_update"};
type NotificationMetadata = acp.UpdateSessionNotification["_meta"];
export type SessionMetadataPatch = (current: Readonly<Record<string, unknown>>) => Record<string, unknown> | null;
export type SessionInfoFields = Omit<acp.SessionInfoUpdate, "_meta">;

/** Owns current session metadata and orders live patches against resume resynchronization. */
export class AcpV2SessionInfo {
    private readonly metadata = new Map<string, unknown>();
    private tail = Promise.resolve();
    private disposed = false;

    constructor(
        private readonly send: (update: Update, notificationMetadata?: NotificationMetadata) => Promise<void>,
        initialMetadata: Record<string, unknown> | null = null,
    ) {
        this.applyMetadata(JSON.parse(JSON.stringify({_meta: initialMetadata}))._meta);
    }

    update(update: Update, notificationMetadata?: NotificationMetadata): Promise<void> {
        let copy: {update: Update; _meta?: NotificationMetadata};
        try { copy = JSON.parse(JSON.stringify({update, _meta: notificationMetadata})); }
        catch (error) { return Promise.reject(error); }
        return this.enqueue(async () => {
            this.applyMetadata(copy.update._meta);
            await this.publish(copy.update, copy._meta);
        });
    }

    patchMetadata(change: SessionMetadataPatch, fields: SessionInfoFields = {}): Promise<void> {
        const copy: SessionInfoFields = JSON.parse(JSON.stringify(fields));
        return this.enqueue(async () => {
            const current = JSON.parse(JSON.stringify(Object.fromEntries(this.metadata))) as Record<string, unknown>;
            const patch = change(current);
            if (patch === null) return;
            const update: Update = JSON.parse(JSON.stringify({...copy, sessionUpdate: "session_info_update", _meta: patch}));
            this.applyMetadata(update._meta);
            await this.publish(update);
        });
    }

    seedMetadata(metadata: Record<string, unknown>): Promise<void> {
        const copy: unknown = JSON.parse(JSON.stringify({_meta: metadata}))._meta;
        return this.enqueue(async () => { this.applyMetadata(copy); });
    }

    snapshot(title: string | null): Promise<void> {
        return this.enqueue(async () => {
            // The client may hold keys this connection has never seen.
            await this.publish({sessionUpdate: "session_info_update", title, _meta: null});
            if (this.metadata.size > 0) {
                await this.publish({sessionUpdate: "session_info_update", _meta: Object.fromEntries(this.metadata)});
            }
        });
    }

    dispose(): void {
        this.disposed = true;
        this.metadata.clear();
    }

    private applyMetadata(patch: unknown): void {
        if (patch === null) this.metadata.clear();
        else if (isRecord(patch)) for (const [key, value] of Object.entries(patch)) {
            if (value === null) this.metadata.delete(key);
            else this.metadata.set(key, value);
        }
    }

    private enqueue(operation: () => Promise<void>): Promise<void> {
        const next = this.tail.then(async () => {
            if (!this.disposed) await operation();
        });
        this.tail = next.catch(() => {});
        return next;
    }

    private publish(update: Update, notificationMetadata?: NotificationMetadata): Promise<void> {
        return this.disposed ? Promise.resolve() : this.send(update, notificationMetadata);
    }
}

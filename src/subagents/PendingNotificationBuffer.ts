import type {ServerNotification} from "../app-server";
import {logger} from "../Logger";

/** The notification field that carries appended text, per delta method. */
const DELTA_FIELDS: Partial<Record<ServerNotification["method"], string>> = {
    "item/agentMessage/delta": "delta",
    "item/plan/delta": "delta",
    "item/reasoning/summaryTextDelta": "delta",
    "item/reasoning/textDelta": "delta",
    "item/commandExecution/outputDelta": "delta",
    "item/fileChange/outputDelta": "delta",
};

/**
 * Holds the notifications of a subagent until the adapter can route them to its session.
 *
 * The buffer keeps every notification. Adjacent text deltas of the same item merge into one notification,
 * so a long stream does not grow the count. The buffer is bounded by bytes.
 * Only when that hard cap is hit does it drop a notification, and it logs the drop.
 */
export class PendingNotificationBuffer {
    static readonly MAX_BYTES = 32 * 1024 * 1024;

    private readonly notifications: ServerNotification[] = [];
    private bytes = 0;
    private dropped = 0;

    constructor(private readonly threadId: string, private readonly maxBytes = PendingNotificationBuffer.MAX_BYTES) {}

    push(notification: ServerNotification): void {
        const deltaField = DELTA_FIELDS[notification.method];
        const last = this.notifications.at(-1);
        if (deltaField !== undefined && last !== undefined && sameStream(last, notification, deltaField)) {
            const delta = String((notification.params as Record<string, unknown>)[deltaField] ?? "");
            if (!this.reserve(Buffer.byteLength(delta, "utf8"))) return;
            const params = last.params as Record<string, unknown>;
            (last as {params: Record<string, unknown>}).params = {...params, [deltaField]: `${params[deltaField]}${delta}`};
            return;
        }
        if (!this.reserve(Buffer.byteLength(JSON.stringify(notification), "utf8"))) return;
        // A copy, because a merge replaces the params of the stored notification.
        this.notifications.push({...notification});
    }

    take(): ServerNotification[] {
        this.bytes = 0;
        return this.notifications.splice(0);
    }

    get size(): number {
        return this.notifications.length;
    }

    private reserve(bytes: number): boolean {
        if (this.bytes + bytes <= this.maxBytes) {
            this.bytes += bytes;
            return true;
        }
        this.dropped += 1;
        if (this.dropped === 1) {
            logger.log(`Pending subagent ${this.threadId} exceeded the notification buffer of ${this.maxBytes} bytes; dropping updates`);
        }
        return false;
    }
}

function sameStream(previous: ServerNotification, next: ServerNotification, deltaField: string): boolean {
    if (previous.method !== next.method) return false;
    return JSON.stringify({...previous.params, [deltaField]: null})
        === JSON.stringify({...next.params, [deltaField]: null});
}

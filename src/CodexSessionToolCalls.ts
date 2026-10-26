import type {UpdateSessionEvent} from "./ACPSessionConnection";

/**
 * Tracks tool-call items that reported `item/started` but not yet `item/completed`, for the item
 * types with no outstanding-item tracker of their own (`contextCompaction` has
 * `CodexSessionCompactions`; `collabAgentToolCall`/`subAgentActivity` have
 * `CodexSubagentEventRouter`). Session-owned, not handler-owned, so an item started under one
 * event handler and cut off before a later handler (or none) sees its completion can still be
 * found and failed out.
 */
export class CodexSessionToolCalls {
    private readonly open = new Map<string, {hasTerminal: boolean; turnId?: string}>();

    start(itemId: string, hasTerminal: boolean, turnId?: string): void {
        this.open.set(itemId, {hasTerminal, ...(turnId !== undefined ? {turnId} : {})});
    }

    complete(itemId: string): void {
        this.open.delete(itemId);
    }

    /** Drops all tracked entries without emitting anything, e.g. when their turn ends. */
    clear(): void {
        this.open.clear();
    }

    /** Fails every still-open tool call and ends its terminal, if it had one. */
    finishOutstanding(turnId?: string): UpdateSessionEvent[] {
        const updates: UpdateSessionEvent[] = [];
        for (const [itemId, {hasTerminal, turnId: owner}] of this.open) {
            if (turnId !== undefined && owner !== undefined && owner !== turnId) continue;
            updates.push({
                sessionUpdate: "tool_call_update",
                toolCallId: itemId,
                status: "failed",
                ...(hasTerminal ? {
                    _meta: {
                        terminal_exit: {exit_code: null, signal: null, terminal_id: itemId},
                    },
                } : {}),
            });
            this.open.delete(itemId);
        }
        return updates;
    }
}

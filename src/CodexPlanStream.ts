import type {ACPSessionConnection, UpdateSessionEvent} from "./ACPSessionConnection";
import {withAirMeta} from "./AirExtension";
import {createAgentTextMessageChunk, createMessagePhaseMeta} from "./ContentChunks";
import {logger} from "./Logger";
import type {ClientCapabilities} from "./tool-calls/ClientCapabilities";

export const AIR_CONTENT_DELTA_KEY = "contentDelta";

/**
 * Streams the Markdown plan that Codex writes in plan mode.
 *
 * - With the AIR `planContentDelta` capability, the first report of a plan is a `plan_update` with the whole text.
 *   Later reports carry only the appended text in `_meta.jetbrains.air.contentDelta`.
 * - Another client with plan updates gets throttled `plan_update` snapshots.
 * - AIR without plan updates gets the plan as appended `agent_message_chunk` text.
 * - Another client without plan updates gets the whole plan as one `agent_message_chunk` when the plan completes.
 *
 * The completed plan item is authoritative. The stream sends only what the client does not have yet.
 */
export class CodexPlanStream {
    private static readonly UPDATE_INTERVAL_MS = 150;

    /** The text that Codex streamed for each plan item. */
    private readonly streamedText = new Map<string, string>();
    /** The text that the client has for each plan item. */
    private readonly reportedText = new Map<string, string>();
    private readonly pendingItemIds = new Set<string>();
    private timer: ReturnType<typeof setTimeout> | null = null;
    private chain: Promise<void> = Promise.resolve();
    private disposed = false;

    constructor(
        private readonly session: ACPSessionConnection,
        private readonly capabilities: ClientCapabilities,
    ) {}

    /** Returns the update to send now, or `null` when the update waits for the throttle. */
    delta(itemId: string, delta: string): UpdateSessionEvent | null {
        if (delta.length === 0) return null;
        const text = (this.streamedText.get(itemId) ?? "") + delta;
        this.streamedText.set(itemId, text);
        if (!this.capabilities.planUpdates) {
            // A client that is not AIR gets the whole plan once, when the plan item completes.
            if (!this.capabilities.airClient) return null;
            this.reportedText.set(itemId, text);
            return planMessageChunk(delta, itemId, true);
        }
        this.pendingItemIds.add(itemId);
        this.schedule();
        return null;
    }

    /** Returns the text of the completed plan, or `null` when it is empty. */
    async completed(itemId: string, itemText: string): Promise<{text: string; update: UpdateSessionEvent | null} | null> {
        const text = itemText.length > 0 ? itemText : this.streamedText.get(itemId) ?? "";
        this.pendingItemIds.delete(itemId);
        if (this.pendingItemIds.size === 0) this.cancelTimer();
        this.streamedText.delete(itemId);
        if (text.length === 0) return null;
        if (this.capabilities.planUpdates) {
            await this.enqueue(itemId, text);
            return {text, update: null};
        }
        return {text, update: this.remainingMessageText(itemId, text)};
    }

    async flush(): Promise<void> {
        this.cancelTimer();
        do {
            const itemIds = [...this.pendingItemIds];
            this.pendingItemIds.clear();
            await Promise.all(itemIds.map(itemId => {
                const text = this.streamedText.get(itemId) ?? "";
                return text.length > 0 ? this.enqueue(itemId, text) : Promise.resolve();
            }));
            await this.chain;
        } while (this.pendingItemIds.size > 0);
    }

    clearTurn(): void {
        this.cancelTimer();
        this.pendingItemIds.clear();
        this.streamedText.clear();
        this.reportedText.clear();
    }

    async dispose(): Promise<void> {
        if (this.disposed) return;
        await this.flush();
        this.disposed = true;
        this.clearTurn();
    }

    private remainingMessageText(itemId: string, text: string): UpdateSessionEvent | null {
        const reported = this.reportedText.get(itemId) ?? "";
        this.reportedText.delete(itemId);
        if (reported.length === 0) return planMessageChunk(text, itemId, this.capabilities.airClient);
        if (text.startsWith(reported)) {
            const rest = text.slice(reported.length);
            return rest.length > 0 ? planMessageChunk(rest, itemId, this.capabilities.airClient) : null;
        }
        // A message chunk cannot be replaced, so the streamed text stays.
        logger.log("The completed plan differs from the streamed plan text", {itemId});
        return null;
    }

    private schedule(): void {
        if (this.disposed || this.timer !== null) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.flush().catch(error => {
                logger.error("Failed to flush throttled plan updates", error);
            });
        }, CodexPlanStream.UPDATE_INTERVAL_MS);
    }

    private cancelTimer(): void {
        if (this.timer === null) return;
        clearTimeout(this.timer);
        this.timer = null;
    }

    private enqueue(itemId: string, text: string): Promise<void> {
        const send = async () => {
            const update = this.planUpdate(itemId, text);
            if (update === null) return;
            await this.session.update(update);
            this.reportedText.set(itemId, text);
        };
        const result = this.chain.then(send);
        this.chain = result.catch(() => {});
        return result;
    }

    private planUpdate(itemId: string, text: string): UpdateSessionEvent | null {
        const reported = this.reportedText.get(itemId);
        if (reported === text) return null;
        if (this.capabilities.air.planContentDelta && reported !== undefined && text.startsWith(reported)) {
            return {
                sessionUpdate: "plan_update",
                plan: {type: "markdown", planId: itemId, content: ""},
                _meta: withAirMeta(undefined, AIR_CONTENT_DELTA_KEY, text.slice(reported.length)),
            };
        }
        return {sessionUpdate: "plan_update", plan: {type: "markdown", planId: itemId, content: text}};
    }
}

function planMessageChunk(text: string, itemId: string, airClient: boolean): UpdateSessionEvent {
    return createAgentTextMessageChunk(text, itemId, createMessagePhaseMeta("final_answer", airClient));
}

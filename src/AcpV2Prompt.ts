import * as acp from "@agentclientprotocol/sdk";
import type * as acpV2 from "@agentclientprotocol/sdk/experimental/v2";
import type {ServerNotification} from "./app-server";

/**
 * Lets a prompt report when Codex records its user message. On v2 that moment, not the turn
 * start, is when the prompt counts as inserted.
 */
export type UserMessageInsertion = {
    /** Sent as `clientUserMessageId` on `turn/start`; Codex echoes it as `userMessage.clientId`. */
    clientUserMessageId: string;
    onInserted: () => Promise<void>;
    /**
     * Shows a synthetic prompt codex-acp starts itself (the plan-implementation follow-up turn,
     * a `/goal` continuation) as a live `user_message`, once its own minted `clientUserMessageId`
     * is echoed back. These turns run inside the original prompt's running…idle pair, so this
     * only emits the chunks: no response is resolved and no `state_update` is sent.
     */
    onSyntheticInserted: (clientUserMessageId: string, prompt: acp.ContentBlock[]) => Promise<void>;
    /**
     * Fired synchronously once, from the turn-start response, when Codex steers this prompt into
     * a turn that was already running and unowned (its `running` went out before this prompt
     * existed). Lets the caller skip sending a duplicate `running` and still close the turn with
     * one `idle` if the steered input never lands.
     */
    onTurnAdopted?: () => void;
    /**
     * Fired synchronously each time a turn starts (or restarts) for this prompt, with the turn's
     * ids. Lets a pending `$/cancel_request` interrupt the right turn before insertion.
     */
    onTurnStarted?: (turn: {threadId: string, turnId: string}) => void;
};

/**
 * Whether the notification is Codex recording the user message sent with `clientUserMessageId`.
 * Codex records the message only after pre-turn work (compaction, MCP startup, hooks), and a
 * blocking hook can skip it. Match on the id: steered or Codex-originated user messages share
 * the turn.
 */
export function isInsertedUserMessage(
    event: ServerNotification,
    threadId: string,
    clientUserMessageId: string,
): boolean {
    return (event.method === "item/started" || event.method === "item/completed")
        && event.params.threadId === threadId
        && event.params.item.type === "userMessage"
        && event.params.item.clientId === clientUserMessageId;
}

const V1_CONTENT_BLOCK_TYPES = new Set(["text", "image", "audio", "resource_link", "resource"]);

/**
 * v2 content blocks are the v1 ones plus reserved custom/future types, which codex-acp does not
 * handle and rejects.
 */
export function toV1PromptRequest(params: acpV2.PromptRequest): acp.PromptRequest {
    for (const block of params.prompt) {
        if (!V1_CONTENT_BLOCK_TYPES.has(block.type)) {
            throw acp.RequestError.invalidParams(undefined, `Unsupported content block type: ${block.type}`);
        }
    }
    return params as acp.PromptRequest;
}

/**
 * The `idle` state that ends a v2 turn carries what v1 answers the prompt with: the stop reason,
 * the token usage and the `_meta` (quota, and a typed session failure for clients that
 * negotiated it).
 */
export function toV2IdleState(response: acp.PromptResponse): acpV2.StateUpdate {
    return {
        state: "idle",
        stopReason: response.stopReason,
        ...(response.usage != null ? {usage: response.usage} : {}),
        ...(response._meta != null ? {_meta: response._meta} : {}),
    };
}

/**
 * The agent message that tells a v2 client why its prompt failed after it was inserted, when
 * there is no longer a request to answer with an error.
 */
export function postInsertionFailureText(error: unknown, commandName?: string): string {
    const message = error instanceof Error && error.message.length > 0 ? error.message : null;
    if (commandName !== undefined) {
        return message === null ? `The '/${commandName}' command failed.` : `The '/${commandName}' command failed: ${message}`;
    }
    return message ?? "The prompt failed.";
}

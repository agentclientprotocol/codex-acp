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

import * as acp from "@agentclientprotocol/sdk/unstable";
import type * as acpV2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type {ServerNotification} from "./app-server";
import {CODEX_PROCESS_EXITED_ERROR_CODE} from "./app-server-recovery/AppServerExit";
import {readableServiceErrorMessage} from "./ServiceErrorMessage";
import {ResponseError} from "vscode-jsonrpc";
import {createHash} from "node:crypto";

// Keep the derivation stable: changing it would make stored receipts look unused.
const KEYED_PROMPT_ID_PREFIX = "acp-prompt-v1:";

/** Codex stores this ID alongside the user message. Neither replay nor logs need the raw key. */
export function keyedPromptId(sessionId: string, key: acpV2.IdempotencyKey): string {
    return KEYED_PROMPT_ID_PREFIX + createHash("sha256").update(JSON.stringify([sessionId, key])).digest("hex");
}

export function isKeyedPromptId(id: string): boolean {
    return id.startsWith(KEYED_PROMPT_ID_PREFIX);
}

/** Lives for one active session, including re-resumes on the same connection. */
export class AcpV2PromptKeys {
    private readonly inserted = new Set<string>();
    private readonly pending = new Map<string, {
        controller: AbortController;
        response: Promise<acpV2.PromptResponse>;
    }>();
    private historyRead: Promise<void> | null = null;

    async hasRetainedMessage(messageId: string, read: () => Promise<Set<string>>): Promise<boolean> {
        this.historyRead ??= read().then(ids => {
            for (const id of ids) this.inserted.add(id);
        }, error => {
            // A failed read isn't evidence that the prompt was never inserted.
            this.historyRead = null;
            throw error;
        });
        await this.historyRead;
        return this.inserted.has(messageId);
    }

    submit(
        messageId: string,
        signal: AbortSignal | undefined,
        insert: (signal: AbortSignal) => Promise<acpV2.PromptResponse>,
    ): Promise<acpV2.PromptResponse> {
        if (this.inserted.has(messageId)) return Promise.resolve({messageId});
        let entry = this.pending.get(messageId);
        if (!entry) {
            const controller = new AbortController();
            if (signal?.aborted) controller.abort();
            const response = insert(controller.signal).then(result => {
                this.inserted.add(messageId);
                return result;
            }).finally(() => this.pending.delete(messageId));
            entry = {controller, response};
            this.pending.set(messageId, entry);
        }
        if (!signal) return entry.response;
        const {controller, response} = entry;
        if (signal.aborted) controller.abort();
        const withdraw = () => controller.abort();
        signal.addEventListener("abort", withdraw, {once: true});
        return response.finally(() => signal.removeEventListener("abort", withdraw));
    }
}

/**
 * Lets a prompt report when Codex records its user message. On v2 that moment, not the turn
 * start, is when the prompt counts as inserted.
 */
export type UserMessageInsertion = {
    /** Sent as `clientUserMessageId` on `turn/start`; Codex echoes it as `userMessage.clientId`. */
    clientUserMessageId: string;
    onInserted: () => Promise<void>;
    /**
     * An adopted turn was already running when Codex steered this input into it.
     * Withdrawing this prompt must not interrupt that turn.
     */
    onTurnStarted?: (turn: {threadId: string, turnId: string, adopted: boolean}) => void;
    /** Reports terminal work failure without changing the v1 prompt response or depending on AIR. */
    onFailure?: (error: acpV2.Error) => void;
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

/** The identity and cancellation of a native v2 prompt offered to a running turn. */
export interface V2SteeringPrompt {
    messageId: string;
    signal: AbortSignal;
}

const SUPPORTED_PROMPT_CONTENT_TYPES = new Set(["text", "image", "resource_link", "resource"]);

export function assertPromptContentSupported(params: {prompt: Array<{type: string}>}): void {
    for (const block of params.prompt) {
        if (!SUPPORTED_PROMPT_CONTENT_TYPES.has(block.type)) {
            throw acp.RequestError.invalidParams(undefined, `Unsupported content block type: ${block.type}`);
        }
    }
}

/**
 * v2 content blocks are the v1 ones plus reserved custom/future types, which codex-acp does not
 * handle and rejects.
 */
export function toV1PromptRequest(params: acpV2.PromptRequest): acp.PromptRequest {
    assertPromptContentSupported(params);
    const {idempotencyKey: _key, ...request} = params;
    return request as acp.PromptRequest;
}

/**
 * Carry v1 usage and metadata into v2, but report terminal failures through the standard error
 * stop reason. Cancellation takes precedence over errors raised while aborting work.
 */
export function toV2IdleState(response: acp.PromptResponse, failure?: acpV2.Error | null): acpV2.StateUpdate {
    const state = {
        state: "idle" as const,
        ...(response.usage != null ? {usage: response.usage} : {}),
        ...(response._meta != null ? {_meta: response._meta} : {}),
    };
    if (failure != null && response.stopReason !== "cancelled") return {...state, stopReason: "error", error: failure};
    switch (response.stopReason) {
        case "end_turn":
            return {...state, stopReason: "end_turn"};
        case "max_tokens":
            return {...state, stopReason: "max_tokens"};
        case "max_turn_requests":
            return {...state, stopReason: "max_turn_requests"};
        case "refusal":
            return {...state, stopReason: "refusal"};
        case "cancelled":
            return {...state, stopReason: "cancelled"};
    }
}

/** Opaque request data and process diagnostics are not user-facing failure details. */
export function toV2Failure(error: unknown): acpV2.Error {
    if (error instanceof acp.RequestError || error instanceof ResponseError) {
        if (error.code === CODEX_PROCESS_EXITED_ERROR_CODE) {
            return {code: error.code, message: "Connection to Codex was lost."};
        }
        return {code: error.code, message: readableServiceErrorMessage(error.message)};
    }
    return {code: -32603, message: "Codex encountered an internal error."};
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

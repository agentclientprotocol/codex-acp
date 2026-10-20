import {RequestError, type SystemPrompt} from "@agentclientprotocol/sdk/unstable";
import {airCustomInstructions} from "./AirExtension";

/** Instructions to resend when a thread is reopened, including after an app-server restart. */
export type SessionInstructions = {
    text?: string;
    airInstructions?: string;
    developerInstructions: string;
};

export function clientSystemPromptText(value: unknown): string | undefined {
    if (value == null) return undefined;
    if (typeof value !== "object" || Array.isArray(value)
        || !("mode" in value) || value.mode !== "append"
        || !("content" in value) || !Array.isArray(value.content)) {
        throw RequestError.invalidParams(undefined, "systemPrompt requires append mode and text content");
    }
    const blocks: string[] = [];
    for (const block of value.content) {
        if (block === null || typeof block !== "object" || block.type !== "text" || typeof block.text !== "string") {
            throw RequestError.invalidParams(undefined, "systemPrompt content must contain only text blocks");
        }
        blocks.push(block.text);
    }
    return blocks.join("\n\n");
}

/** The text-only subset has the same wire shape on both ACP versions. */
export function toV1SystemPrompt(value: unknown): SystemPrompt | null {
    const text = clientSystemPromptText(value);
    return text === undefined ? null : {mode: "append", content: [{type: "text", text}]};
}

export function changesSystemPrompt(
    request: {systemPrompt?: unknown; _meta?: unknown},
    previous: SessionInstructions | undefined,
): boolean {
    const text = clientSystemPromptText(request.systemPrompt);
    const air = airCustomInstructions(request._meta);
    return text !== undefined && (text !== previous?.text
        || (air !== undefined && air !== previous?.airInstructions));
}

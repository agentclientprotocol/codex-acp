import {RequestError} from "@agentclientprotocol/sdk";

export const SYSTEM_PROMPT_CAPABILITY = {version: 1, append: true, clear: true, maxBytes: 256 * 1024};

/** Session metadata is an opt-in append, never a replacement of Codex's base prompt. */
export function readSessionInstructionAppend(meta?: Record<string, unknown> | null): string | undefined {
    const prompt = meta?.["systemPrompt"];
    if (prompt === undefined) return undefined;
    if (prompt === null || typeof prompt !== "object" || Array.isArray(prompt)
        || Object.keys(prompt).some(key => key !== "append")
        || !("append" in prompt) || typeof prompt.append !== "string") {
        throw RequestError.invalidParams(undefined, "systemPrompt must contain only an append string");
    }
    if (Buffer.byteLength(prompt.append, "utf8") > SYSTEM_PROMPT_CAPABILITY.maxBytes) {
        throw RequestError.invalidParams(undefined, `systemPrompt.append exceeds ${SYSTEM_PROMPT_CAPABILITY.maxBytes} UTF-8 bytes`);
    }
    // Explicit empty append resets the per-session addition to configured rules.
    // Omitted metadata still preserves native history without an override.
    return prompt.append;
}

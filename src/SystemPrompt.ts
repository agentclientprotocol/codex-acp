import {RequestError} from "@agentclientprotocol/sdk";

export const SYSTEM_PROMPT_EXTENSION_VERSION = 1;
export const SYSTEM_PROMPT_APPEND_MAX_BYTES = 256 * 1024;

export type SystemPromptCapability = {
    version: typeof SYSTEM_PROMPT_EXTENSION_VERSION;
    append: true;
    maxBytes: typeof SYSTEM_PROMPT_APPEND_MAX_BYTES;
};

export const SYSTEM_PROMPT_CAPABILITY: SystemPromptCapability = {
    version: SYSTEM_PROMPT_EXTENSION_VERSION,
    append: true,
    maxBytes: SYSTEM_PROMPT_APPEND_MAX_BYTES,
};

/**
 * Reads the provider-neutral system-prompt extension used on ACP session
 * lifecycle requests. Codex receives the appended text as developer
 * instructions, leaving its base/system instructions unchanged.
 */
export function readSystemPromptAppend(
    meta?: Record<string, unknown> | null,
): string | undefined {
    const rawSystemPrompt = meta?.["systemPrompt"];
    if (rawSystemPrompt === undefined) {
        return undefined;
    }
    if (!isUnknownRecord(rawSystemPrompt)) {
        throw RequestError.invalidParams(
            undefined,
            "systemPrompt must be an object containing an append string",
        );
    }

    const unsupportedKeys = Object.keys(rawSystemPrompt).filter(key => key !== "append");
    if (unsupportedKeys.length > 0) {
        throw RequestError.invalidParams(
            undefined,
            `systemPrompt contains unsupported fields: ${unsupportedKeys.join(", ")}`,
        );
    }

    const append = rawSystemPrompt["append"];
    if (typeof append !== "string") {
        throw RequestError.invalidParams(undefined, "systemPrompt.append must be a string");
    }
    if (new TextEncoder().encode(append).byteLength > SYSTEM_PROMPT_APPEND_MAX_BYTES) {
        throw RequestError.invalidParams(
            undefined,
            `systemPrompt.append must not exceed ${SYSTEM_PROMPT_APPEND_MAX_BYTES} UTF-8 bytes`,
        );
    }
    if (append.trim().length === 0) {
        return undefined;
    }
    return append;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

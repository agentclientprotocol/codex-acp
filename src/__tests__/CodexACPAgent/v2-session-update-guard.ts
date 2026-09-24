import {expect} from 'vitest';
import * as acpV2 from '@agentclientprotocol/sdk/experimental/v2';

type Guard = (update: acpV2.SessionUpdate) => boolean;

const knownVariantGuards: Guard[] = Object.entries(acpV2.SessionUpdate)
    .filter(([name]) => name !== "isCustom")
    .map(([, guard]) => guard as Guard);

/** Private v1 tool call `_meta` keys for command output; v2 sends standard terminal updates instead. */
const privateTerminalMetaKeys = ["terminal_info", "terminal_output", "terminal_output_delta", "terminal_exit"];

function isBase64(data: unknown): boolean {
    return typeof data === "string" && data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(data);
}

const messageTags = new Set([
    "user_message_chunk", "user_message",
    "agent_message_chunk", "agent_message",
    "agent_thought_chunk", "agent_thought",
]);

/**
 * Why a `session/update` payload is not a valid ACP v2 update, or `null` if it is.
 *
 * Neither the SDK nor the TS types stop a v1-only tag (e.g. `tool_call`) or a custom unprefixed
 * tag from reaching a v2 client, so tests check the frames themselves: custom tags must start with
 * `_`, and standard ones must match their v2 schema. Terminal bytes must be base64, `cwd` absolute,
 * and v1's private terminal `_meta` keys must not reach the client.
 */
export function v2SessionUpdateViolation(update: acpV2.SessionUpdate): string | null {
    const tag: unknown = update.sessionUpdate;
    if (typeof tag !== "string") {
        return `sessionUpdate is not a string: ${JSON.stringify(update)}`;
    }
    if (acpV2.SessionUpdate.isCustom(update)) {
        return tag.startsWith("_") ? null : `unknown unprefixed sessionUpdate '${tag}'`;
    }
    if (!knownVariantGuards.some(guard => guard(update))) {
        return `'${tag}' does not match its v2 schema: ${JSON.stringify(update)}`;
    }
    if (messageTags.has(tag) && (update as {messageId?: unknown}).messageId === "") {
        return `'${tag}' has an empty messageId`;
    }
    if (tag === "tool_call_update") {
        const meta = (update as acpV2.ToolCallUpdate)._meta;
        const leaked = privateTerminalMetaKeys.filter(key => meta != null && key in meta);
        if (leaked.length > 0) {
            return `'${tag}' carries private terminal _meta keys: ${leaked.join(", ")}`;
        }
    }
    if (tag === "terminal_update") {
        const {cwd, output} = update as acpV2.TerminalUpdate;
        if (cwd != null && !cwd.startsWith("/")) {
            return `'${tag}' has a relative cwd: ${cwd}`;
        }
        if (output != null && !isBase64(output.data)) {
            return `'${tag}' output is not base64: ${output.data}`;
        }
    }
    if (tag === "terminal_output_chunk" && !isBase64((update as acpV2.TerminalOutputChunk).data)) {
        return `'${tag}' data is not base64: ${(update as acpV2.TerminalOutputChunk).data}`;
    }
    return null;
}

const violations: string[] = [];

/** Records a v2 `session/update` payload a test client received; see `expectConformingV2SessionUpdates`. */
export function checkV2SessionUpdate(update: acpV2.SessionUpdate): void {
    const violation = v2SessionUpdateViolation(update);
    if (violation) {
        violations.push(violation);
    }
}

/** Fails if any update recorded since the last call was not a valid v2 update. */
export function expectConformingV2SessionUpdates(): void {
    const found = violations.splice(0);
    expect(found).toEqual([]);
}

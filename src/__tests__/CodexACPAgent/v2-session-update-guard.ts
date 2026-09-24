import {expect} from 'vitest';
import * as acpV2 from '@agentclientprotocol/sdk/experimental/v2';

type Guard = (update: acpV2.SessionUpdate) => boolean;

const knownVariantGuards: Guard[] = Object.entries(acpV2.SessionUpdate)
    .filter(([name]) => name !== "isCustom")
    .map(([, guard]) => guard as Guard);

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
 * `_`, and standard ones must match their v2 schema.
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

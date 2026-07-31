type CodexMeta = {
    codex?: {
        livePeer?: {
            version?: unknown;
        };
        clientUserMessageId?: unknown;
    };
};

export const LIVE_PEER_CAPABILITIES = {
    version: 1,
    ambientEvents: true,
    interactions: true,
    userMessages: true,
    clientUserMessageIds: true,
    turnLifecycle: true,
} as const;

export function requestsLivePeer(meta: unknown): boolean {
    if (!isRecord(meta)) {
        return false;
    }
    return (meta as CodexMeta).codex?.livePeer?.version === LIVE_PEER_CAPABILITIES.version;
}

export function getClientUserMessageId(meta: unknown): string | null {
    if (!isRecord(meta)) {
        return null;
    }
    const clientUserMessageId = (meta as CodexMeta).codex?.clientUserMessageId;
    return typeof clientUserMessageId === "string" && clientUserMessageId.length > 0
        ? clientUserMessageId
        : null;
}

export function createClientUserMessageIdMeta(
    clientUserMessageId: string | null,
): Record<string, unknown> | undefined {
    return clientUserMessageId
        ? {codex: {clientUserMessageId}}
        : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

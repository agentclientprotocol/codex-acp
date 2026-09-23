export const CONTEXT_COMPACTION_META_VERSION = 1;

export type ContextCompactionTrigger = "manual" | "automatic";

/**
 * Facts of a synthetic ACP context-compaction tool call, in `_meta.jetbrains.air.contextCompaction`.
 * The standard toolCallId and status fields own lifecycle identity and phase;
 * this extension carries only compaction-specific facts.
 */
export interface ContextCompactionMetadata {
    version: typeof CONTEXT_COMPACTION_META_VERSION;
    trigger?: ContextCompactionTrigger;
    preTokens?: number;
    postTokens?: number;
    durationMs?: number;
    error?: string;
}

export function createContextCompactionMetadata(
    metadata: Omit<ContextCompactionMetadata, "version"> = {},
): ContextCompactionMetadata {
    return {
        version: CONTEXT_COMPACTION_META_VERSION,
        ...metadata,
    };
}

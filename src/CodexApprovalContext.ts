import type { ThreadItem } from "./app-server/v2";

export interface ApprovalContextStore {
    readonly fileChangesByItemId: Map<string, ThreadItem & { type: "fileChange" }>;
    readonly turnDiffsByTurnId: Map<string, string>;
}

export function createApprovalContextStore(): ApprovalContextStore {
    return {
        fileChangesByItemId: new Map(),
        turnDiffsByTurnId: new Map(),
    };
}

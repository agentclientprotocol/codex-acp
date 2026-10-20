import type {ClientCapabilities, CompactionUpdate} from "@agentclientprotocol/sdk";

type Update = CompactionUpdate & {sessionUpdate: "compaction_update"};
type TerminalStatus = "completed" | "failed" | "cancelled";
type Compaction = {
    sessionId: string;
    turnId: string;
    id: string;
    terminal: boolean;
    legacyOnly: boolean;
};

export function clientSupportsCompaction(capabilities: ClientCapabilities | null): boolean {
    return capabilities?.session?.compaction != null;
}

export function createCompactionUpdate(compactionId: string, status: "in_progress" | TerminalStatus, error?: string): Update {
    return {
        sessionUpdate: "compaction_update",
        compactionId,
        status,
        ...(status === "failed" && error !== undefined ? {error} : {}),
    };
}

/** Session-owned identity survives prompt handler replacement and late duplicate events. */
export class CodexSessionCompactions {
    private readonly items = new Map<string, Compaction>();
    private readonly latestByTurn = new Map<string, Compaction>();

    start(sessionId: string, turnId: string, itemId: string): Update | null {
        const key = JSON.stringify([sessionId, itemId]);
        if (this.items.has(key)) return null;
        const compaction = this.remember(sessionId, turnId, itemId);
        return createCompactionUpdate(compaction.id, "in_progress");
    }

    complete(sessionId: string, turnId: string, itemId: string): Update | null {
        const latest = this.latestByTurn.get(JSON.stringify([sessionId, turnId]));
        if (!this.items.has(JSON.stringify([sessionId, itemId])) && latest?.legacyOnly) {
            // Attaching mid-compaction can expose both completion surfaces with
            // no start. Preserve the ID already published by the legacy signal.
            this.items.delete(JSON.stringify([sessionId, latest.id]));
            this.items.set(JSON.stringify([sessionId, itemId]), latest);
            latest.legacyOnly = false;
        }
        const compaction = this.items.get(JSON.stringify([sessionId, itemId]))
            ?? this.remember(sessionId, turnId, itemId);
        return this.finish(compaction, "completed");
    }

    completeLegacy(sessionId: string, turnId: string): Update | null {
        // Older Codex versions expose only a turn-addressed completion. When both
        // surfaces arrive, they describe the same latest compaction in that turn.
        const compaction = this.latestByTurn.get(JSON.stringify([sessionId, turnId]))
            ?? this.remember(sessionId, turnId, `compaction:${turnId}`, true);
        return this.finish(compaction, "completed");
    }

    finishTurn(sessionId: string, turnId: string, status: "failed" | "cancelled", error?: string): Update[] {
        const updates: Update[] = [];
        for (const compaction of this.items.values()) {
            if (compaction.sessionId !== sessionId || compaction.turnId !== turnId) continue;
            const update = this.finish(compaction, status, error);
            if (update) updates.push(update);
        }
        return updates;
    }

    finishOutstanding(status: "failed" | "cancelled", sessionId?: string): {sessionId: string; update: Update}[] {
        const updates: {sessionId: string; update: Update}[] = [];
        for (const compaction of this.items.values()) {
            if (sessionId !== undefined && compaction.sessionId !== sessionId) continue;
            const update = this.finish(compaction, status);
            if (update) updates.push({sessionId: compaction.sessionId, update});
        }
        return updates;
    }

    private remember(sessionId: string, turnId: string, id: string, legacyOnly = false): Compaction {
        const compaction = {sessionId, turnId, id, terminal: false, legacyOnly};
        this.items.set(JSON.stringify([sessionId, id]), compaction);
        this.latestByTurn.set(JSON.stringify([sessionId, turnId]), compaction);
        return compaction;
    }

    private finish(compaction: Compaction, status: TerminalStatus, error?: string): Update | null {
        if (compaction.terminal) return null;
        compaction.terminal = true;
        return createCompactionUpdate(compaction.id, status, error);
    }
}

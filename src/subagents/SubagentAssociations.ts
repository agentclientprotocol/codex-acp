import {RequestError} from "@agentclientprotocol/sdk/unstable";

export type SubagentAssociation = {
    rootSessionId: string;
    parentSessionId: string;
    threadId: string;
    sessionId: string;
};

/** Connection-owned identities and restrictions survive handler replacement and idle work. */
export class SubagentAssociations {
    private readonly associations = new Map<string, SubagentAssociation>();
    private readonly childThreads = new Set<string>();
    private readonly interactionSequences = new Map<string, number>();

    sessionId(rootSessionId: string, threadId: string): string {
        return `${encodeURIComponent(rootSessionId)}:subagent:${encodeURIComponent(threadId)}`;
    }

    register(rootSessionId: string, parentSessionId: string, threadId: string): SubagentAssociation {
        const sessionId = this.sessionId(rootSessionId, threadId);
        if (threadId === rootSessionId || sessionId === parentSessionId) {
            throw RequestError.internalError(undefined, "A subagent cannot own itself");
        }
        if (parentSessionId !== rootSessionId
            && this.associations.get(parentSessionId)?.rootSessionId !== rootSessionId) {
            throw RequestError.internalError(undefined, "A subagent's immediate parent must be known first");
        }
        const previous = this.associations.get(sessionId);
        if (previous) {
            if (previous.parentSessionId !== parentSessionId) {
                throw RequestError.internalError(undefined, "A subagent association cannot change parents");
            }
            return previous;
        }
        const association = {rootSessionId, parentSessionId, threadId, sessionId};
        this.associations.set(sessionId, association);
        this.childThreads.add(threadId);
        return association;
    }

    isRestricted(sessionId: string): boolean {
        return this.associations.has(sessionId) || this.childThreads.has(sessionId);
    }

    nextToolCallId(sessionId: string, serverName: string): string {
        const sequence = (this.interactionSequences.get(sessionId) ?? 0) + 1;
        this.interactionSequences.set(sessionId, sequence);
        return `${sessionId}:elicitation:${encodeURIComponent(serverName)}:${sequence}`;
    }

    get(sessionId: string): SubagentAssociation | undefined { return this.associations.get(sessionId); }
    forRoot(rootSessionId: string): SubagentAssociation[] {
        return [...this.associations.values()].filter(child => child.rootSessionId === rootSessionId);
    }
}

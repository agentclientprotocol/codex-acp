import type {CodexSubagentEventRouter} from "./CodexSubagentEventRouter";

/** Shared event/reporting surface; AIR and standard sessions have separate identity and lifecycle rules. */
export type SubagentEventRouter = Pick<CodexSubagentEventRouter, keyof CodexSubagentEventRouter> & {
    withUserAction?<T>(sessionId: string, itemId: string | undefined, request: () => Promise<T>, turnId?: string | null): Promise<T>;
};

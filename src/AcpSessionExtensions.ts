import type {SessionNotification} from "@agentclientprotocol/sdk";
import type {AsyncTaskUpdate} from "./async-tasks/AcpAsyncTasks";
import type {SubagentSpawnedUpdate, SubagentStateUpdate} from "./subagents/AcpSubagents";

/** Session updates that are not available in the published ACP SDK yet. */
export type AcpSessionUpdate =
    | SessionNotification["update"]
    | SubagentSpawnedUpdate
    | SubagentStateUpdate
    | AsyncTaskUpdate;

type AcpSessionNotification = Omit<SessionNotification, "update"> & {
    update: AcpSessionUpdate;
};

/** The only cast needed until the ACP SDK publishes the extension updates. */
export function asSdkSessionNotification(
    notification: AcpSessionNotification,
): SessionNotification {
    return notification as SessionNotification;
}

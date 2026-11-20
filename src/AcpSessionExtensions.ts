import type {SessionNotification} from "@agentclientprotocol/sdk/unstable";
import type {AsyncTaskUpdate} from "./async-tasks/AcpAsyncTasks";
import type {StandardSubagentUpdate, SubagentSpawnedUpdate, SubagentStateUpdate} from "./subagents/AcpSubagents";

/** Updates the adapter emits, including its existing AIR subagent contract. */
export type AcpSessionUpdate =
    | Exclude<SessionNotification["update"], {sessionUpdate: "subagent_update"}>
    | SubagentSpawnedUpdate
    | SubagentStateUpdate
    | StandardSubagentUpdate
    | AsyncTaskUpdate;

export type AcpSessionNotification = Omit<SessionNotification, "update"> & {
    update: AcpSessionUpdate;
};

/** The only cast needed for AIR's private updates, which the ACP SDK does not type. */
export function asSdkSessionNotification(
    notification: AcpSessionNotification,
): SessionNotification {
    return notification as SessionNotification;
}

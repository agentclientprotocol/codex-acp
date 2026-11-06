import type {SessionNotification} from "@agentclientprotocol/sdk/unstable";
import type {AsyncTaskUpdate} from "./async-tasks/AcpAsyncTasks";
import type {StandardSubagentUpdate, SubagentSpawnedUpdate, SubagentStateUpdate} from "./subagents/AcpSubagents";

/** Updates the adapter emits, including its existing AIR subagent contract. */
export type AcpSessionUpdate =
    | Exclude<SessionNotification["update"], {
        sessionUpdate: "subagent_update" | "session_message" | "session_message_chunk";
    }>
    | SubagentSpawnedUpdate
    | SubagentStateUpdate
    | StandardSubagentUpdate
    | AsyncTaskUpdate;

export type AcpSessionNotification = Omit<SessionNotification, "update"> & {
    update: AcpSessionUpdate;
};

/** The only cast needed until the ACP SDK publishes the extension updates. */
export function asSdkSessionNotification(
    notification: AcpSessionNotification,
): SessionNotification {
    return notification as SessionNotification;
}

import type {SessionId} from "@agentclientprotocol/sdk";

export const ASYNC_TASK_STOP_METHOD = "_session/async_task/stop";

export type AsyncTaskStopRequest = {
    sessionId: SessionId;
    asyncTaskId: string;
};

export type AsyncTaskStopResponse = {
    stopped: boolean;
};

export type AsyncTaskStopExtRequest = {
    method: typeof ASYNC_TASK_STOP_METHOD;
    params: AsyncTaskStopRequest;
};

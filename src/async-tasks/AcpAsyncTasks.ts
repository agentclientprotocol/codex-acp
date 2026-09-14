export type AsyncTaskState = "running" | "paused" | "completed" | "failed" | "stopped";

export type AsyncTaskSpawnedUpdate = {
    sessionUpdate: "async_task_spawned";
    asyncTaskId: string;
    name: string;
    taskType: string;
    description?: string;
    showInTranscript: boolean;
    canStop: boolean;
    outputFilePath?: string;
    toolCallId?: string;
    _meta?: Record<string, unknown> | null;
};

export type AsyncTaskProgressUpdate = {
    sessionUpdate: "async_task_progress";
    asyncTaskId: string;
    description?: string;
    summary?: string;
    lastToolName?: string;
    usage?: { totalTokens: number; toolUses: number; durationMs: number };
    outputFilePath?: string;
    toolCallId?: string;
    _meta?: Record<string, unknown> | null;
};

export type AsyncTaskStateUpdate = {
    sessionUpdate: "async_task_state_update";
    asyncTaskId: string;
    state: AsyncTaskState;
    summary?: string;
    outputFilePath?: string;
    toolCallId?: string;
    _meta?: Record<string, unknown> | null;
};

export type AsyncTaskUpdate =
    | AsyncTaskSpawnedUpdate
    | AsyncTaskProgressUpdate
    | AsyncTaskStateUpdate;

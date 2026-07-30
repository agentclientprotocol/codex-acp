import type { UpdateSessionEvent } from "./ACPSessionConnection";
import type { CollabAgentState, ThreadItem, Turn } from "./app-server/v2";

type CollabAgentToolCallItem = Extract<ThreadItem, { type: "collabAgentToolCall" }>;
type SubAgentActivityItem = Extract<ThreadItem, { type: "subAgentActivity" }>;
type AcpToolCallStatus = "in_progress" | "completed" | "failed";
type Activity = {
    agentThreadId: string;
    toolCallId: string;
    agentPath: string | null;
    status: AcpToolCallStatus;
};

const trackers = new WeakMap<object, SubAgentActivityTracker>();

export function getSubAgentActivityTracker(owner: object): SubAgentActivityTracker {
    const existing = trackers.get(owner);
    if (existing) {
        return existing;
    }
    const tracker = new SubAgentActivityTracker();
    trackers.set(owner, tracker);
    return tracker;
}

export class SubAgentActivityTracker {
    private readonly activities = new Map<string, Activity>();
    private readonly seenSubAgentItems = new Set<string>();
    private readonly childMessages = new Map<string, string>();

    recordChildMessage(agentThreadId: string, text: string): void {
        if (text.trim().length > 0) {
            this.childMessages.set(agentThreadId, text);
        }
    }

    // Complete the parent-visible activity when its child turn reaches a terminal state.
    completeChildTurn(agentThreadId: string, turn: Turn): UpdateSessionEvent[] {
        const activity = this.activities.get(agentThreadId);
        if (!activity || turn.status === "inProgress") {
            return [];
        }
        const status: AcpToolCallStatus = turn.status === "completed" ? "completed" : "failed";
        activity.status = status;
        const result = this.childMessages.get(agentThreadId) ?? null;
        this.childMessages.delete(agentThreadId);
        const error = turn.error?.message ?? null;
        const message = result ?? error;
        return [{
            sessionUpdate: "tool_call_update",
            toolCallId: activity.toolCallId,
            title: this.activityTitle(activity),
            status,
            ...(message ? {
                content: [{
                    type: "content",
                    content: { type: "text", text: message },
                }],
            } : {}),
            rawOutput: {
                agentThreadId,
                ...(activity.agentPath ? { agentPath: activity.agentPath } : {}),
                turnId: turn.id,
                turnStatus: turn.status,
                result,
                error: turn.error,
            },
            _meta: this.activityMeta(agentThreadId, activity.toolCallId),
        }];
    }

    // Map app-server subagent lifecycle items to one parent-visible ACP activity.
    mapSubAgentActivity(
        item: SubAgentActivityItem,
        lifecycle: "started" | "completed",
    ): UpdateSessionEvent[] {
        if (lifecycle === "completed" && this.seenSubAgentItems.delete(item.id)) {
            return [];
        }
        if (lifecycle === "started") {
            this.seenSubAgentItems.add(item.id);
        }

        const existing = this.activities.get(item.agentThreadId);
        switch (item.kind) {
            case "started": {
                if (existing && existing.status === "in_progress") {
                    existing.agentPath = item.agentPath;
                    return [this.createActivityUpdate(existing, {
                        activity: item.kind,
                        agentPath: item.agentPath,
                    })];
                }
                return [this.createActivity(item.agentThreadId, item.id, item.agentPath, {
                    activity: item.kind,
                })];
            }
            case "interacted": {
                if (!existing || existing.status !== "in_progress") {
                    return [this.createActivity(item.agentThreadId, item.id, item.agentPath, {
                        activity: item.kind,
                    })];
                }
                existing.agentPath = item.agentPath;
                return [this.createActivityUpdate(existing, {
                    activity: item.kind,
                    agentPath: item.agentPath,
                })];
            }
            case "interrupted": {
                if (!existing || existing.status !== "in_progress") {
                    return [this.createActivity(item.agentThreadId, item.id, item.agentPath, {
                        activity: item.kind,
                    }, "failed")];
                }
                existing.status = "failed";
                return [this.createActivityUpdate(existing, {
                    activity: item.kind,
                    agentPath: item.agentPath,
                }, "failed")];
            }
        }
    }

    // Fold collaboration controls into the active run and start a new run on resume.
    mapCollabAgentToolCall(
        item: CollabAgentToolCallItem,
        lifecycle: "started" | "completed",
    ): UpdateSessionEvent[] {
        const targetThreadIds = this.targetThreadIds(item);

        switch (item.tool) {
            case "spawnAgent":
                return this.mapStartAction(item, targetThreadIds, lifecycle, "Start subagent");
            case "resumeAgent":
                return this.mapStartAction(item, targetThreadIds, lifecycle, "Resume subagent");
            case "sendInput":
            case "wait":
            case "closeAgent":
                if (lifecycle === "started") {
                    return [];
                }
                return targetThreadIds.flatMap((threadId) => this.updateForControlAction(item, threadId));
        }
    }

    private mapStartAction(
        item: CollabAgentToolCallItem,
        targetThreadIds: string[],
        lifecycle: "started" | "completed",
        failedTitle: string,
    ): UpdateSessionEvent[] {
        if (targetThreadIds.length === 0) {
            if (lifecycle === "completed" && item.status === "failed") {
                return [{
                    sessionUpdate: "tool_call",
                    toolCallId: item.id,
                    kind: "other",
                    title: failedTitle,
                    status: "failed",
                    rawInput: this.startRawInput(item),
                    rawOutput: this.actionRawOutput(item, null),
                    _meta: this.activityMeta(null, item.id),
                }];
            }
            return [];
        }

        return targetThreadIds.flatMap((threadId, index) => {
            const current = this.activities.get(threadId);
            const needsNewRun = !current || current.status !== "in_progress";
            if (needsNewRun) {
                const toolCallId = targetThreadIds.length === 1 ? item.id : `${item.id}:${index}`;
                const state = item.agentsStates[threadId] ?? null;
                const status = this.startActionStatus(item, state);
                return [this.createActivity(
                    threadId,
                    toolCallId,
                    current?.agentPath ?? null,
                    this.actionRawOutput(item, state),
                    status,
                    item,
                )];
            }

            if (lifecycle === "started") {
                return [];
            }
            const state = item.agentsStates[threadId] ?? null;
            const status = this.stateStatus(state) ?? current.status;
            current.status = status;
            return [this.createActivityUpdate(current, this.actionRawOutput(item, state), status)];
        });
    }

    private updateForControlAction(
        item: CollabAgentToolCallItem,
        threadId: string,
    ): UpdateSessionEvent[] {
        const state = item.agentsStates[threadId] ?? null;
        let activity = this.activities.get(threadId);
        if (!activity) {
            const status = this.stateStatus(state) ?? "in_progress";
            const toolCallId = `${item.id}:${encodeURIComponent(threadId)}`;
            return [this.createActivity(threadId, toolCallId, null, this.actionRawOutput(item, state), status)];
        }

        let status = this.stateStatus(state) ?? activity.status;
        if (item.tool === "closeAgent" && item.status === "completed" && status === "in_progress") {
            status = "completed";
        }
        activity.status = status;
        return [this.createActivityUpdate(activity, this.actionRawOutput(item, state), status, item.prompt)];
    }

    private createActivity(
        agentThreadId: string,
        toolCallId: string,
        agentPath: string | null,
        rawOutput: Record<string, unknown>,
        status: AcpToolCallStatus = "in_progress",
        startItem?: CollabAgentToolCallItem,
    ): UpdateSessionEvent {
        const activity: Activity = { agentThreadId, toolCallId, agentPath, status };
        const rawInput = this.activityRawInput(activity, startItem);
        this.activities.set(agentThreadId, activity);
        return {
            sessionUpdate: "tool_call",
            toolCallId,
            kind: "other",
            title: this.activityTitle(activity),
            status,
            ...(rawInput ? { rawInput } : {}),
            rawOutput: {
                agentThreadId,
                ...(agentPath ? { agentPath } : {}),
                ...rawOutput,
            },
            _meta: this.activityMeta(agentThreadId, toolCallId),
        };
    }

    private createActivityUpdate(
        activity: Activity,
        rawOutput: Record<string, unknown>,
        status: AcpToolCallStatus = activity.status,
        prompt: string | null = null,
    ): UpdateSessionEvent {
        const message = this.activityMessage(rawOutput, prompt);
        return {
            sessionUpdate: "tool_call_update",
            toolCallId: activity.toolCallId,
            title: this.activityTitle(activity),
            status,
            ...(message ? {
                content: [{
                    type: "content",
                    content: { type: "text", text: message },
                }],
            } : {}),
            rawOutput: {
                agentThreadId: activity.agentThreadId,
                ...(activity.agentPath ? { agentPath: activity.agentPath } : {}),
                ...rawOutput,
            },
            _meta: this.activityMeta(activity.agentThreadId, activity.toolCallId),
        };
    }

    private startRawInput(item: CollabAgentToolCallItem): Record<string, unknown> {
        return {
            prompt: item.prompt,
            model: item.model,
            reasoningEffort: item.reasoningEffort,
        };
    }

    private actionRawOutput(
        item: CollabAgentToolCallItem,
        state: CollabAgentState | null,
    ): Record<string, unknown> {
        return {
            action: item.tool,
            actionStatus: item.status,
            senderThreadId: item.senderThreadId,
            receiverThreadIds: item.receiverThreadIds,
            prompt: item.prompt,
            agentState: state,
        };
    }

    private startActionStatus(
        item: CollabAgentToolCallItem,
        state: CollabAgentState | null,
    ): AcpToolCallStatus {
        if (item.status === "failed") {
            return "failed";
        }
        return this.stateStatus(state) ?? "in_progress";
    }

    private stateStatus(state: CollabAgentState | null): AcpToolCallStatus | null {
        switch (state?.status) {
            case "pendingInit":
            case "running":
                return "in_progress";
            case "completed":
            case "shutdown":
                return "completed";
            case "interrupted":
            case "errored":
            case "notFound":
                return "failed";
            case undefined:
                return null;
        }
    }

    private targetThreadIds(item: CollabAgentToolCallItem): string[] {
        return Array.from(new Set([
            ...item.receiverThreadIds,
            ...Object.keys(item.agentsStates),
        ]));
    }

    private activityTitle(activity: Activity): string {
        return this.activityDescription(activity) ?? "Agent activity";
    }

    private activityDescription(activity: Activity): string | null {
        // Use the canonical task name as the client-facing description.
        const segments = activity.agentPath?.split("/").filter(Boolean);
        const taskName = segments?.[segments.length - 1];
        if (!taskName || taskName === "root") {
            return null;
        }
        const readableTaskName = taskName.replace(/_+/g, " ").trim();
        if (!readableTaskName) {
            return null;
        }
        return `${readableTaskName.charAt(0).toUpperCase()}${readableTaskName.slice(1)}`;
    }

    private activityRawInput(
        activity: Activity,
        startItem?: CollabAgentToolCallItem,
    ): Record<string, unknown> | null {
        const description = this.activityDescription(activity);
        if (!description && !startItem) {
            return null;
        }
        return {
            ...(description ? { description } : {}),
            ...(startItem ? this.startRawInput(startItem) : {}),
        };
    }

    private activityMeta(agentThreadId: string | null, runId: string): Record<string, unknown> {
        return {
            codex: {
                toolName: "Agent",
                subAgent: {
                    agentThreadId,
                    runId,
                },
            },
        };
    }

    private activityMessage(rawOutput: Record<string, unknown>, prompt: string | null): string | null {
        const state = rawOutput["agentState"];
        if (state && typeof state === "object" && "message" in state && typeof state.message === "string") {
            return state.message;
        }
        if (rawOutput["actionStatus"] === "failed") {
            return `Subagent ${String(rawOutput["action"])} failed.`;
        }
        if (prompt) {
            return `Sent follow-up to subagent: ${prompt}`;
        }
        return null;
    }
}

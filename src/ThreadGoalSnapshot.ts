import {GOAL_CONTROL_METHOD} from "./AcpExtensions";
import type {ThreadGoal} from "./app-server/v2";

export interface ThreadGoalSnapshot {
    objective: string;
    status: ThreadGoal["status"];
    tokenBudget: number | null;
    timeUsedSeconds: number;
    createdAt: number;
    controlMethod: typeof GOAL_CONTROL_METHOD;
}

export function toThreadGoalSnapshot(goal: ThreadGoal): ThreadGoalSnapshot {
    return {
        objective: goal.objective.trim(),
        status: goal.status,
        tokenBudget: goal.tokenBudget,
        timeUsedSeconds: goal.timeUsedSeconds,
        createdAt: goal.createdAt,
        controlMethod: GOAL_CONTROL_METHOD,
    };
}

export function sameThreadGoalSnapshot(
    left: ThreadGoalSnapshot | null | undefined,
    right: ThreadGoalSnapshot | null,
): boolean {
    if (left === undefined) return false;
    if (left === null || right === null) return left === right;
    return left.objective === right.objective
        && left.status === right.status
        && left.tokenBudget === right.tokenBudget
        && left.createdAt === right.createdAt;
}

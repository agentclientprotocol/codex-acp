import type {ThreadGoal, TurnCompletedNotification} from "./app-server/v2";

/** Correlates the app-server turns that belong to one long-running ACP goal prompt. */
export class GoalRunLifecycle {
    private goalActive = false;
    private goalTerminal = false;
    private currentTurnId: string | null = null;
    private lastCompletedTurn: TurnCompletedNotification | null = null;
    private readonly routedTurnIds = new Set<string>();
    private readonly completedTurnIds = new Set<string>();

    private initialTurnResolved = false;
    private resolveInitialTurn: (turnId: string | null) => void = () => {};
    private readonly initialTurn = new Promise<string | null>((resolve) => {
        this.resolveInitialTurn = resolve;
    });

    private resolveCompletion: (event: TurnCompletedNotification) => void = () => {};
    private readonly completion = new Promise<TurnCompletedNotification>((resolve) => {
        this.resolveCompletion = resolve;
    });

    setGoalStatus(status: ThreadGoal["status"]): void {
        if (status === "active" && !this.goalTerminal) {
            this.goalActive = true;
            return;
        }
        this.goalActive = false;
        this.goalTerminal = true;
        this.resolveInitial(null);
        this.maybeResolveCompletion();
    }

    clearGoal(): void {
        this.goalActive = false;
        this.goalTerminal = true;
        this.resolveInitial(null);
        this.maybeResolveCompletion();
    }

    routeTurn(turnId: string): boolean {
        if (this.routedTurnIds.has(turnId) || this.completedTurnIds.has(turnId)) {
            return false;
        }
        this.routedTurnIds.add(turnId);
        this.currentTurnId = turnId;
        this.resolveInitial(turnId);
        return true;
    }

    completeTurn(event: TurnCompletedNotification): void {
        this.completedTurnIds.add(event.turn.id);
        if (!this.routedTurnIds.has(event.turn.id)) {
            return;
        }
        if (this.currentTurnId === event.turn.id) {
            this.currentTurnId = null;
        }
        this.lastCompletedTurn = event;
        if (event.turn.status === "interrupted") {
            this.resolveCompletion(event);
            return;
        }
        this.maybeResolveCompletion();
    }

    get activeTurnId(): string | null {
        return this.currentTurnId;
    }

    waitForInitialTurn(): Promise<string | null> {
        return this.initialTurn;
    }

    waitForCompletion(): Promise<TurnCompletedNotification> {
        return this.completion;
    }

    private resolveInitial(turnId: string | null): void {
        if (this.initialTurnResolved) {
            return;
        }
        this.initialTurnResolved = true;
        this.resolveInitialTurn(turnId);
    }

    private maybeResolveCompletion(): void {
        if (!this.goalActive && this.currentTurnId === null && this.lastCompletedTurn !== null) {
            this.resolveCompletion(this.lastCompletedTurn);
        }
    }
}

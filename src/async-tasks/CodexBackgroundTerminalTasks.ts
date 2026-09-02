import type {ThreadItem} from "../app-server/v2";
import type {ACPSessionConnection} from "../ACPSessionConnection";
import type {CodexAppServerClient} from "../CodexAppServerClient";
import type {ThreadBackgroundTerminal} from "./BackgroundTerminalApi";

type CommandExecutionItem = Extract<ThreadItem, {type: "commandExecution"}>;
type TerminalState = "completed" | "failed" | "stopped";

type Task = {
    processId: string;
    itemId: string;
    command: string;
    announced: boolean;
    state: "running" | "stopping" | TerminalState;
};

/** Maps Codex-owned background terminals to the AIR async task extension. */
export class CodexBackgroundTerminalTasks {
    private readonly tasksById = new Map<string, Task>();
    private disposed = false;

    constructor(
        readonly enabled: boolean,
        private readonly threadId: string,
        private readonly appServer: CodexAppServerClient,
        private readonly session: ACPSessionConnection,
    ) {}

    observeCommandStarted(item: CommandExecutionItem): void {
        if (!this.isActive() || item.processId === null) return;
        this.remember({
            itemId: item.id,
            processId: item.processId,
            command: item.command,
        });
    }

    async observeCommandCompleted(item: CommandExecutionItem): Promise<void> {
        if (!this.isActive()) return;
        await this.finish(item.id, item.status === "completed" ? "completed" : "failed");
    }

    async sync(): Promise<void> {
        if (!this.isActive()) return;
        for (const terminal of await this.listAll()) {
            if (!this.isActive()) return;
            const task = this.remember(terminal);
            if (!task.announced && task.state === "running") {
                task.announced = true;
                try {
                    await this.session.update({
                        sessionUpdate: "async_task_spawned",
                        asyncTaskId: task.itemId,
                        name: task.command,
                        taskType: "shell",
                        description: task.command,
                        showInTranscript: false,
                        canStop: true,
                        toolCallId: task.itemId,
                    });
                } catch (error) {
                    task.announced = false;
                    throw error;
                }
            }
        }
    }

    async stop(taskId: string): Promise<boolean> {
        if (!this.isActive()) return false;
        const task = this.tasksById.get(taskId);
        if (!task || task.state !== "running") return false;
        task.state = "stopping";
        try {
            const response = await this.appServer.threadBackgroundTerminalsTerminate({
                threadId: this.threadId,
                processId: task.processId,
            });
            if (!response.terminated) {
                if (task.state === "stopping") task.state = "running";
                return false;
            }
            await this.finish(taskId, "stopped");
            return true;
        } catch (error) {
            if (task.state === "stopping") task.state = "running";
            throw error;
        }
    }

    clear(): void {
        this.disposed = true;
        this.tasksById.clear();
    }

    private remember(terminal: Pick<ThreadBackgroundTerminal, "itemId" | "processId" | "command">): Task {
        const existing = this.tasksById.get(terminal.itemId);
        if (existing) {
            existing.processId = terminal.processId;
            return existing;
        }
        const task: Task = {
            processId: terminal.processId,
            itemId: terminal.itemId,
            command: terminal.command,
            announced: false,
            state: "running",
        };
        this.tasksById.set(task.itemId, task);
        return task;
    }

    private async finish(taskId: string, state: TerminalState): Promise<void> {
        const task = this.tasksById.get(taskId);
        if (!task || (task.state !== "running" && task.state !== "stopping")) return;
        task.state = state;
        if (task.announced) {
            await this.session.update({
                sessionUpdate: "async_task_state_update",
                asyncTaskId: task.itemId,
                state,
                toolCallId: task.itemId,
            });
        }
    }

    private async listAll(): Promise<ThreadBackgroundTerminal[]> {
        const terminals: ThreadBackgroundTerminal[] = [];
        const seenCursors = new Set<string>();
        let cursor: string | null = null;
        do {
            const response = await this.appServer.threadBackgroundTerminalsList({
                threadId: this.threadId,
                cursor,
                limit: 64,
            });
            terminals.push(...response.data);
            cursor = response.nextCursor;
            if (cursor !== null && !seenCursors.add(cursor)) {
                throw new Error("Codex returned a repeated background terminal cursor");
            }
        } while (cursor !== null);
        return terminals;
    }

    private isActive(): boolean {
        return this.enabled && !this.disposed;
    }
}

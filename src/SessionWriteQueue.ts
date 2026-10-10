/**
 * Runs the writes of each session one after another, each through its completion: the automatic title of
 * `TitleGenerator`, and for a `sessionIndex` client `_session/rename`, `_session/archive`,
 * `_session/unarchive` and `session/delete`. Codex may apply two requests that are in flight together in
 * either order, so a write starts only after the previous one has finished.
 */
export class SessionWriteQueue {
    private readonly tails = new Map<string, Promise<void>>();

    run<T>(sessionId: string, write: () => Promise<T>): Promise<T> {
        const previous = this.tails.get(sessionId) ?? Promise.resolve();
        const run = previous.then(write);
        const settled = run.then(() => undefined, () => undefined);
        this.tails.set(sessionId, settled);
        void settled.then(() => {
            if (this.tails.get(sessionId) === settled) this.tails.delete(sessionId);
        });
        return run;
    }
}

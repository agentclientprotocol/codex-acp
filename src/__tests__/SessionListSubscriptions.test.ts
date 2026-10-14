import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import type {ServerNotification} from "../app-server";
import type {Thread, ThreadListParams, ThreadListResponse} from "../app-server/v2";
import type {CodexHomeWatcherListener} from "../CodexHomeWatcher";
import {activityStateOf, sessionIndexSessionInfo} from "../SessionIndex";
import {SESSION_NAME_LOG_FILE} from "../SessionNameLog";
import {
    MAX_SESSION_LIST_SUBSCRIPTIONS,
    SessionListSubscriptions,
    type SessionListChanges,
    type SessionListSubscriptionTimings,
} from "../SessionListSubscriptions";

const timings: SessionListSubscriptionTimings = {
    quietMs: 150,
    maxWaitMs: 1_000,
    ownChangeDelayMs: 20,
    minChangeIntervalMs: 1_000,
    fallbackIntervalMs: 30_000,
};

const HOME = "/codex-home";

function thread(id: string, overrides: Partial<Thread> = {}): Thread {
    return {
        id,
        sessionId: id,
        parentThreadId: null,
        threadSource: null,
        originator: null,
        forkedFromId: null,
        preview: `Prompt of ${id}`,
        ephemeral: false,
        modelProvider: "openai",
        model: "gpt-5",
        reasoningEffort: null,
        createdAt: 100,
        updatedAt: 1_000,
        recencyAt: 1_000,
        status: {type: "notLoaded"},
        path: `/codex-home/sessions/rollout-${id}.jsonl`,
        cwd: "/repo",
        cliVersion: "0.0.0",
        section: null,
        sectionEnteredAt: null,
        projectId: null,
        historyMode: "paginated",
        source: "vscode",
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        name: null,
        turns: [],
        ...overrides,
    };
}

/** An app-server with a thread table: `thread/list` sorts by `updatedAt`, newest first, and pages by offset. */
class FakeCodex {
    readonly threads = new Map<string, {thread: Thread, archived: boolean}>();
    readonly threadList = vi.fn(async (params: ThreadListParams): Promise<ThreadListResponse> => {
        const cwds = params.cwd === undefined || params.cwd === null ? null : [params.cwd].flat();
        const rows = [...this.threads.values()]
            .filter(entry => entry.archived === (params.archived ?? false))
            .filter(entry => cwds === null || cwds.includes(entry.thread.cwd))
            .map(entry => entry.thread)
            .sort((left, right) => right.updatedAt - left.updatedAt);
        const offset = params.cursor ? Number(params.cursor) : 0;
        const limit = params.limit ?? 25;
        const data = rows.slice(offset, offset + limit);
        return {data, nextCursor: offset + limit < rows.length ? String(offset + limit) : null, backwardsCursor: null};
    });
    readonly threadRead = vi.fn(async ({threadId}: {threadId: string}) => {
        const entry = this.threads.get(threadId);
        if (entry === undefined) throw new Error(`thread not found: ${threadId}`);
        const archivedPath = `${HOME}/archived_sessions/rollout-${threadId}.jsonl`;
        return {thread: {...entry.thread, path: entry.archived ? archivedPath : entry.thread.path}};
    });

    put(value: Thread, archived = false): Thread {
        this.threads.set(value.id, {thread: value, archived});
        return value;
    }

    update(id: string, overrides: Partial<Thread>, archived?: boolean): void {
        const entry = this.threads.get(id)!;
        this.threads.set(id, {thread: {...entry.thread, ...overrides}, archived: archived ?? entry.archived});
    }

    scans(): ThreadListParams[] {
        return this.threadList.mock.calls.map(call => call[0]).filter(params => params.cwd === undefined);
    }
}

interface Setup {
    codex: FakeCodex;
    subscriptions: SessionListSubscriptions;
    sent: SessionListChanges[];
    listener: () => CodexHomeWatcherListener;
    stops: ReturnType<typeof vi.fn>;
    scopes: Map<string, string[]>;
}

function setup(
    home: string | null = HOME,
    codex = new FakeCodex(),
): Setup {
    const sent: SessionListChanges[] = [];
    const clockStart = Date.now();
    let listener: CodexHomeWatcherListener | null = null;
    const stops = vi.fn();
    const scopes = new Map<string, string[]>();
    const subscriptions = new SessionListSubscriptions({
        reader: () => codex,
        codexHome: () => home,
        rows: async (entries) => entries.map(({thread: value, archived}) => {
            const state = activityStateOf(value.status);
            return sessionIndexSessionInfo(value, archived, state === undefined ? null : {state});
        }),
        scopeCwds: (cwd) => scopes.get(cwd) ?? [cwd],
        notify: async (changes) => {
            sent.push(changes);
        },
        watchCodexHome: (_home, watchListener) => {
            listener = watchListener;
            return {stop: stops};
        },
        timings,
        // The clock of the tests starts at second 1,000 of `updatedAt`, where their threads are.
        now: () => 1_000_000 + Date.now() - clockStart,
    });
    return {codex, subscriptions, sent, listener: () => listener!, stops, scopes};
}

function ids(rows: acp.SessionInfo[]): string[] {
    return rows.map(row => row.sessionId);
}

function own(method: string, params: Record<string, unknown>): ServerNotification {
    return {method, params} as unknown as ServerNotification;
}

describe("SessionListSubscriptions", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("reads no rows when it subscribes, sends nothing while no thread changes, and the first change in full", async () => {
        const {codex, subscriptions, sent, listener} = setup();
        codex.put(thread("a"));
        codex.put(thread("b"), true);
        codex.put(thread("other", {cwd: "/elsewhere"}));

        const subscriptionId = await subscriptions.subscribe("/repo");
        // Only the marks: one small thread/list without cwd per archive state.
        expect(codex.threadList.mock.calls.map(call => call[0])).toEqual([false, true].map(archived =>
            expect.objectContaining({archived, limit: 20, sortKey: "updated_at"})));
        listener().stateChanged();
        await vi.advanceTimersByTimeAsync(2_000);
        expect(sent).toEqual([]);

        // The first event of a thread after subscribing sends its row, even with nothing changed in it.
        subscriptions.observe(own("thread/status/changed", {threadId: "a", status: {type: "notLoaded"}}));
        await vi.advanceTimersByTimeAsync(timings.ownChangeDelayMs);
        expect(sent).toEqual([{subscriptionId, sessions: [expect.objectContaining({sessionId: "a"})], removed: []}]);
        subscriptions.observe(own("thread/status/changed", {threadId: "a", status: {type: "notLoaded"}}));
        await vi.advanceTimersByTimeAsync(2_000);
        expect(sent).toHaveLength(1);
        subscriptions.dispose();
    });

    it("sends the row of an own thread right after its notification", async () => {
        const {codex, subscriptions, sent} = setup();
        codex.put(thread("a"));
        const subscriptionId = await subscriptions.subscribe("/repo");

        codex.update("a", {status: {type: "active", activeFlags: []}, recencyAt: 2_000, updatedAt: 2_000});
        subscriptions.observe(own("turn/started", {threadId: "a", turn: {}}));
        subscriptions.observe(own("thread/status/changed", {threadId: "a", status: {type: "active", activeFlags: []}}));
        await vi.advanceTimersByTimeAsync(timings.ownChangeDelayMs);

        expect(codex.threadRead).toHaveBeenCalledTimes(1);
        expect(sent).toEqual([{
            subscriptionId,
            sessions: [sessionIndexSessionInfo(codex.threads.get("a")!.thread, false, {state: "running"})],
            removed: [],
        }]);
        subscriptions.dispose();
    });

    it("sends a thread that another process changed after a WAL write, read by one thread/list without cwd", async () => {
        const {codex, subscriptions, sent, listener} = setup();
        codex.put(thread("a", {updatedAt: 1_000}));
        codex.put(thread("b", {updatedAt: 900}));
        const subscriptionId = await subscriptions.subscribe("/repo");
        codex.threadList.mockClear();

        codex.update("b", {updatedAt: 1_100, name: "Renamed by a turn"});
        listener().stateChanged();
        await vi.advanceTimersByTimeAsync(timings.quietMs - 1);
        expect(sent).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);

        expect(sent).toEqual([{subscriptionId, sessions: [expect.objectContaining({sessionId: "b", title: "Renamed by a turn"})], removed: []}]);
        expect(codex.threadList.mock.calls.map(call => call[0])).toEqual([false, true].map(archived => ({
            cursor: null,
            limit: 20,
            sortKey: "updated_at",
            archived,
            sourceKinds: [],
            modelProviders: [],
            useStateDbOnly: true,
        })));
        subscriptions.dispose();
    });

    it("sends nothing for a change of updatedAt alone, which rides along with the next change", async () => {
        const {codex, subscriptions, sent, listener} = setup();
        codex.put(thread("a", {updatedAt: 1_000}));
        await subscriptions.subscribe("/repo");

        // The first change after subscribing goes out in full, whatever changed.
        codex.update("a", {updatedAt: 1_040});
        listener().stateChanged();
        await vi.advanceTimersByTimeAsync(timings.maxWaitMs);
        expect(sent).toHaveLength(1);
        sent.length = 0;

        codex.update("a", {updatedAt: 1_050});
        listener().stateChanged();
        await vi.advanceTimersByTimeAsync(timings.maxWaitMs);
        expect(sent).toEqual([]);

        codex.update("a", {updatedAt: 1_060, model: "gpt-6"});
        listener().stateChanged();
        await vi.advanceTimersByTimeAsync(timings.maxWaitMs);
        expect(sent.flatMap(changes => changes.sessions)).toEqual([expect.objectContaining({
            sessionId: "a",
            updatedAt: new Date(1_060_000).toISOString(),
        })]);
        subscriptions.dispose();
    });

    it("waits for a quiet time after WAL writes, but no longer than the max wait", async () => {
        const {codex, subscriptions, listener} = setup();
        codex.put(thread("a"));
        await subscriptions.subscribe("/repo");
        const scansBefore = codex.scans().length;

        for (let elapsed = 0; elapsed < timings.maxWaitMs; elapsed += 100) {
            listener().stateChanged();
            await vi.advanceTimersByTimeAsync(100);
        }

        expect(codex.scans().length - scansBefore).toBe(2);
        subscriptions.dispose();
    });

    it("pages a scan until the rows are older than the newest one it saw before", async () => {
        const {codex, subscriptions, sent, listener} = setup();
        for (let index = 0; index < 30; index++) codex.put(thread(`old-${index}`, {updatedAt: 500 + index, cwd: "/elsewhere"}));
        await subscriptions.subscribe("/repo");
        for (let index = 0; index < 40; index++) codex.put(thread(`new-${index}`, {updatedAt: 2_000 + index, cwd: "/elsewhere"}));
        codex.put(thread("mine", {updatedAt: 1_999}));
        codex.threadList.mockClear();

        listener().stateChanged();
        await vi.advanceTimersByTimeAsync(timings.maxWaitMs);

        expect(sent.flatMap(changes => ids(changes.sessions))).toEqual(["mine"]);
        expect(codex.scans().filter(params => params.archived === false).map(params => params.limit)).toEqual([20, 100]);
        subscriptions.dispose();
    });

    it("goes on with a scan that stopped at its page limit before it reached the mark", async () => {
        const {codex, subscriptions, sent, listener} = setup();
        codex.put(thread("mine", {updatedAt: 1_000}));
        await subscriptions.subscribe("/repo");
        codex.update("mine", {updatedAt: 1_500, name: "changed"});
        // More changes elsewhere than one scan reads, all newer than the change of "mine".
        for (let index = 0; index < 1_000; index++) codex.put(thread(`other-${index}`, {updatedAt: 2_000 + index, cwd: "/elsewhere"}));

        listener().stateChanged();
        await vi.advanceTimersByTimeAsync(2 * timings.maxWaitMs);

        expect(sent.flatMap(changes => changes.sessions.map(row => row.title))).toEqual(["changed"]);
        expect(codex.scans().filter(params => params.archived === false).length).toBeGreaterThan(11);
        subscriptions.dispose();
    });

    it("places a thread of a worktree created right after the worktrees were resolved, and drops a removed one", async () => {
        const {codex, subscriptions, sent, listener, scopes} = setup();
        scopes.set("/repo", ["/repo", "/repo-old"]);
        await subscriptions.subscribe("/repo");
        codex.put(thread("x", {cwd: "/elsewhere", updatedAt: 3_000}));
        listener().stateChanged();
        await vi.advanceTimersByTimeAsync(timings.maxWaitMs);
        // The worktree appears just after the groups resolved theirs for "/elsewhere".
        scopes.set("/repo", ["/repo", "/repo-new"]);
        codex.put(thread("w", {cwd: "/repo-new", updatedAt: 3_100}));
        listener().stateChanged();
        await vi.advanceTimersByTimeAsync(3_000);
        expect(sent.flatMap(changes => ids(changes.sessions))).toEqual(["w"]);

        await vi.advanceTimersByTimeAsync(10_000);
        codex.put(thread("old", {cwd: "/repo-old", updatedAt: 4_000}));
        listener().stateChanged();
        await vi.advanceTimersByTimeAsync(timings.maxWaitMs);
        expect(sent.flatMap(changes => ids(changes.sessions))).toEqual(["w"]);
        subscriptions.dispose();
    });

    it("starts a scan from the top again after one that went on from its page limit", async () => {
        const {codex, subscriptions, sent, listener} = setup();
        codex.put(thread("mine", {updatedAt: 1_000}));
        await subscriptions.subscribe("/repo");
        for (let index = 0; index < 1_000; index++) codex.put(thread(`other-${index}`, {updatedAt: 2_000 + index, cwd: "/elsewhere"}));
        listener().stateChanged();
        await vi.advanceTimersByTimeAsync(timings.quietMs);
        // A new thread while the scan goes on below its first pages.
        codex.put(thread("new", {updatedAt: 9_000}));
        listener().stateChanged();
        await vi.advanceTimersByTimeAsync(3 * timings.maxWaitMs);

        expect(sent.flatMap(changes => ids(changes.sessions))).toContain("new");
        subscriptions.dispose();
    });

    it("tells every subscription whose scope has a thread of its change and its deletion", async () => {
        const {codex, subscriptions, sent, scopes} = setup();
        scopes.set("/repo", ["/repo", "/repo-wt"]);
        scopes.set("/repo-wt", ["/repo-wt", "/repo"]);
        codex.put(thread("old", {cwd: "/repo", updatedAt: 10}));
        const repo = await subscriptions.subscribe("/repo");
        const worktree = await subscriptions.subscribe("/repo-wt");

        // No group has a row of the thread yet: it is read, and both get it.
        subscriptions.observe(own("thread/name/updated", {threadId: "old"}));
        await vi.advanceTimersByTimeAsync(timings.ownChangeDelayMs);
        expect(codex.threadRead.mock.calls.map(call => call[0].threadId)).toEqual(["old"]);
        expect(sent.filter(changes => changes.sessions.some(row => row.sessionId === "old")).map(changes => changes.subscriptionId).sort())
            .toEqual([repo, worktree].sort());

        codex.threads.delete("old");
        subscriptions.observe(own("thread/deleted", {threadId: "old"}));
        await vi.advanceTimersByTimeAsync(timings.minChangeIntervalMs);
        expect(sent.filter(changes => changes.removed.includes("old")).map(changes => changes.subscriptionId).sort())
            .toEqual([repo, worktree].sort());
        subscriptions.dispose();
    });

    it("scans from the top after a catch-up when a write came while the first scan still read", async () => {
        const {codex, subscriptions, sent, listener} = setup();
        await subscriptions.subscribe("/repo");
        for (let index = 0; index < 1_000; index++) codex.put(thread(`other-${index}`, {updatedAt: 2_000 + index, cwd: "/elsewhere"}));
        const list = codex.threadList.getMockImplementation()!;
        let calls = 0;
        codex.threadList.mockImplementation(async (params) => {
            // A write while the first scan reads its third page.
            if (params.cwd === undefined && ++calls === 3) {
                codex.put(thread("new", {updatedAt: 9_000}));
                listener().stateChanged();
            }
            return await list(params);
        });
        listener().stateChanged();
        await vi.advanceTimersByTimeAsync(5 * timings.maxWaitMs);

        expect(sent.flatMap(changes => ids(changes.sessions))).toContain("new");
        subscriptions.dispose();
    });

    it("reads past its page limit a change within the second of its mark", async () => {
        const {codex, subscriptions, sent, listener} = setup();
        // Listed after the 1,000 others of its second, beyond the 920 rows of a scan.
        codex.put(thread("mine", {updatedAt: 4_999}));
        await subscriptions.subscribe("/repo");
        for (let index = 0; index < 1_000; index++) codex.put(thread(`same-${index}`, {updatedAt: 5_000, cwd: "/elsewhere"}));
        codex.threads.delete("mine");
        codex.put(thread("mine", {updatedAt: 5_000, name: "changed"}));
        listener().stateChanged();
        await vi.advanceTimersByTimeAsync(5 * timings.maxWaitMs);
        expect(sent.flatMap(changes => changes.sessions.map(row => row.title))).toEqual(["changed"]);

        // Changed again within the same second, which leaves the mark where it is.
        codex.update("mine", {model: "gpt-6"});
        listener().stateChanged();
        await vi.advanceTimersByTimeAsync(5 * timings.maxWaitMs);
        expect(sent.flatMap(changes => changes.sessions.map(row => row.title))).toEqual(["changed", "changed"]);
        subscriptions.dispose();
    });

    it("reads again every row with a state when the app-server was replaced", async () => {
        const {codex, subscriptions, sent} = setup();
        codex.put(thread("loaded", {status: {type: "active", activeFlags: []}}));
        codex.put(thread("foreign"));
        await subscriptions.subscribe("/repo");
        subscriptions.observe(own("turn/started", {threadId: "loaded", turn: {}}));
        await vi.advanceTimersByTimeAsync(timings.minChangeIntervalMs);
        sent.length = 0;
        codex.threadRead.mockClear();
        // The replacement has not loaded the thread.
        codex.update("loaded", {status: {type: "notLoaded"}});

        subscriptions.refreshLoadedThreads([]);
        await vi.advanceTimersByTimeAsync(timings.ownChangeDelayMs);

        expect(codex.threadRead.mock.calls.map(call => call[0].threadId)).toEqual(["loaded"]);
        expect(sent.flatMap(changes => ids(changes.sessions))).toEqual(["loaded"]);
        subscriptions.dispose();
    });

    it("reads again from the new app-server what a flush read from the one that was replaced", async () => {
        const {codex, subscriptions, sent} = setup();
        codex.put(thread("a"));
        await subscriptions.subscribe("/repo");
        const read = codex.threadRead.getMockImplementation()!;
        codex.threadRead.mockImplementationOnce(async (params) => {
            const response = await read(params);
            // The app-server is replaced while the read is out.
            codex.update("a", {status: {type: "notLoaded"}});
            subscriptions.refreshLoadedThreads([]);
            return response;
        });
        codex.update("a", {status: {type: "active", activeFlags: []}});
        subscriptions.observe(own("turn/started", {threadId: "a", turn: {}}));
        await vi.advanceTimersByTimeAsync(timings.maxWaitMs);

        // Only the row read from the new app-server goes out, without the state of the old one.
        expect(codex.threadRead).toHaveBeenCalledTimes(2);
        expect(sent.flatMap(changes => changes.sessions.map(row => (row._meta as any).jetbrains.air.state ?? null))).toEqual([null]);
        subscriptions.dispose();
    });

    it("sends the first change that a notification names, also when a scan reads the thread in the same flush", async () => {
        const {codex, subscriptions, sent, listener} = setup();
        codex.put(thread("a", {updatedAt: 1_000}));
        await subscriptions.subscribe("/repo");
        codex.update("a", {name: "renamed"});
        listener().stateChanged();
        await vi.advanceTimersByTimeAsync(timings.quietMs - 10);
        // Due after the scan: both go in one flush.
        subscriptions.observe(own("thread/name/updated", {threadId: "a"}));
        await vi.advanceTimersByTimeAsync(timings.ownChangeDelayMs);

        expect(sent.flatMap(changes => changes.sessions.map(row => row.title))).toContain("renamed");
        subscriptions.dispose();
    });

    it("tries a failed scan again only after both of its reads settled, a second later", async () => {
        const {codex, subscriptions, listener} = setup();
        await subscriptions.subscribe("/repo");
        const list = codex.threadList.getMockImplementation()!;
        let release: () => void = () => {};
        codex.threadList.mockImplementation(async (params) => {
            if (params.archived) {
                await new Promise<void>(resolve => {
                    release = resolve;
                });
                return await list(params);
            }
            throw new Error("busy");
        });
        const before = codex.scans().length;
        listener().stateChanged();
        await vi.advanceTimersByTimeAsync(3_000);
        expect(codex.scans().length - before).toBe(2);

        codex.threadList.mockImplementation(list);
        release();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(codex.scans().length - before).toBe(4);
        subscriptions.dispose();
    });

    it("reads the threads changed since subscribing when the first marks could not be read", async () => {
        const {codex, subscriptions, sent, listener} = setup();
        codex.put(thread("old", {updatedAt: 100}));
        codex.threadList.mockRejectedValueOnce(new Error("busy")).mockRejectedValueOnce(new Error("busy"));
        await subscriptions.subscribe("/repo");

        // A thread updated before subscribing, which the scans read as their mark, is no change.
        listener().stateChanged();
        await vi.advanceTimersByTimeAsync(timings.maxWaitMs);
        listener().stateChanged();
        await vi.advanceTimersByTimeAsync(timings.maxWaitMs);
        expect(sent).toEqual([]);

        codex.put(thread("new", {updatedAt: Math.floor(Date.now() / 1000) + 5}));
        listener().stateChanged();
        await vi.advanceTimersByTimeAsync(timings.maxWaitMs);
        expect(sent.flatMap(changes => ids(changes.sessions))).toEqual(["new"]);
        subscriptions.dispose();
    });

    it("reads one page per archive state for its first marks, however many threads are new", async () => {
        const {codex, subscriptions} = setup();
        const now = Math.floor(Date.now() / 1000);
        for (let index = 0; index < 1_000; index++) codex.put(thread(`t-${index}`, {updatedAt: now, cwd: "/elsewhere"}));

        await subscriptions.subscribe("/repo");

        expect(codex.threadList).toHaveBeenCalledTimes(2);
        subscriptions.dispose();
    });

    it("counts a thread updated before a subscription started as unchanged for it, whatever the marks", async () => {
        const {codex, subscriptions, sent, listener} = setup();
        codex.put(thread("a", {updatedAt: 1_000}));
        const first = await subscriptions.subscribe("/repo");
        await vi.advanceTimersByTimeAsync(200_000);
        // Changed by another process before the second subscription, with no scan in between.
        codex.update("a", {updatedAt: 1_100, name: "changed"});
        const second = await subscriptions.subscribe("/repo");

        listener().stateChanged();
        await vi.advanceTimersByTimeAsync(timings.maxWaitMs);

        expect(sent.map(changes => changes.subscriptionId)).toEqual([first]);
        void second;
        subscriptions.dispose();
    });

    it("sends a change that another process made while the first marks were read", async () => {
        const {codex, subscriptions, sent, listener} = setup();
        codex.put(thread("b", {updatedAt: 1_000, cwd: "/elsewhere"}));
        const list = codex.threadList.getMockImplementation()!;
        codex.threadList.mockImplementationOnce(async (params) => {
            // Two threads change while the first marks are read.
            codex.put(thread("a", {updatedAt: 1_001}));
            codex.update("b", {updatedAt: 1_002});
            return await list(params);
        });
        await subscriptions.subscribe("/repo");
        listener().stateChanged();
        await vi.advanceTimersByTimeAsync(timings.maxWaitMs);

        expect(sent.flatMap(changes => ids(changes.sessions))).toEqual(["a"]);
        subscriptions.dispose();
    });

    it("keeps a thread that only a scan found from a later subscription when the second held it back", async () => {
        const {codex, subscriptions, sent, listener} = setup();
        codex.put(thread("a", {updatedAt: 1_000}));
        const first = await subscriptions.subscribe("/repo");
        await vi.advanceTimersByTimeAsync(100_000);
        codex.update("a", {updatedAt: 1_050, name: "one"});
        listener().stateChanged();
        await vi.advanceTimersByTimeAsync(timings.maxWaitMs - 200);
        // Changed again, then the second subscription starts, then a scan within the second of the first send.
        codex.update("a", {updatedAt: 1_060, name: "two"});
        const second = await subscriptions.subscribe("/repo");
        await vi.advanceTimersByTimeAsync(100);
        listener().stateChanged();
        await vi.advanceTimersByTimeAsync(3 * timings.maxWaitMs);

        expect(sent.map(changes => [changes.subscriptionId, changes.sessions[0]!.title])).toEqual([[first, "one"], [first, "two"]]);
        void second;
        subscriptions.dispose();
    });

    it("sends an archive by another process to a later subscription while a scan retry of the thread waits", async () => {
        const {codex, subscriptions, sent, listener} = setup();
        codex.put(thread("a", {updatedAt: 1_000}));
        const first = await subscriptions.subscribe("/repo");
        await vi.advanceTimersByTimeAsync(100_000);
        codex.update("a", {updatedAt: 1_050, name: "one"});
        listener().stateChanged();
        await vi.advanceTimersByTimeAsync(timings.maxWaitMs - 200);
        codex.update("a", {updatedAt: 1_060, name: "two"});
        listener().stateChanged();
        await vi.advanceTimersByTimeAsync(timings.quietMs);
        // The scan found "two" within the second of "one": its retry waits. Then a new subscription, then an archive.
        const second = await subscriptions.subscribe("/repo");
        codex.update("a", {}, true);
        listener().archiveMoved("a");
        await vi.advanceTimersByTimeAsync(3 * timings.maxWaitMs);

        expect(sent.filter(changes => changes.subscriptionId === second).flatMap(changes => changes.sessions)
            .map(row => (row._meta as any).jetbrains.air.archived)).toEqual([true]);
        void first;
        subscriptions.dispose();
    });

    it("keeps a notification named while a scan read as a change of its own when the second holds the thread back", async () => {
        const {codex, subscriptions, sent, listener} = setup();
        codex.put(thread("a", {updatedAt: 1_000}));
        await subscriptions.subscribe("/repo");
        await vi.advanceTimersByTimeAsync(100_000);
        codex.update("a", {updatedAt: 1_050, name: "one"});
        subscriptions.observe(own("thread/name/updated", {threadId: "a"}));
        await vi.advanceTimersByTimeAsync(timings.ownChangeDelayMs);
        const second = await subscriptions.subscribe("/repo");
        const list = codex.threadList.getMockImplementation()!;
        codex.threadList.mockImplementation(async (params) => {
            const response = await list(params);
            // A notification while the scan reads.
            if (!params.archived) {
                codex.update("a", {status: {type: "active", activeFlags: ["waitingOnApproval"]}});
                subscriptions.observe(own("thread/status/changed", {threadId: "a", status: {type: "active", activeFlags: ["waitingOnApproval"]}}));
            }
            return response;
        });
        listener().stateChanged();
        await vi.advanceTimersByTimeAsync(3 * timings.maxWaitMs);

        expect(sent.filter(changes => changes.subscriptionId === second).flatMap(changes => changes.sessions)
            .map(row => (row._meta as any).jetbrains.air.state)).toEqual(["requires_action"]);
        subscriptions.dispose();
    });

    it("does not go on forever with pages of threads all of the second of its mark", async () => {
        const {codex, subscriptions, listener} = setup();
        for (let index = 0; index < 1_001; index++) codex.put(thread(`same-${index}`, {updatedAt: 5_000, cwd: "/elsewhere"}));
        await subscriptions.subscribe("/repo");
        listener().stateChanged();
        await vi.advanceTimersByTimeAsync(5 * timings.maxWaitMs);
        const scans = codex.scans().length;

        await vi.advanceTimersByTimeAsync(5 * timings.maxWaitMs);
        expect(codex.scans().length).toBe(scans);
        subscriptions.dispose();
    });

    it("sends a thread at most once a second, with its latest row", async () => {
        const {codex, subscriptions, sent} = setup();
        codex.put(thread("a"));
        await subscriptions.subscribe("/repo");

        codex.update("a", {name: "one"});
        subscriptions.observe(own("thread/name/updated", {threadId: "a", threadName: "one"}));
        await vi.advanceTimersByTimeAsync(timings.ownChangeDelayMs);
        codex.update("a", {name: "two"});
        subscriptions.observe(own("thread/name/updated", {threadId: "a", threadName: "two"}));
        await vi.advanceTimersByTimeAsync(100);
        codex.update("a", {name: "three"});
        subscriptions.observe(own("thread/name/updated", {threadId: "a", threadName: "three"}));
        await vi.advanceTimersByTimeAsync(500);
        expect(sent.map(changes => changes.sessions.map(row => row.title))).toEqual([["one"]]);

        await vi.advanceTimersByTimeAsync(timings.minChangeIntervalMs);
        expect(sent.map(changes => changes.sessions.map(row => row.title))).toEqual([["one"], ["three"]]);
        subscriptions.dispose();
    });

    it("sends the changes of one flush in one notification per subscription", async () => {
        const {codex, subscriptions, sent} = setup();
        codex.put(thread("a"));
        codex.put(thread("b"));
        const subscriptionId = await subscriptions.subscribe("/repo");

        codex.update("a", {name: "A"});
        codex.update("b", {name: "B"});
        subscriptions.observe(own("thread/name/updated", {threadId: "a"}));
        subscriptions.observe(own("thread/name/updated", {threadId: "b"}));
        await vi.advanceTimersByTimeAsync(timings.ownChangeDelayMs);

        expect(sent).toHaveLength(1);
        expect(sent[0]!.subscriptionId).toBe(subscriptionId);
        expect(ids(sent[0]!.sessions).sort()).toEqual(["a", "b"]);
        subscriptions.dispose();
    });

    it("shares the watching of a cwd between its subscriptions and notifies each one", async () => {
        const {codex, subscriptions, sent, listener} = setup();
        codex.put(thread("a"));
        const first = await subscriptions.subscribe("/repo");
        const second = await subscriptions.subscribe("/repo/");
        expect(first).not.toBe(second);
        expect(codex.threadList.mock.calls.filter(call => call[0].cwd !== undefined)).toHaveLength(0);
        expect(subscriptions.resources()).toMatchObject({subscriptions: 2, groups: 1, watching: true});
        codex.threadList.mockClear();

        codex.update("a", {updatedAt: 2_000, name: "changed"});
        listener().stateChanged();
        await vi.advanceTimersByTimeAsync(timings.maxWaitMs);

        expect(codex.scans()).toHaveLength(2);
        expect(sent.map(changes => changes.subscriptionId).sort()).toEqual([first, second].sort());
        expect(sent.every(changes => ids(changes.sessions).join() === "a")).toBe(true);

        subscriptions.unsubscribe(first);
        sent.length = 0;
        codex.update("a", {updatedAt: 3_000, name: "again"});
        listener().stateChanged();
        await vi.advanceTimersByTimeAsync(timings.maxWaitMs);
        expect(sent.map(changes => changes.subscriptionId)).toEqual([second]);
        subscriptions.dispose();
    });

    it("covers the worktrees of the cwd, any archive state, and no other cwd", async () => {
        const {codex, subscriptions, sent, listener, scopes} = setup();
        scopes.set("/repo", ["/repo", "/repo-wt"]);
        await subscriptions.subscribe("/repo");

        codex.put(thread("worktree", {cwd: "/repo-wt", updatedAt: 2_000}));
        codex.put(thread("archived", {updatedAt: 2_000}), true);
        codex.put(thread("other", {cwd: "/other", updatedAt: 2_000}));
        listener().stateChanged();
        await vi.advanceTimersByTimeAsync(timings.maxWaitMs);

        expect(sent.flatMap(changes => ids(changes.sessions)).sort()).toEqual(["archived", "worktree"]);
        subscriptions.dispose();
    });

    it("sends an archive and an unarchive as a row change and a deletion in removed", async () => {
        const {codex, subscriptions, sent} = setup();
        codex.put(thread("a"));
        const subscriptionId = await subscriptions.subscribe("/repo");

        codex.update("a", {}, true);
        subscriptions.observe(own("thread/archived", {threadId: "a"}));
        await vi.advanceTimersByTimeAsync(timings.ownChangeDelayMs);
        expect(sent.at(-1)!.sessions[0]!._meta).toMatchObject({jetbrains: {air: {archived: true}}});

        codex.threads.delete("a");
        subscriptions.observe(own("thread/deleted", {threadId: "a"}));
        await vi.advanceTimersByTimeAsync(timings.minChangeIntervalMs);
        expect(sent.at(-1)).toEqual({subscriptionId, sessions: [], removed: ["a"]});
        subscriptions.dispose();
    });

    it("tells every subscription of a thread it deleted that no group has seen", async () => {
        const {subscriptions, sent} = setup();
        const repo = await subscriptions.subscribe("/repo");
        const other = await subscriptions.subscribe("/other");

        subscriptions.observe(own("thread/deleted", {threadId: "unknown"}));
        await vi.advanceTimersByTimeAsync(timings.ownChangeDelayMs);

        expect(sent.map(changes => [changes.subscriptionId, changes.removed]).sort())
            .toEqual([[repo, ["unknown"]], [other, ["unknown"]]].sort());
        subscriptions.dispose();
    });

    it("skips the helper threads of its own app-server and the threads the list does not show", async () => {
        const {codex, subscriptions, sent} = setup();
        await subscriptions.subscribe("/repo");
        codex.put(thread("title", {ephemeral: true}));
        codex.put(thread("fresh", {preview: ""}));

        subscriptions.observe(own("thread/started", {thread: codex.threads.get("title")!.thread}));
        subscriptions.observe(own("turn/started", {threadId: "title", turn: {}}));
        subscriptions.observe(own("thread/status/changed", {threadId: "fresh", status: {type: "idle"}}));
        await vi.advanceTimersByTimeAsync(timings.ownChangeDelayMs);

        expect(codex.threadRead.mock.calls.map(call => call[0].threadId)).toEqual(["fresh"]);
        expect(sent).toEqual([]);
        subscriptions.dispose();
    });

    it("keeps the quiet time of a WAL write when an own notification flushes earlier", async () => {
        const {codex, subscriptions, listener} = setup();
        codex.put(thread("a"));
        await subscriptions.subscribe("/repo");
        const scansBefore = codex.scans().length;

        listener().stateChanged();
        subscriptions.observe(own("thread/name/updated", {threadId: "a"}));
        await vi.advanceTimersByTimeAsync(timings.ownChangeDelayMs);
        expect(codex.threadRead).toHaveBeenCalledTimes(1);
        expect(codex.scans().length).toBe(scansBefore);

        await vi.advanceTimersByTimeAsync(timings.quietMs);
        expect(codex.scans().length - scansBefore).toBe(2);
        subscriptions.dispose();
    });

    it("counts the second between two changes of a thread from when the first went out, after slow reads", async () => {
        const {codex, subscriptions, sent} = setup();
        codex.put(thread("a"));
        await subscriptions.subscribe("/repo");
        const read = codex.threadRead.getMockImplementation()!;
        codex.threadRead.mockImplementationOnce(async (params) => {
            await new Promise(resolve => setTimeout(resolve, 1_100));
            return await read(params);
        });
        const sentAt: number[] = [];
        const start = Date.now();

        codex.update("a", {name: "one"});
        subscriptions.observe(own("thread/name/updated", {threadId: "a"}));
        await vi.advanceTimersByTimeAsync(1_200);
        sentAt.push(Date.now() - start);
        codex.update("a", {name: "two"});
        subscriptions.observe(own("thread/name/updated", {threadId: "a"}));
        await vi.advanceTimersByTimeAsync(100);
        expect(sent.map(changes => changes.sessions[0]!.title)).toEqual(["one"]);

        await vi.advanceTimersByTimeAsync(timings.minChangeIntervalMs);
        expect(sent.map(changes => changes.sessions[0]!.title)).toEqual(["one", "two"]);
        subscriptions.dispose();
    });

    it("sends a change that the second limit held back to a subscription that started meanwhile", async () => {
        const {codex, subscriptions, sent} = setup();
        codex.put(thread("a"));
        const first = await subscriptions.subscribe("/repo");
        codex.update("a", {name: "one"});
        subscriptions.observe(own("thread/name/updated", {threadId: "a"}));
        await vi.advanceTimersByTimeAsync(timings.ownChangeDelayMs);
        codex.update("a", {name: "two"});
        subscriptions.observe(own("thread/name/updated", {threadId: "a"}));
        await vi.advanceTimersByTimeAsync(timings.ownChangeDelayMs);

        // The client of the second subscription listed the thread before its second rename.
        const second = await subscriptions.subscribe("/repo");
        await vi.advanceTimersByTimeAsync(timings.minChangeIntervalMs);

        expect(sent).toHaveLength(3);
        expect([sent[0]!.subscriptionId, sent[0]!.sessions[0]!.title]).toEqual([first, "one"]);
        expect(sent.slice(1).map(changes => changes.subscriptionId).sort()).toEqual([first, second].sort());
        expect(sent.slice(1).every(changes => changes.sessions[0]!.title === "two")).toBe(true);
        subscriptions.dispose();
    });

    it("sends no change before subscribe answers, and the changes of that time right after", async () => {
        const {codex, subscriptions, sent} = setup();
        codex.put(thread("a"));
        const held: Array<() => void> = [];
        const releaseMarks = () => held.forEach(release => release());
        const list = codex.threadList.getMockImplementation()!;
        // The first marks come late.
        codex.threadList.mockImplementation(async (params) => {
            const rows = await list(params);
            if (params.cwd === undefined) await new Promise<void>(resolve => held.push(resolve));
            return rows;
        });
        let answered = false;
        const subscribing = subscriptions.subscribe("/repo").then((id) => {
            answered = true;
            return id;
        });
        await vi.advanceTimersByTimeAsync(10);

        codex.update("a", {name: "during subscribe"});
        subscriptions.observe(own("thread/name/updated", {threadId: "a"}));
        await vi.advanceTimersByTimeAsync(100);
        expect(answered).toBe(false);
        expect(sent).toEqual([]);

        codex.threadList.mockImplementation(list);
        releaseMarks();
        const subscriptionId = await subscribing;
        expect(sent).toEqual([]);
        await vi.advanceTimersByTimeAsync(10);
        expect(sent).toEqual([{subscriptionId, sessions: [expect.objectContaining({title: "during subscribe"})], removed: []}]);
        subscriptions.dispose();
    });

    it("replaces a held row with a newer one instead of holding the newer one back a second", async () => {
        const {codex, subscriptions, sent} = setup();
        codex.put(thread("a"));
        const held: Array<() => void> = [];
        const list = codex.threadList.getMockImplementation()!;
        codex.threadList.mockImplementation(async (params) => {
            const rows = await list(params);
            if (params.cwd === undefined) await new Promise<void>(resolve => held.push(resolve));
            return rows;
        });
        const subscribing = subscriptions.subscribe("/repo");
        await vi.advanceTimersByTimeAsync(10);
        codex.update("a", {name: "B"});
        subscriptions.observe(own("thread/name/updated", {threadId: "a"}));
        await vi.advanceTimersByTimeAsync(50);
        codex.update("a", {name: "C"});
        subscriptions.observe(own("thread/name/updated", {threadId: "a"}));
        await vi.advanceTimersByTimeAsync(50);

        codex.threadList.mockImplementation(list);
        held.forEach(release => release());
        await subscribing;
        await vi.advanceTimersByTimeAsync(10);
        expect(sent.map(changes => changes.sessions.map(row => row.title))).toEqual([["C"]]);
        subscriptions.dispose();
    });

    it("resolves the worktrees of each group again, also when another group has the cwd", async () => {
        const {codex, subscriptions, sent, listener, scopes} = setup();
        const repo = await subscriptions.subscribe("/repo");
        // A worktree created after the first subscription, and subscribed on its own.
        scopes.set("/repo", ["/repo", "/repo-wt"]);
        scopes.set("/repo-wt", ["/repo-wt", "/repo"]);
        const worktree = await subscriptions.subscribe("/repo-wt");
        await vi.advanceTimersByTimeAsync(10_000);

        codex.put(thread("w", {cwd: "/repo-wt", updatedAt: 5_000}));
        listener().stateChanged();
        await vi.advanceTimersByTimeAsync(timings.maxWaitMs);

        expect(sent.map(changes => changes.subscriptionId).sort()).toEqual([repo, worktree].sort());
        subscriptions.dispose();
    });

    it("counts the second between two changes from when the notification went out, after a slow send", async () => {
        const codex = new FakeCodex();
        const sentAt: Array<[string, number]> = [];
        let slow = true;
        const subscriptions = new SessionListSubscriptions({
            reader: () => codex,
            codexHome: () => null,
            rows: async (entries) => entries.map(({thread: value, archived}) => sessionIndexSessionInfo(value, archived, null)),
            scopeCwds: (cwd) => [cwd],
            notify: async (changes) => {
                if (slow) {
                    slow = false;
                    await new Promise(resolve => setTimeout(resolve, 1_500));
                }
                sentAt.push([changes.sessions[0]!.title ?? "", Date.now()]);
            },
            timings,
        });
        codex.put(thread("a"));
        await subscriptions.subscribe("/repo");
        await subscriptions.subscribe("/repo");

        codex.update("a", {name: "one"});
        subscriptions.observe(own("thread/name/updated", {threadId: "a"}));
        await vi.advanceTimersByTimeAsync(1_600);
        codex.update("a", {name: "two"});
        subscriptions.observe(own("thread/name/updated", {threadId: "a"}));
        await vi.advanceTimersByTimeAsync(3_000);

        const lastOne = Math.max(...sentAt.filter(([title]) => title === "one").map(([, at]) => at));
        const firstTwo = Math.min(...sentAt.filter(([title]) => title === "two").map(([, at]) => at));
        expect(firstTwo - lastOne).toBeGreaterThanOrEqual(timings.minChangeIntervalMs);
        subscriptions.dispose();
    });

    it("leaves no watch and no timer after the last unsubscribe or dispose", async () => {
        const {codex, subscriptions, listener, stops} = setup();
        codex.put(thread("a"));
        const first = await subscriptions.subscribe("/repo");
        const second = await subscriptions.subscribe("/other");
        listener().stateChanged();
        subscriptions.observe(own("turn/started", {threadId: "a", turn: {}}));

        subscriptions.unsubscribe(first);
        subscriptions.unsubscribe(first);
        expect(subscriptions.resources()).toMatchObject({subscriptions: 1, groups: 1, watching: true});
        subscriptions.unsubscribe(second);

        expect(stops).toHaveBeenCalledTimes(1);
        expect(subscriptions.resources()).toEqual({subscriptions: 0, groups: 0, watching: false, timer: false});
        expect(vi.getTimerCount()).toBe(0);

        await subscriptions.subscribe("/repo");
        listener().stateChanged();
        subscriptions.dispose();
        expect(stops).toHaveBeenCalledTimes(2);
        expect(subscriptions.resources()).toEqual({subscriptions: 0, groups: 0, watching: false, timer: false});
        expect(vi.getTimerCount()).toBe(0);
    });

    it(`answers too_many_subscriptions beyond ${MAX_SESSION_LIST_SUBSCRIPTIONS}`, async () => {
        const {subscriptions} = setup(null);
        for (let index = 0; index < MAX_SESSION_LIST_SUBSCRIPTIONS; index++) {
            await subscriptions.subscribe(index % 2 === 0 ? "/repo" : `/repo/${index}`);
        }

        await expect(subscriptions.subscribe("/repo")).rejects.toMatchObject({
            code: -32602,
            data: {reason: "too_many_subscriptions"},
        });
        subscriptions.dispose();
    });

    it("reads nothing while no app-server runs, and goes on when one does", async () => {
        const codex = new FakeCodex();
        let running = true;
        const sent: SessionListChanges[] = [];
        const subscriptions = new SessionListSubscriptions({
            reader: () => running ? codex : null,
            codexHome: () => null,
            rows: async (entries) => entries.map(({thread: value, archived}) => sessionIndexSessionInfo(value, archived, null)),
            scopeCwds: (cwd) => [cwd],
            notify: async (changes) => {
                sent.push(changes);
            },
            timings,
        });
        codex.put(thread("a"));
        await subscriptions.subscribe("/repo");
        running = false;
        codex.threadRead.mockClear();

        subscriptions.observe(own("turn/started", {threadId: "a", turn: {}}));
        await vi.advanceTimersByTimeAsync(timings.maxWaitMs);
        expect(codex.threadRead).not.toHaveBeenCalled();

        running = true;
        codex.update("a", {name: "after restart"});
        subscriptions.observe(own("thread/name/updated", {threadId: "a"}));
        await vi.advanceTimersByTimeAsync(timings.ownChangeDelayMs);
        expect(sent.flatMap(changes => changes.sessions.map(row => row.title))).toEqual(["after restart"]);
        subscriptions.dispose();
    });
});

describe("SessionListSubscriptions with a CODEX_HOME on disk", () => {
    let home: string;

    beforeEach(() => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-acp-home-"));
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        fs.rmSync(home, {recursive: true, force: true});
    });

    it("reads the renames of other processes from the session name log", async () => {
        const log = path.join(home, SESSION_NAME_LOG_FILE);
        fs.writeFileSync(log, `${JSON.stringify({id: "a", thread_name: "before", updated_at: "x"})}\n`);
        const {codex, subscriptions, sent, listener} = setup(home);
        codex.put(thread("a", {name: "before", updatedAt: 500}));
        // Newer than "a": a scan does not reach "a", whose updatedAt a rename does not move.
        codex.put(thread("newer", {updatedAt: 900}));
        await subscriptions.subscribe("/repo");

        codex.update("a", {name: "renamed elsewhere"});
        fs.appendFileSync(log, `${JSON.stringify({id: "a", thread_name: "renamed elsewhere", updated_at: "x"})}\n{"id":"b"`);
        listener().stateChanged();
        await vi.advanceTimersByTimeAsync(timings.maxWaitMs);

        expect(codex.threadRead.mock.calls.map(call => call[0].threadId)).toEqual(["a"]);
        expect(sent.flatMap(changes => changes.sessions.map(row => row.title))).toEqual(["renamed elsewhere"]);
        subscriptions.dispose();
    });

    it("reads the renames of the name log also when the scan of the flush fails", async () => {
        const log = path.join(home, SESSION_NAME_LOG_FILE);
        fs.writeFileSync(log, "");
        const {codex, subscriptions, sent, listener} = setup(home);
        codex.put(thread("a", {name: "before"}));
        await subscriptions.subscribe("/repo");
        codex.threadList.mockRejectedValueOnce(new Error("app-server busy"));

        codex.update("a", {name: "renamed elsewhere"});
        fs.appendFileSync(log, `${JSON.stringify({id: "a", thread_name: "renamed elsewhere", updated_at: "x"})}\n`);
        listener().stateChanged();
        await vi.advanceTimersByTimeAsync(timings.maxWaitMs);

        expect(sent.flatMap(changes => changes.sessions.map(row => row.title))).toEqual(["renamed elsewhere"]);
        subscriptions.dispose();
    });

    it("reads a thread whose rollout moved into archived_sessions", async () => {
        const {codex, subscriptions, sent, listener} = setup(home);
        codex.put(thread("a"));
        await subscriptions.subscribe("/repo");

        codex.update("a", {}, true);
        listener().archiveMoved("a");
        await vi.advanceTimersByTimeAsync(timings.maxWaitMs);

        expect(sent.flatMap(changes => changes.sessions)).toEqual([expect.objectContaining({
            sessionId: "a",
            _meta: {jetbrains: {air: expect.objectContaining({archived: true})}},
        })]);
        subscriptions.dispose();
    });

    it("sends removed for a thread that another process deleted, also one of unknown scope to every subscription", async () => {
        const {codex, subscriptions, sent, listener} = setup(home);
        codex.put(thread("a"));
        const subscriptionId = await subscriptions.subscribe("/repo");

        codex.threads.delete("a");
        listener().archiveMoved("a");
        listener().archiveMoved("never-seen");
        await vi.advanceTimersByTimeAsync(timings.maxWaitMs);

        expect(sent).toEqual([{subscriptionId, sessions: [], removed: expect.arrayContaining(["a", "never-seen"])}]);
        subscriptions.dispose();
    });
});

import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import type {ServerNotification} from "../app-server";
import type {Thread, ThreadListParams, ThreadListResponse} from "../app-server/v2";
import type {CodexHomeWatcherListener} from "../CodexHomeWatcher";
import {sessionIndexSessionInfo} from "../SessionIndex";
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
    withLatestUsage: (row: acp.SessionInfo) => acp.SessionInfo = (row) => row,
): Setup {
    const sent: SessionListChanges[] = [];
    let listener: CodexHomeWatcherListener | null = null;
    const stops = vi.fn();
    const scopes = new Map<string, string[]>();
    const subscriptions = new SessionListSubscriptions({
        reader: () => codex,
        codexHome: () => home,
        rows: async (entries) => entries.map(({thread: value, archived}) => withLatestUsage(sessionIndexSessionInfo(value, archived, null))),
        withLatestUsage,
        scopeCwds: (cwd) => scopes.get(cwd) ?? [cwd],
        notify: async (changes) => {
            sent.push(changes);
        },
        watchCodexHome: (_home, watchListener) => {
            listener = watchListener;
            return {stop: stops};
        },
        timings,
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

    it("reads the rows the client has when it subscribes and sends nothing while no thread changes", async () => {
        const {codex, subscriptions, sent, listener} = setup();
        codex.put(thread("a"));
        codex.put(thread("b"), true);
        codex.put(thread("other", {cwd: "/elsewhere"}));

        const subscriptionId = await subscriptions.subscribe("/repo");
        listener().stateChanged();
        subscriptions.observe(own("thread/status/changed", {threadId: "a", status: {type: "notLoaded"}}));
        await vi.advanceTimersByTimeAsync(2_000);

        expect(subscriptionId).toEqual(expect.any(String));
        expect(codex.threadList.mock.calls.map(call => call[0]).filter(params => params.cwd !== undefined))
            .toEqual([false, true].map(archived => expect.objectContaining({cwd: ["/repo"], archived, sortKey: "updated_at"})));
        expect(sent).toEqual([]);
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
            sessions: [sessionIndexSessionInfo(codex.threads.get("a")!.thread, false, null)],
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
        expect(codex.threadList.mock.calls.filter(call => call[0].cwd !== undefined)).toHaveLength(2);
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
        codex.threadList.mockImplementation(async (params) => {
            if (params.cwd === undefined) await new Promise<void>(resolve => held.push(resolve));
            return await list(params);
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
        await vi.advanceTimersByTimeAsync(0);
        expect(sent).toEqual([{subscriptionId, sessions: [expect.objectContaining({title: "during subscribe"})], removed: []}]);
        subscriptions.dispose();
    });

    it("gives a late usage read the row last sent, and nothing to a deleted thread", async () => {
        const usages = new Map<string, unknown>();
        const {codex, subscriptions, sent} = setup(HOME, new FakeCodex(), (row) => usages.has(row.sessionId)
            ? {...row, _meta: {jetbrains: {air: {...(row._meta as any).jetbrains.air, usage: usages.get(row.sessionId)}}}}
            : row);
        codex.put(thread("a"));
        codex.put(thread("b"));
        await subscriptions.subscribe("/repo");
        codex.update("a", {name: "renamed"});
        subscriptions.observe(own("thread/name/updated", {threadId: "a"}));
        await vi.advanceTimersByTimeAsync(timings.ownChangeDelayMs);
        codex.threads.delete("b");
        subscriptions.observe(own("thread/deleted", {threadId: "b"}));
        await vi.advanceTimersByTimeAsync(timings.ownChangeDelayMs);
        sent.length = 0;

        usages.set("a", {inputTokens: 1});
        usages.set("b", {inputTokens: 2});
        subscriptions.usageRead(["a", "b"]);
        await vi.advanceTimersByTimeAsync(timings.minChangeIntervalMs);

        expect(sent.flatMap(changes => changes.sessions)).toEqual([expect.objectContaining({
            sessionId: "a",
            title: "renamed",
            _meta: {jetbrains: {air: expect.objectContaining({usage: {inputTokens: 1}})}},
        })]);
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
        withLatestUsage: (row) => row,
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
        codex.put(thread("a", {name: "before"}));
        // Newer than "a": a scan does not reach "a", whose updatedAt a rename does not move.
        codex.put(thread("newer", {updatedAt: 5_000}));
        await subscriptions.subscribe("/repo");

        codex.update("a", {name: "renamed elsewhere"});
        fs.appendFileSync(log, `${JSON.stringify({id: "a", thread_name: "renamed elsewhere", updated_at: "x"})}\n{"id":"b"`);
        listener().stateChanged();
        await vi.advanceTimersByTimeAsync(timings.maxWaitMs);

        expect(codex.threadRead.mock.calls.map(call => call[0].threadId)).toEqual(["a"]);
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

    it("sends removed for a thread that another process deleted only to the subscriptions that know it", async () => {
        const {codex, subscriptions, sent, listener} = setup(home);
        codex.put(thread("a"));
        const subscriptionId = await subscriptions.subscribe("/repo");

        codex.threads.delete("a");
        listener().archiveMoved("a");
        listener().archiveMoved("never-seen");
        await vi.advanceTimersByTimeAsync(timings.maxWaitMs);

        expect(sent).toEqual([{subscriptionId, sessions: [], removed: ["a"]}]);
        subscriptions.dispose();
    });
});

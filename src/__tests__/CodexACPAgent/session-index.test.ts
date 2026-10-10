import {afterEach, describe, expect, it, vi} from "vitest";
import * as acp from "@agentclientprotocol/sdk";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createCodexMockTestFixture, createTestModel, deferred, type CodexMockTestFixture} from "../acp-test-utils";
import type {Thread, ThreadListParams, ThreadListResponse} from "../../app-server/v2";
import {SESSION_LIST_CHANGES_METHOD} from "../../SessionIndex";
import {MAX_SESSION_TITLE_LENGTH} from "../../SessionTitle";

const threadId = "01a0637c-5b99-7242-9064-04545d605fdb";
const otherThreadId = "01a0637c-5b99-7242-9064-04545d605fdc";

const ACTIVE_WRITER = Object.assign(new Error(`thread ${threadId} already has an active writer`), {code: -32600});

type ClientKind = "sessionIndex" | "airWithoutSessionIndex" | "plain";

function clientCapabilities(kind: ClientKind): acp.ClientCapabilities | undefined {
    switch (kind) {
        case "sessionIndex":
            return {_meta: {jetbrains: {air: {version: 1, capabilities: ["sessionIndex"]}}}};
        case "airWithoutSessionIndex":
            return {_meta: {jetbrains: {air: {version: 1, capabilities: ["diffPatch"]}}}};
        case "plain":
            return undefined;
    }
}

function createThread(overrides: Partial<Thread> = {}): Thread {
    return {
        id: threadId,
        sessionId: threadId,
        parentThreadId: null,
        threadSource: null,
        originator: null,
        forkedFromId: null,
        preview: "First message",
        ephemeral: false,
        modelProvider: "openai",
        model: null,
        reasoningEffort: null,
        createdAt: 100,
        updatedAt: 200,
        recencyAt: 300,
        status: {type: "notLoaded"},
        path: null,
        cwd: "/repo/project",
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

async function createAgent(kind: ClientKind, threads: Thread[] = [createThread()]) {
    const fixture = createCodexMockTestFixture();
    const agent = fixture.getCodexAcpAgent();
    const client = fixture.getCodexAcpClient();
    const appServer = fixture.getCodexAppServerClient();
    const readAuthRequirement = vi.spyOn(client, "readAuthRequirement").mockResolvedValue({required: false, account: null});
    const threadList = vi.spyOn(appServer, "threadList").mockResolvedValue({data: threads, nextCursor: null, backwardsCursor: null});
    const capabilities = clientCapabilities(kind);
    await agent.initialize({protocolVersion: acp.PROTOCOL_VERSION, ...(capabilities ? {clientCapabilities: capabilities} : {})});
    readAuthRequirement.mockClear();
    return {fixture, agent, client, appServer, threadList, readAuthRequirement};
}

async function openLocalSession(fixture: CodexMockTestFixture, sessionId: string): Promise<void> {
    const client = fixture.getCodexAcpClient();
    vi.spyOn(client, "getAccount").mockResolvedValue({account: null, requiresOpenaiAuth: false});
    vi.spyOn(client, "newSession").mockResolvedValue({
        sessionId,
        currentModelId: "model-id[medium]",
        models: [createTestModel()],
        collaborationMode: "default",
        currentServiceTier: null,
        additionalDirectories: [],
    });
    await fixture.getCodexAcpAgent().newSession({cwd: "/repo/project", mcpServers: []});
    fixture.clearAcpConnectionDump();
}

function listChanges(fixture: CodexMockTestFixture): any[] {
    return fixture.getAcpConnectionEvents([])
        .filter(event => event.method === "notify" && event.args[0] === SESSION_LIST_CHANGES_METHOD)
        .map(event => event.args[1]);
}

afterEach(() => {
    vi.useRealTimers();
});

describe("sessionIndex capability negotiation", () => {
    it("advertises sessionIndex only to a client that declares it", async () => {
        const capabilitiesOf = async (kind: ClientKind) => {
            const {agent} = await createAgent(kind);
            const capabilities = clientCapabilities(kind);
            const response = await agent.initialize({
                protocolVersion: acp.PROTOCOL_VERSION,
                ...(capabilities ? {clientCapabilities: capabilities} : {}),
            });
            return (response._meta as any)?.jetbrains?.air?.capabilities ?? null;
        };

        await expect(`${JSON.stringify({
            sessionIndex: await capabilitiesOf("sessionIndex"),
            airWithoutSessionIndex: await capabilitiesOf("airWithoutSessionIndex"),
            plain: await capabilitiesOf("plain"),
        }, null, 2)}\n`).toMatchFileSnapshot("data/session-index-capabilities.json");
    });

    it("enables nothing for sessionArchive or sessionRename declared without sessionIndex", async () => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        const response = await agent.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {_meta: {jetbrains: {air: {version: 1, capabilities: ["sessionArchive", "sessionRename"]}}}},
        });

        const advertised: string[] = (response._meta as any).jetbrains.air.capabilities;
        expect(advertised.filter(name => ["sessionIndex", "sessionArchive", "sessionRename"].includes(name))).toEqual([]);
        await expect(agent.sessionIndex.rename({sessionId: threadId, title: "A"})).rejects.toMatchObject({code: -32601});
        await expect(agent.sessionIndex.setArchived({sessionId: threadId}, true)).rejects.toMatchObject({code: -32601});
        await expect(agent.sessionIndex.subscribeList({cwd: "/repo/project"})).rejects.toMatchObject({code: -32601});
        expect(() => agent.sessionIndex.unsubscribeList({subscriptionId: "x"})).toThrow(expect.objectContaining({code: -32601}));
    });
});

describe("session/list", () => {
    it("keeps the thread/list request of a client without sessionIndex", async () => {
        const requests: Record<string, ThreadListParams | undefined> = {};
        for (const kind of ["airWithoutSessionIndex", "plain"] as const) {
            const {agent, threadList} = await createAgent(kind);
            await agent.listSessions({
                cwd: "/repo/project",
                cursor: "cursor-1",
                _meta: {jetbrains: {air: {list: {limit: 10, archived: "only"}}}},
            });
            requests[kind] = threadList.mock.calls[0]?.[0];
        }

        await expect(`${JSON.stringify(requests, null, 2)}\n`).toMatchFileSnapshot("data/session-index-list-params-legacy.json");
    });

    it("asks Codex to filter, sort and limit the page for a sessionIndex client", async () => {
        const {agent, threadList} = await createAgent("sessionIndex");

        await agent.listSessions({cwd: "/repo/project", cursor: null});
        await agent.listSessions({
            cwd: "/repo/project",
            _meta: {jetbrains: {air: {list: {limit: 500, archived: "all"}}}},
        });
        await agent.listSessions({cwd: null, _meta: {jetbrains: {air: {list: {limit: 1, archived: null}}}}});
        await agent.listSessions({cwd: "/repo/project", _meta: {jetbrains: {air: {list: {limit: 5, archived: "unarchived"}}}}});
        await agent.listSessions({cwd: "/repo/project", _meta: {jetbrains: {air: {list: {limit: 5, archived: "archived"}}}}});

        await expect(`${JSON.stringify(threadList.mock.calls.map(call => call[0]), null, 2)}\n`)
            .toMatchFileSnapshot("data/session-index-list-params.json");
    });

    it("lists the sessions of the linked worktrees of the cwd only when the client asks for them", async () => {
        const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "codex-acp-session-index-")));
        try {
            const repo = path.join(root, "repo");
            const worktree = path.join(root, "feature");
            const adminDir = path.join(repo, ".git", "worktrees", "feature");
            fs.mkdirSync(adminDir, {recursive: true});
            fs.mkdirSync(worktree);
            fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
            fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${adminDir}\n`);
            fs.writeFileSync(path.join(adminDir, "commondir"), "../..\n");
            fs.writeFileSync(path.join(adminDir, "gitdir"), `${path.join(worktree, ".git")}\n`);
            const {agent, threadList} = await createAgent("sessionIndex", [
                createThread({cwd: worktree}),
            ]);

            const response = await agent.listSessions({cwd: repo, _meta: {jetbrains: {air: {list: {includeWorktrees: true}}}}});
            await agent.listSessions({cwd: repo});
            await agent.listSessions({cwd: repo, _meta: {jetbrains: {air: {list: {includeWorktrees: false}}}}});

            expect(threadList.mock.calls.map(call => call[0].cwd)).toEqual([[repo, worktree], repo, repo]);
            expect(response.sessions[0]?.cwd).toBe(worktree);
        } finally {
            fs.rmSync(root, {recursive: true, force: true});
        }
    });

    it("maps the rows of a sessionIndex client, with the state of own threads", async () => {
        const threads = [
            createThread({
                id: "running",
                status: {type: "active", activeFlags: []},
                gitInfo: {sha: null, branch: "main", originUrl: null},
                model: "gpt-5.5",
                forkedFromId: "01a0637c-5b99-7242-9064-04545d605fdd",
            }),
            createThread({id: "approval", status: {type: "active", activeFlags: ["waitingOnApproval"]}}),
            createThread({id: "input", status: {type: "active", activeFlags: ["waitingOnUserInput"]}}),
            createThread({id: "idle", status: {type: "idle"}, name: "Explicit name", recencyAt: null}),
            createThread({id: "foreign", status: {type: "notLoaded"}}),
            createThread({id: "broken", status: {type: "systemError"}}),
        ];
        const {fixture, agent} = await createAgent("sessionIndex", threads);
        await openLocalSession(fixture, "idle");
        fixture.sendServerNotification({
            method: "turn/completed",
            params: {
                threadId: "idle",
                turn: {id: "turn-1", items: [], itemsView: "notLoaded", status: "completed", error: null, startedAt: 400, completedAt: 500, durationMs: 100000},
            },
        });

        const response = await agent.listSessions({cwd: "/repo/project"});

        await expect(`${JSON.stringify(response, null, 2)}\n`).toMatchFileSnapshot("data/session-index-list-rows.json");
    });

    it("answers state error for a loaded thread whose last turn failed, until a new turn starts", async () => {
        const turn = (status: string, error: unknown) => ({
            id: "turn-1", items: [], itemsView: "notLoaded", status, error, startedAt: 400, completedAt: 500, durationMs: 100000,
        });
        const failure = {message: "boom", codexErrorInfo: null, additionalDetails: null, misalignment: null};
        const threads = [
            createThread({id: "failed", status: {type: "idle"}}),
            createThread({id: "errored", status: {type: "idle"}}),
            createThread({id: "cancelled", status: {type: "idle"}}),
            createThread({id: "broken", status: {type: "systemError"}}),
            createThread({id: "foreign", status: {type: "notLoaded"}}),
        ];
        const {fixture, agent, threadList} = await createAgent("sessionIndex", threads);
        fixture.sendServerNotification({method: "turn/completed", params: {threadId: "failed", turn: turn("failed", failure)}} as never);
        fixture.sendServerNotification({method: "turn/completed", params: {threadId: "errored", turn: turn("completed", failure)}} as never);
        fixture.sendServerNotification({method: "turn/completed", params: {threadId: "cancelled", turn: turn("interrupted", failure)}} as never);
        fixture.sendServerNotification({method: "turn/completed", params: {threadId: "foreign", turn: turn("failed", failure)}} as never);
        const stateOf = async () => Object.fromEntries((await agent.listSessions({cwd: "/repo/project"})).sessions
            .map(row => [row.sessionId, (row._meta as any)?.jetbrains?.air?.state ?? null]));

        expect(await stateOf()).toEqual({failed: "error", errored: "error", cancelled: "idle", broken: "error", foreign: null});

        fixture.sendServerNotification({method: "turn/started", params: {threadId: "failed", turn: turn("inProgress", null)}} as never);
        threadList.mockResolvedValue({data: [createThread({id: "failed", status: {type: "active", activeFlags: []}})], nextCursor: null, backwardsCursor: null});
        expect(await stateOf()).toEqual({failed: "running"});
        threadList.mockResolvedValue({data: [createThread({id: "failed", status: {type: "idle"}})], nextCursor: null, backwardsCursor: null});
        expect(await stateOf()).toEqual({failed: "idle"});
    });

    it("answers state reviewing in Codex review mode, under requires_action and over running and error", async () => {
        const item = (type: string) => ({type, id: `${type}-1`, review: "Review the diff"});
        const turn = (status: string) => ({id: "turn-1", items: [], itemsView: "notLoaded", status, error: status === "failed" ? {message: "boom", codexErrorInfo: null, additionalDetails: null, misalignment: null} : null, startedAt: 400, completedAt: 500, durationMs: 1});
        const {fixture, agent, threadList} = await createAgent("sessionIndex");
        const listWith = async (status: Thread["status"]) => {
            threadList.mockResolvedValue({data: [createThread({status})], nextCursor: null, backwardsCursor: null});
            return ((await agent.listSessions({cwd: "/repo/project"})).sessions[0]!._meta as any).jetbrains.air.state;
        };
        fixture.sendServerNotification({method: "turn/started", params: {threadId, turn: turn("inProgress")}} as never);
        fixture.sendServerNotification({method: "item/started", params: {threadId, turnId: "turn-1", item: item("enteredReviewMode"), startedAtMs: 1}} as never);
        expect(await listWith({type: "active", activeFlags: []})).toBe("reviewing");
        expect(await listWith({type: "active", activeFlags: ["waitingOnApproval"]})).toBe("requires_action");

        fixture.sendServerNotification({method: "item/completed", params: {threadId, turnId: "turn-1", item: item("exitedReviewMode"), completedAtMs: 2}} as never);
        expect(await listWith({type: "active", activeFlags: []})).toBe("running");

        // A review whose turn failed before its exit item ends with the turn.
        fixture.sendServerNotification({method: "item/started", params: {threadId, turnId: "turn-1", item: item("enteredReviewMode"), startedAtMs: 3}} as never);
        fixture.sendServerNotification({method: "turn/completed", params: {threadId, turn: turn("failed")}} as never);
        expect(await listWith({type: "idle"})).toBe("error");

        // Closed here, the thread can go on elsewhere: loaded again, it starts over.
        fixture.sendServerNotification({method: "thread/closed", params: {threadId}} as never);
        expect(await listWith({type: "idle"})).toBe("idle");

        // Review mode shows only while a turn runs: an app-server that went away mid-review sends no end.
        fixture.sendServerNotification({method: "item/started", params: {threadId, turnId: "turn-2", item: item("enteredReviewMode"), startedAtMs: 4}} as never);
        expect(await listWith({type: "idle"})).toBe("idle");
    });

    it("keeps the rows of a client without sessionIndex", async () => {
        const {agent} = await createAgent("airWithoutSessionIndex", [
            createThread({status: {type: "active", activeFlags: []}, gitInfo: {sha: null, branch: "main", originUrl: null}}),
        ]);

        const response = await agent.listSessions({cwd: "/repo/project"});

        expect(response).toEqual({
            sessions: [{
                sessionId: threadId,
                cwd: "/repo/project",
                title: "First message",
                updatedAt: "1970-01-01T00:03:20.000Z",
            }],
            nextCursor: null,
        });
    });

    it("titles a row by name, title, summary, then preview, without a cut", async () => {
        const longPreview = `Investigate ${"x".repeat(MAX_SESSION_TITLE_LENGTH)}\n end`;
        const {agent} = await createAgent("sessionIndex", [
            createThread({id: "named", name: " Named\n thread ", recencyAt: 50}),
            createThread({id: "blank-name", name: " ", preview: longPreview, recencyAt: 40}),
            {...createThread({id: "summarized", name: null, recencyAt: 30}), title: null, summary: "Summary"} as Thread,
            createThread({id: "untitled", name: null, preview: "", recencyAt: 20}),
        ]);

        const response = await agent.listSessions({cwd: "/repo/project"});

        expect(response.sessions.map(({sessionId, title}) => [sessionId, title])).toEqual([
            ["named", "Named thread"],
            ["blank-name", `Investigate ${"x".repeat(MAX_SESSION_TITLE_LENGTH)} end`],
            ["summarized", "Summary"],
            ["untitled", null],
        ]);
    });

    it("merges the unarchived and the archived threads by recency when the client asks for archived ones", async () => {
        const {agent, threadList} = await createAgent("sessionIndex");
        const row = (id: string, recencyAt: number) => createThread({id, recencyAt});
        const unarchived = [row("u1", 90), row("u2", 70), row("u3", 50), row("u4", 30), row("u5", 10)];
        const archived = [row("a1", 80), row("a2", 75), row("a3", 40), row("a4", 20)];
        threadList.mockImplementation(async (params) => {
            const rows = params.archived ? archived : unarchived;
            const start = params.cursor === null ? 0 : Number(params.cursor);
            const end = start + params.limit!;
            return {data: rows.slice(start, end), nextCursor: end < rows.length ? String(end) : null, backwardsCursor: null};
        });
        const pages: [string, boolean][][] = [];
        let cursor: string | null = null;
        do {
            const response = await agent.listSessions({cwd: "/repo/project", cursor, _meta: {jetbrains: {air: {list: {limit: 2, archived: "all"}}}}});
            expect(response.sessions.length).toBeGreaterThan(0);
            pages.push(response.sessions.map(session => [session.sessionId, (session._meta as any).jetbrains.air.archived]));
            cursor = response.nextCursor ?? null;
        } while (cursor !== null && pages.length < 20);

        expect(pages.flat().map(([id]) => id)).toEqual(["u1", "a1", "a2", "u2", "u3", "a3", "u4", "a4", "u5"]);
        expect(pages.every(page => page.length <= 2)).toBe(true);
        expect(Object.fromEntries(pages.flat())).toMatchObject({u1: false, a1: true, a4: true, u5: false});
        for (const archived of ["only", "ALL", "", true, false, 0, 1, {}, []]) {
            await expect(agent.listSessions({cwd: "/repo/project", _meta: {jetbrains: {air: {list: {archived}}}}}))
                .rejects.toMatchObject({code: -32602});
        }
        await expect(agent.listSessions({cwd: "/repo/project", _meta: {jetbrains: {air: {list: {includeWorktrees: 1}}}}}))
            .rejects.toMatchObject({code: -32602});
    });

    it("reads past an empty Codex page before it answers a row of the other list", async () => {
        const {agent, threadList} = await createAgent("sessionIndex");
        threadList.mockImplementation(async (params) => {
            const page = (data: Thread[], nextCursor: string | null) => ({data, nextCursor, backwardsCursor: null});
            if (params.archived) return page([createThread({id: "archived-10", recencyAt: 10})], null);
            return params.cursor === null
                ? page([], "unarchived-2")
                : page([createThread({id: "unarchived-20", recencyAt: 20})], null);
        });
        const ids: string[] = [];
        let cursor: string | null = null;
        do {
            const response = await agent.listSessions({cwd: "/repo/project", cursor, _meta: {jetbrains: {air: {list: {limit: 1, archived: "all"}}}}});
            ids.push(...response.sessions.map(session => session.sessionId));
            cursor = response.nextCursor ?? null;
        } while (cursor !== null && ids.length < 5);

        expect(ids).toEqual(["unarchived-20", "archived-10"]);
    });

    it("reads the unarchived and the archived lists at the same time", async () => {
        const {agent, threadList} = await createAgent("sessionIndex");
        let inFlight = 0, maxInFlight = 0;
        threadList.mockImplementation(async (params) => {
            maxInFlight = Math.max(maxInFlight, ++inFlight);
            await new Promise(resolve => setTimeout(resolve, 5));
            inFlight--;
            return {data: [createThread({id: params.archived ? "a" : "u"})], nextCursor: null, backwardsCursor: null};
        });

        await agent.listSessions({cwd: "/repo/project", _meta: {jetbrains: {air: {list: {archived: "all"}}}}});

        expect(maxInFlight).toBe(2);
    });

    it("reads only the archived Codex list for archived: \"archived\", page by page", async () => {
        const {agent, threadList} = await createAgent("sessionIndex");
        const archived = ["a1", "a2", "a3"].map((id, index) => createThread({id, recencyAt: 30 - index}));
        threadList.mockImplementation(async (params) => {
            const rows = params.archived ? archived : [createThread({id: "u1", recencyAt: 100})];
            const start = params.cursor === null ? 0 : Number(params.cursor);
            const end = start + params.limit!;
            return {data: rows.slice(start, end), nextCursor: end < rows.length ? String(end) : null, backwardsCursor: null};
        });
        const list = (cursor: string | null, archivedFilter: unknown) =>
            agent.listSessions({cwd: "/repo/project", cursor, _meta: {jetbrains: {air: {list: {limit: 2, archived: archivedFilter}}}}});

        const first = await list(null, "archived");
        const second = await list(first.nextCursor ?? null, "archived");

        expect([first, second].map(page => page.sessions.map(session => [session.sessionId, (session._meta as any).jetbrains.air.archived])))
            .toEqual([[["a1", true], ["a2", true]], [["a3", true]]]);
        expect(second.nextCursor).toBeNull();
        expect(threadList.mock.calls.map(call => [call[0].archived, call[0].cursor])).toEqual([[true, null], [true, "2"]]);
        for (const other of [undefined, null, "unarchived", "all"]) {
            await expect(list(first.nextCursor ?? null, other)).rejects.toMatchObject({code: -32602});
        }
    });

    it("binds the cursor of an unarchived or an all list to its archived value", async () => {
        const {agent, threadList} = await createAgent("sessionIndex");
        threadList.mockResolvedValue({data: [createThread({id: "a", recencyAt: 20}), createThread({id: "b", recencyAt: 10})], nextCursor: null, backwardsCursor: null});
        const list = (cursor: string | null, archived: unknown) =>
            agent.listSessions({cwd: "/repo/project", cursor, _meta: {jetbrains: {air: {list: {limit: 1, archived}}}}});

        const unarchived = (await list(null, "unarchived")).nextCursor!;
        await expect(list(unarchived, null)).resolves.toMatchObject({sessions: [{sessionId: "b"}]});
        for (const other of ["archived", "all"]) {
            await expect(list(unarchived, other)).rejects.toMatchObject({code: -32602});
        }
        const all = (await list(null, "all")).nextCursor!;
        for (const other of [undefined, "unarchived", "archived"]) {
            await expect(list(all, other)).rejects.toMatchObject({code: -32602});
        }
        await expect(list(all, "all")).resolves.toBeDefined();
    });

    it("answers rows as recent as each other unarchived first, whichever list replies first", async () => {
        for (const archivedFirst of [true, false]) {
            const {agent, threadList} = await createAgent("sessionIndex");
            threadList.mockImplementation(async (params) => {
                await new Promise(resolve => setTimeout(resolve, params.archived === archivedFirst ? 1 : 15));
                const id = params.archived ? "archived" : "unarchived";
                return {data: [createThread({id, recencyAt: 10})], nextCursor: null, backwardsCursor: null};
            });

            const response = await agent.listSessions({cwd: "/repo/project", _meta: {jetbrains: {air: {list: {archived: "all"}}}}});

            expect(response.sessions.map(session => session.sessionId)).toEqual(["unarchived", "archived"]);
        }
    });

    it("stops a sparse relative cwd scan after its time budget with a cursor to continue", async () => {
        const {agent, threadList} = await createAgent("sessionIndex");
        let page = 0;
        threadList.mockImplementation(async () => {
            await new Promise(resolve => setTimeout(resolve, 40));
            page++;
            return {data: [createThread({cwd: "/repo/other"})], nextCursor: `codex-${page}`, backwardsCursor: null};
        });

        const started = Date.now();
        const response = await agent.listSessions({cwd: "project"});

        expect(response).toEqual({sessions: [], nextCursor: expect.any(String)});
        expect(Date.now() - started).toBeLessThan(1_000);
        expect(page).toBeLessThan(20);
    });

    it("ties a cursor to the cwd and the scope of the list, but not to the limit", async () => {
        const {agent, threadList} = await createAgent("sessionIndex");
        threadList.mockResolvedValue({data: [createThread({id: "a", recencyAt: 20}), createThread({id: "b", recencyAt: 10})], nextCursor: null, backwardsCursor: null});
        const list = (cwd: string, cursor: string | null, limit = 1) =>
            agent.listSessions({cwd, cursor, _meta: {jetbrains: {air: {list: {limit, archived: null, includeWorktrees: null}}}}});
        const first = await list("/repo/a", null);

        await expect(list("/repo/b", first.nextCursor ?? null)).rejects.toMatchObject({code: -32602});
        await expect(list("/repo/a/", first.nextCursor ?? null, 5)).resolves.toMatchObject({sessions: [{sessionId: "b"}], nextCursor: null});
    });

    it("reports the last activity as updatedAt and orders by the last prompt", async () => {
        // "busy" got its last prompt first but the agent worked on after "fresh" got its prompt.
        const {agent} = await createAgent("sessionIndex", [
            createThread({id: "fresh", recencyAt: 500, updatedAt: 500}),
            createThread({id: "busy", recencyAt: 400, updatedAt: 1_000}),
        ]);

        const response = await agent.listSessions({cwd: "/repo/project"});

        expect(response.sessions.map(session => [
            session.sessionId,
            session.updatedAt,
            (session._meta as any).jetbrains.air.lastPromptAt,
        ])).toEqual([
            ["fresh", "1970-01-01T00:08:20.000Z", "1970-01-01T00:08:20.000Z"],
            ["busy", "1970-01-01T00:16:40.000Z", "1970-01-01T00:06:40.000Z"],
        ]);
    });

    it("validates limit: default for omitted or null, clamped integers, -32602 otherwise", async () => {
        const {agent, threadList} = await createAgent("sessionIndex");
        const list = (limit: unknown) => agent.listSessions({cwd: "/repo/project", _meta: {jetbrains: {air: {list: {limit}}}}});

        for (const limit of [undefined, null, 1, 100, 500]) {
            await list(limit);
        }
        for (const limit of ["10", 2.5, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, true, {}]) {
            await expect(list(limit)).rejects.toMatchObject({code: -32602});
        }

        expect(threadList.mock.calls.map(call => call[0].limit)).toEqual([50, 50, 1, 100, 100]);
    });

    it("never answers an empty page with a cursor", async () => {
        const {agent, threadList} = await createAgent("sessionIndex");
        threadList
            .mockResolvedValueOnce({data: [], nextCursor: "cursor-2", backwardsCursor: null})
            .mockResolvedValueOnce({data: [createThread()], nextCursor: "cursor-3", backwardsCursor: null});

        const response = await agent.listSessions({cwd: "/repo/project"});

        expect(response.sessions.map(session => session.sessionId)).toEqual([threadId]);
        expect(response.nextCursor).not.toBeNull();
        expect(threadList.mock.calls.map(call => call[0].cursor)).toEqual([null, "cursor-2"]);

        threadList.mockResolvedValueOnce({data: [createThread({id: otherThreadId, recencyAt: 200})], nextCursor: null, backwardsCursor: null});
        const next = await agent.listSessions({cwd: "/repo/project", cursor: response.nextCursor ?? null});
        expect(next).toMatchObject({sessions: [{sessionId: otherThreadId}], nextCursor: null});
        expect(threadList.mock.calls[2]?.[0].cursor).toBe("cursor-3");
    });

    it("keeps reading while Codex answers empty pages with an advancing cursor", async () => {
        const {agent, threadList} = await createAgent("sessionIndex");
        for (let page = 1; page <= 15; page++) {
            threadList.mockResolvedValueOnce({data: [], nextCursor: `cursor-${page}`, backwardsCursor: null});
        }
        threadList.mockResolvedValueOnce({data: [createThread()], nextCursor: "cursor-last", backwardsCursor: null});

        const response = await agent.listSessions({cwd: "/repo/project"});

        expect(response.sessions.map(session => session.sessionId)).toEqual([threadId]);
        expect(response.nextCursor).not.toBeNull();
        expect(threadList).toHaveBeenCalledTimes(16);
    });

    it("ends the list when Codex repeats a cursor of empty pages", async () => {
        const {agent, threadList} = await createAgent("sessionIndex");
        threadList
            .mockResolvedValueOnce({data: [], nextCursor: "cursor-1", backwardsCursor: null})
            .mockResolvedValueOnce({data: [], nextCursor: "cursor-2", backwardsCursor: null})
            .mockResolvedValueOnce({data: [], nextCursor: "cursor-1", backwardsCursor: null});

        await expect(agent.listSessions({cwd: "/repo/project"})).resolves.toEqual({sessions: [], nextCursor: null});
        expect(threadList).toHaveBeenCalledTimes(3);
    });

    it("filters a relative cwd by basename and keeps the list options", async () => {
        const {agent, threadList} = await createAgent("sessionIndex");
        const page = (data: Thread[], nextCursor: string | null): ThreadListResponse => ({data, nextCursor, backwardsCursor: null});
        threadList
            .mockResolvedValueOnce(page([createThread({id: "other", cwd: "/repo/other"})], "cursor-2"))
            .mockResolvedValueOnce(page([
                createThread({id: "match", cwd: "/elsewhere/project"}),
                createThread({id: "miss", cwd: "/repo/other"}),
            ], null));

        const response = await agent.listSessions({
            cwd: "project",
            _meta: {jetbrains: {air: {list: {limit: 10, archived: "unarchived"}}}},
        });

        expect(response.sessions.map(session => session.sessionId)).toEqual(["match"]);
        expect(response.nextCursor).toBeNull();
        expect(threadList.mock.calls.map(call => call[0])).toEqual([null, "cursor-2"].map(cursor => ({
            cursor,
            limit: 100,
            sortKey: "recency_at",
            archived: false,
            sourceKinds: [],
            modelProviders: [],
            useStateDbOnly: true,
        })));
    });

    it("fills a relative cwd page from several Codex pages, cut to the limit, and continues inside a Codex page", async () => {
        const {agent, threadList} = await createAgent("sessionIndex");
        const rows = ["a", "b", "c"].map(id => createThread({id, cwd: `/repo/${id}/project`}));
        threadList.mockResolvedValue({data: rows, nextCursor: "codex-2", backwardsCursor: null});
        const list = (cursor: string | null) => agent.listSessions({cwd: "project", cursor, _meta: {jetbrains: {air: {list: {limit: 2}}}}});

        const first = await list(null);
        threadList.mockResolvedValueOnce({data: rows, nextCursor: "codex-2", backwardsCursor: null})
            .mockResolvedValueOnce({data: [createThread({id: "d", cwd: "/repo/d/project"})], nextCursor: null, backwardsCursor: null});
        const second = await list(first.nextCursor ?? null);

        expect([first, second].map(page => page.sessions.map(session => session.sessionId))).toEqual([["a", "b"], ["c", "d"]]);
        expect(second.nextCursor).toBeNull();
        expect(threadList.mock.calls.map(call => call[0].cursor)).toEqual([null, null, "codex-2"]);
    });

    it("filters the archived Codex list for a relative cwd with archived: \"archived\"", async () => {
        const {agent, threadList} = await createAgent("sessionIndex");
        threadList.mockImplementation(async (params) => ({
            data: params.archived
                ? [createThread({id: "a1", cwd: "/x/project", recencyAt: 30}), createThread({id: "miss", cwd: "/x/other", recencyAt: 20}), createThread({id: "a2", cwd: "/y/project", recencyAt: 10})]
                : [createThread({id: "u1", cwd: "/x/project", recencyAt: 40})],
            nextCursor: null,
            backwardsCursor: null,
        }));
        const list = (cursor: string | null) => agent.listSessions({cwd: "project", cursor, _meta: {jetbrains: {air: {list: {limit: 1, archived: "archived"}}}}});

        const first = await list(null);
        const second = await list(first.nextCursor ?? null);

        expect([first, second].map(page => page.sessions.map(session => [session.sessionId, (session._meta as any).jetbrains.air.archived])))
            .toEqual([[["a1", true]], [["a2", true]]]);
        expect(second.nextCursor).toBeNull();
        expect(threadList.mock.calls.every(call => call[0].archived === true)).toBe(true);
    });

    it("continues a relative cwd list after its last row when rows come or go in between", async () => {
        const {agent, threadList} = await createAgent("sessionIndex");
        const row = (id: string, recencyAt: number) => createThread({id, cwd: `/repo/${id}/project`, recencyAt});
        const [a, b, c, d] = [row("a", 40), row("b", 30), row("c", 20), row("d", 10)];
        const list = (cursor: string | null) => agent.listSessions({cwd: "project", cursor, _meta: {jetbrains: {air: {list: {limit: 2}}}}});
        const ids = (response: acp.ListSessionsResponse) => response.sessions.map(session => session.sessionId);
        threadList.mockResolvedValueOnce({data: [a, b, c, d], nextCursor: null, backwardsCursor: null});
        const first = await list(null);

        threadList.mockResolvedValueOnce({data: [b, c, d], nextCursor: null, backwardsCursor: null});
        const afterArchive = await list(first.nextCursor ?? null);
        threadList.mockResolvedValueOnce({data: [row("new", 50), a, b, c, d], nextCursor: null, backwardsCursor: null});
        const afterInsert = await list(first.nextCursor ?? null);

        expect([ids(first), ids(afterArchive), ids(afterInsert)]).toEqual([["a", "b"], ["c", "d"], ["c", "d"]]);
    });

    it("rejects a cursor that the adapter did not write for this kind of list", async () => {
        const {agent} = await createAgent("sessionIndex");
        const filteredCursor = (await (async () => {
            const {agent: other, threadList} = await createAgent("sessionIndex");
            threadList.mockResolvedValueOnce({
                data: [createThread({id: "a", cwd: "/x/project"}), createThread({id: "b", cwd: "/y/project"})],
                nextCursor: null,
                backwardsCursor: null,
            });
            return (await other.listSessions({cwd: "project", _meta: {jetbrains: {air: {list: {limit: 1}}}}})).nextCursor;
        })())!;

        const listMeta = (list: Record<string, unknown>) => ({_meta: {jetbrains: {air: {list}}}});
        await expect(agent.listSessions({cwd: "project", cursor: "air-list:not-json"})).rejects.toMatchObject({code: -32602});
        await expect(agent.listSessions({cwd: "project", cursor: "air-list:WzEsMl0"})).rejects.toMatchObject({code: -32602});
        await expect(agent.listSessions({cwd: "/repo/project", cursor: "codex-cursor"})).rejects.toMatchObject({code: -32602});
        await expect(agent.listSessions({cwd: "/repo/project", cursor: filteredCursor})).rejects.toMatchObject({code: -32602});
        for (const archived of ["archived", "all"]) {
            await expect(agent.listSessions({cwd: "project", cursor: filteredCursor, ...listMeta({archived})}))
                .rejects.toMatchObject({code: -32602});
        }
        await expect(agent.listSessions({cwd: "project", cursor: filteredCursor, ...listMeta({includeWorktrees: true})}))
            .rejects.toMatchObject({code: -32602});
        await expect(agent.listSessions({cwd: "project", cursor: filteredCursor})).resolves.toBeDefined();
        await expect(agent.listSessions({cwd: "project", cursor: filteredCursor, ...listMeta({archived: "unarchived"})})).resolves.toBeDefined();
    });

    it("records the turn end only for the sessions of this connection and forgets a deleted thread", async () => {
        const {fixture, agent} = await createAgent("sessionIndex", [
            createThread({id: threadId}),
            createThread({id: "ephemeral-title-thread"}),
        ]);
        await openLocalSession(fixture, threadId);
        const completed = (id: string) => fixture.sendServerNotification({
            method: "turn/completed",
            params: {threadId: id, turn: {id: "turn-1", items: [], itemsView: "notLoaded", status: "completed", error: null, startedAt: 400, completedAt: 500, durationMs: 100000}},
        });
        const activities = async () => (await agent.listSessions({cwd: "/repo/project"})).sessions
            .map(session => (session._meta as any)?.jetbrains?.air?.lastTurnEndedAt ?? null);
        completed(threadId);
        completed("ephemeral-title-thread");

        expect(await activities()).toEqual(["1970-01-01T00:08:20.000Z", null]);
        fixture.sendServerNotification({method: "thread/deleted", params: {threadId}});
        expect(await activities()).toEqual([null, null]);
    });

    it("stops a scan at its page budget with a cursor the client can continue from", async () => {
        const {agent, threadList} = await createAgent("sessionIndex");
        let page = 0;
        threadList.mockImplementation(async () => {
            page++;
            return page === 70
                ? {data: [createThread({cwd: "/repo/project"})], nextCursor: null, backwardsCursor: null}
                : {data: [createThread({cwd: "/repo/other"})], nextCursor: `codex-${page}`, backwardsCursor: null};
        });

        const first = await agent.listSessions({cwd: "project"});
        expect(first).toEqual({sessions: [], nextCursor: expect.any(String)});
        expect(threadList).toHaveBeenCalledTimes(50);

        const second = await agent.listSessions({cwd: "project", cursor: first.nextCursor ?? null});
        expect(second.sessions.map(session => session.sessionId)).toEqual([threadId]);
        expect(second.nextCursor).toBeNull();
        expect(threadList).toHaveBeenCalledTimes(70);
    });

    it("does not check the login for a sessionIndex client", async () => {
        const {agent, readAuthRequirement} = await createAgent("sessionIndex");
        readAuthRequirement.mockResolvedValue({required: true, account: null});

        await expect(agent.listSessions({cwd: "/repo/project"})).resolves.toMatchObject({sessions: [{sessionId: threadId}]});
        expect(readAuthRequirement).not.toHaveBeenCalled();
    });

    it("still requires the login for a client without sessionIndex", async () => {
        const {agent, readAuthRequirement} = await createAgent("airWithoutSessionIndex");
        readAuthRequirement.mockResolvedValue({required: true, account: null});

        await expect(agent.listSessions({cwd: "/repo/project"})).rejects.toMatchObject({code: acp.RequestError.authRequired().code});
    });
});

describe("_session/list/subscribe", () => {
    it("validates the cwd: required, a string and absolute", async () => {
        const {agent} = await createAgent("sessionIndex");
        for (const params of [{}, {cwd: null}, {cwd: 42}, {cwd: "project"}, {cwd: ""}]) {
            await expect(agent.sessionIndex.subscribeList(params)).rejects.toMatchObject({code: -32602});
        }
        expect(() => agent.sessionIndex.unsubscribeList({})).toThrow(expect.objectContaining({code: -32602}));
        expect(agent.sessionIndex.subscriptionResources()).toMatchObject({subscriptions: 0, watching: false});
    });

    it("sends the full row of an own thread that changed, and nothing after unsubscribe", async () => {
        vi.useFakeTimers();
        const {fixture, agent, appServer} = await createAgent("sessionIndex");
        const {subscriptionId} = await agent.sessionIndex.subscribeList({cwd: "/repo/project"});
        fixture.clearAcpConnectionDump();
        const running = createThread({
            status: {type: "active", activeFlags: []},
            recencyAt: 400,
            updatedAt: 400,
            path: "/codex-home/sessions/rollout.jsonl",
        });
        const threadRead = vi.spyOn(appServer, "threadRead").mockResolvedValue({thread: running});

        fixture.sendServerNotification({method: "thread/status/changed", params: {threadId, status: {type: "active", activeFlags: []}}});
        await vi.advanceTimersByTimeAsync(100);

        expect(threadRead).toHaveBeenCalledWith({threadId});
        vi.mocked(appServer.threadList).mockResolvedValue({data: [running], nextCursor: null, backwardsCursor: null});
        const listed = await agent.listSessions({cwd: "/repo/project"});
        expect(listChanges(fixture)).toEqual([{subscriptionId, sessions: listed.sessions, removed: []}]);

        expect(agent.sessionIndex.unsubscribeList({subscriptionId})).toEqual({});
        expect(agent.sessionIndex.unsubscribeList({subscriptionId})).toEqual({});
        fixture.clearAcpConnectionDump();
        fixture.sendServerNotification({method: "thread/status/changed", params: {threadId, status: {type: "idle"}}});
        await vi.advanceTimersByTimeAsync(2_000);
        expect(listChanges(fixture)).toEqual([]);
        expect(agent.sessionIndex.subscriptionResources()).toEqual({subscriptions: 0, groups: 0, watching: false, timer: false});
    });

    it("sends the uncut title of a changed row, by the same chain as the list", async () => {
        vi.useFakeTimers();
        const {fixture, agent, appServer} = await createAgent("sessionIndex");
        const {subscriptionId} = await agent.sessionIndex.subscribeList({cwd: "/repo/project"});
        fixture.clearAcpConnectionDump();
        const name = `Renamed ${"y".repeat(MAX_SESSION_TITLE_LENGTH)}`;
        const renamed = createThread({name, path: "/codex-home/sessions/rollout.jsonl"});
        vi.spyOn(appServer, "threadRead").mockResolvedValue({thread: renamed});

        fixture.sendServerNotification({method: "thread/name/updated", params: {threadId, threadName: name}});
        await vi.advanceTimersByTimeAsync(100);

        expect(listChanges(fixture)).toEqual([{
            subscriptionId,
            sessions: [expect.objectContaining({sessionId: threadId, title: name})],
            removed: [],
        }]);
        agent.sessionIndex.dispose();
    });

    it("sends removed for a thread that the client deletes", async () => {
        vi.useFakeTimers();
        const {fixture, agent, appServer} = await createAgent("sessionIndex");
        const {subscriptionId} = await agent.sessionIndex.subscribeList({cwd: "/repo/project"});
        vi.spyOn(appServer, "threadDelete").mockImplementation(async () => {
            fixture.sendServerNotification({method: "thread/deleted", params: {threadId}});
            return {};
        });
        fixture.clearAcpConnectionDump();

        await agent.deleteSession({sessionId: threadId});
        await vi.advanceTimersByTimeAsync(100);

        expect(listChanges(fixture)).toEqual([{subscriptionId, sessions: [], removed: [threadId]}]);
        agent.sessionIndex.dispose();
    });

    it("delivers the fork parent read from the rollout, after a first row without it", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-acp-fork-"));
        try {
            const parent = "01a0637c-5b99-7242-9064-04545d605fdd";
            const rollout = path.join(dir, "rollout.jsonl");
            fs.writeFileSync(rollout, `${JSON.stringify({type: "session_meta", payload: {id: threadId, forked_from_id: parent}})}\n`);
            // As `thread/list` answers it: no forkedFromId.
            const listed = createThread({path: rollout});
            const {fixture, agent, threadList, appServer} = await createAgent("sessionIndex", [listed]);
            threadList.mockImplementation(async (params) => ({data: params.archived ? [] : [listed], nextCursor: null, backwardsCursor: null}));
            vi.spyOn(appServer, "threadRead").mockResolvedValue({thread: listed});
            const {subscriptionId} = await agent.sessionIndex.subscribeList({cwd: "/repo/project"});

            const first = await agent.listSessions({cwd: "/repo/project"});
            expect((first.sessions[0]!._meta as any).jetbrains.air.forkedFrom).toBeUndefined();

            await vi.waitFor(() => expect(listChanges(fixture)).toEqual([{
                subscriptionId,
                sessions: [expect.objectContaining({sessionId: threadId, _meta: {jetbrains: {air: expect.objectContaining({forkedFrom: parent})}}})],
                removed: [],
            }]));
            const page = await agent.listSessions({cwd: "/repo/project"});
            expect(page.sessions[0]!._meta).toMatchObject({jetbrains: {air: {forkedFrom: parent}}});
            agent.sessionIndex.dispose();
        } finally {
            fs.rmSync(dir, {recursive: true, force: true});
        }
    });

    it("covers the canonical path of a cwd outside a Git checkout", async () => {
        const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-acp-scope-")));
        try {
            const link = `${dir}-link`;
            fs.symlinkSync(dir, link);
            vi.useFakeTimers();
            const {fixture, agent, appServer} = await createAgent("sessionIndex");
            await agent.sessionIndex.subscribeList({cwd: link});
            vi.spyOn(appServer, "threadRead").mockResolvedValue({thread: createThread({cwd: dir, path: `${dir}/rollout.jsonl`})});

            fixture.sendServerNotification({method: "thread/name/updated", params: {threadId}} as never);
            await vi.advanceTimersByTimeAsync(100);

            expect(listChanges(fixture).flatMap(changes => changes.sessions.map((row: acp.SessionInfo) => row.cwd))).toEqual([dir]);
            agent.sessionIndex.dispose();
            fs.rmSync(link);
        } finally {
            fs.rmSync(dir, {recursive: true, force: true});
        }
    });

    it("leaves no subscription, watch or timer when the connection closes", async () => {
        vi.useFakeTimers();
        const {fixture, agent} = await createAgent("sessionIndex");
        await agent.sessionIndex.subscribeList({cwd: "/repo/project"});
        await agent.sessionIndex.subscribeList({cwd: "/repo/other"});
        fixture.sendServerNotification({method: "turn/started", params: {threadId, turn: {}}} as never);

        agent.sessionIndex.dispose();

        expect(agent.sessionIndex.subscriptionResources()).toEqual({subscriptions: 0, groups: 0, watching: false, timer: false});
        await expect(agent.sessionIndex.subscribeList({cwd: "/repo/project"})).rejects.toBeDefined();
    });
});

describe("_session/rename", () => {
    it("renames a thread that is not loaded", async () => {
        const {agent, appServer} = await createAgent("sessionIndex");
        const threadSetName = vi.spyOn(appServer, "threadSetName").mockResolvedValue({});

        await expect(agent.sessionIndex.rename({sessionId: threadId, title: `  New\n title ${"x".repeat(300)}`})).resolves.toEqual({});

        const name = threadSetName.mock.calls[0]?.[0].name ?? "";
        expect(name.startsWith("New title x")).toBe(true);
        expect(name).toHaveLength(256);
        expect(name.endsWith("…")).toBe(true);
    });

    it("rejects a blank title", async () => {
        const {agent, appServer} = await createAgent("sessionIndex");
        const threadSetName = vi.spyOn(appServer, "threadSetName");

        await expect(agent.sessionIndex.rename({sessionId: threadId, title: " \n "}))
            .rejects.toMatchObject({code: -32602});
        expect(threadSetName).not.toHaveBeenCalled();
    });

    it("sends the title of a loaded session and stops its automatic title", async () => {
        const {fixture, agent, appServer} = await createAgent("sessionIndex");
        await openLocalSession(fixture, threadId);
        vi.spyOn(appServer, "threadSetName").mockResolvedValue({});

        await agent.sessionIndex.rename({sessionId: threadId, title: "Renamed"});

        expect(agent.getSessionState(threadId).sessionTitleSource).toBe("explicit");
        const titleUpdates = fixture.getAcpConnectionEvents([])
            .filter(event => event.method === "sessionUpdate" && event.args[0].update.sessionUpdate === "session_info_update");
        expect(titleUpdates).toEqual([{
            method: "sessionUpdate",
            args: [{sessionId: threadId, update: {sessionUpdate: "session_info_update", title: "Renamed"}}],
        }]);
    });

    it("writes an explicit title after an automatic title that Codex is still writing", async () => {
        vi.useFakeTimers();
        const {fixture, agent, appServer} = await createAgent("sessionIndex");
        await openLocalSession(fixture, threadId);
        vi.spyOn(appServer, "threadStart").mockResolvedValue({thread: {id: "ephemeral"}} as never);
        vi.spyOn(appServer, "runTurn").mockResolvedValue({
            turn: {items: [{type: "agentMessage", text: JSON.stringify({title: "Automatic"})}]},
        } as never);
        const automaticWrite = deferred<void>();
        const started: string[] = [];
        const applied: string[] = [];
        vi.spyOn(appServer, "threadSetName").mockImplementation(async ({name}) => {
            started.push(name);
            if (name === "Automatic") await automaticWrite.promise;
            applied.push(name);
            return {};
        });
        agent.getSessionState(threadId).titleGen!.onTurnCompleted("Fix the build");
        await vi.advanceTimersByTimeAsync(0);
        expect(started).toEqual(["Automatic"]);

        const rename = agent.sessionIndex.rename({sessionId: threadId, title: "Explicit"});
        // Longer than any wait for the automatic title: only its completion lets the rename go.
        await vi.advanceTimersByTimeAsync(30_000);
        expect(started).toEqual(["Automatic"]);
        expect(agent.getSessionState(threadId).automaticTitleEcho).toBe("Automatic");
        automaticWrite.resolve();
        await rename;

        expect(applied).toEqual(["Automatic", "Explicit"]);
    });

    it("skips an automatic title that is generated after an explicit rename", async () => {
        const {fixture, agent, appServer} = await createAgent("sessionIndex");
        await openLocalSession(fixture, threadId);
        const turn = deferred<unknown>();
        vi.spyOn(appServer, "threadStart").mockResolvedValue({thread: {id: "ephemeral"}} as never);
        vi.spyOn(appServer, "runTurn").mockReturnValue(turn.promise as never);
        const threadSetName = vi.spyOn(appServer, "threadSetName").mockResolvedValue({});
        const titleGen = agent.getSessionState(threadId).titleGen!;
        titleGen.onTurnCompleted("Fix the build");

        await agent.sessionIndex.rename({sessionId: threadId, title: "Explicit"});
        turn.resolve({turn: {items: [{type: "agentMessage", text: JSON.stringify({title: "Automatic"})}]}});
        await titleGen.waitForIdle(1_000);

        expect(threadSetName.mock.calls.map(call => call[0].name)).toEqual(["Explicit"]);
    });

    it("skips the automatic title of a session that was closed before its rename", async () => {
        const {fixture, agent, appServer} = await createAgent("sessionIndex");
        await openLocalSession(fixture, threadId);
        vi.spyOn(appServer, "threadUnsubscribe").mockResolvedValue({status: "unsubscribed"});
        const turn = deferred<unknown>();
        vi.spyOn(appServer, "threadStart").mockResolvedValue({thread: {id: "ephemeral"}} as never);
        vi.spyOn(appServer, "runTurn").mockReturnValue(turn.promise as never);
        const threadSetName = vi.spyOn(appServer, "threadSetName").mockResolvedValue({});
        const titleGen = agent.getSessionState(threadId).titleGen!;
        titleGen.onTurnCompleted("Fix the build");

        await agent.closeSession({sessionId: threadId});
        await agent.sessionIndex.rename({sessionId: threadId, title: "Explicit"});
        turn.resolve({turn: {items: [{type: "agentMessage", text: JSON.stringify({title: "Automatic"})}]}});
        await titleGen.waitForIdle(1_000);

        expect(threadSetName.mock.calls.map(call => call[0].name)).toEqual(["Explicit"]);
    });

    it("keeps the automatic title after a rename that failed", async () => {
        const {fixture, agent, appServer} = await createAgent("sessionIndex");
        await openLocalSession(fixture, threadId);
        vi.spyOn(appServer, "threadStart").mockResolvedValue({thread: {id: "ephemeral"}} as never);
        vi.spyOn(appServer, "runTurn").mockResolvedValue({
            turn: {items: [{type: "agentMessage", text: JSON.stringify({title: "Automatic"})}]},
        } as never);
        const threadSetName = vi.spyOn(appServer, "threadSetName")
            .mockRejectedValueOnce(new Error("app-server busy"))
            .mockResolvedValue({});

        await expect(agent.sessionIndex.rename({sessionId: threadId, title: "Explicit"})).rejects.toThrow("app-server busy");
        const titleGen = agent.getSessionState(threadId).titleGen!;
        titleGen.onTurnCompleted("Fix the build");
        await vi.waitFor(() => expect(threadSetName.mock.calls.map(call => call[0].name)).toEqual(["Explicit", "Automatic"]));
    });

    it("generates the automatic title again after a rename that failed while it was generated", async () => {
        const {fixture, agent, appServer} = await createAgent("sessionIndex");
        await openLocalSession(fixture, threadId);
        const turn = deferred<unknown>();
        vi.spyOn(appServer, "threadStart").mockResolvedValue({thread: {id: "ephemeral"}} as never);
        const titleTurn = {turn: {items: [{type: "agentMessage", text: JSON.stringify({title: "Automatic"})}]}};
        vi.spyOn(appServer, "runTurn").mockReturnValueOnce(turn.promise as never).mockResolvedValue(titleTurn as never);
        const renameWrite = deferred<Record<string, never>>();
        const threadSetName = vi.spyOn(appServer, "threadSetName")
            .mockReturnValueOnce(renameWrite.promise)
            .mockResolvedValue({});
        const titleGen = agent.getSessionState(threadId).titleGen!;
        titleGen.onTurnCompleted("Fix the build");

        const rename = agent.sessionIndex.rename({sessionId: threadId, title: "Explicit"});
        turn.resolve(titleTurn);
        await titleGen.waitForIdle(1_000);
        renameWrite.reject(new Error("app-server busy"));
        await expect(rename).rejects.toThrow("app-server busy");

        titleGen.onTurnCompleted("Fix the build");
        await vi.waitFor(() => expect(threadSetName.mock.calls.map(call => call[0].name)).toEqual(["Explicit", "Automatic"]));
    });

    it("answers the archived reason for an archived thread and does not unarchive it", async () => {
        const {agent, appServer, client} = await createAgent("sessionIndex");
        vi.spyOn(client, "getHomePath").mockReturnValue("/home/user/.codex");
        vi.spyOn(appServer, "threadSetName").mockRejectedValue(missingRolloutError());
        const threadRead = vi.spyOn(appServer, "threadRead")
            .mockResolvedValueOnce({thread: createThread({path: "/home/user/.codex/archived_sessions/rollout-1.jsonl"})} as never)
            .mockRejectedValueOnce(missingRolloutError());
        const threadUnarchive = vi.spyOn(appServer, "threadUnarchive");

        await expect(agent.sessionIndex.rename({sessionId: threadId, title: "A"}))
            .rejects.toMatchObject({code: -32600, data: {reason: "archived", sessionId: threadId}});
        await expect(agent.sessionIndex.rename({sessionId: threadId, title: "A"}))
            .rejects.toMatchObject({code: -32002, data: {sessionId: threadId}});
        expect(threadRead).toHaveBeenCalledTimes(2);
        expect(threadUnarchive).not.toHaveBeenCalled();
    });

    it("maps an unknown thread to -32002 and a held thread to thread_active_writer", async () => {
        const {agent, appServer} = await createAgent("sessionIndex");
        vi.spyOn(appServer, "threadSetName")
            .mockRejectedValueOnce(Object.assign(new Error(`thread not found: ${threadId}`), {code: -32600}))
            .mockRejectedValueOnce(ACTIVE_WRITER);

        await expect(agent.sessionIndex.rename({sessionId: threadId, title: "A"})).rejects.toMatchObject({code: -32002});
        await expect(agent.sessionIndex.rename({sessionId: threadId, title: "A"}))
            .rejects.toMatchObject({code: -32600, data: {reason: "thread_active_writer"}});
    });

    it("is not available without sessionIndex", async () => {
        const {agent} = await createAgent("airWithoutSessionIndex");

        await expect(agent.sessionIndex.rename({sessionId: threadId, title: "A"})).rejects.toMatchObject({code: -32601});
        await expect(agent.sessionIndex.setArchived({sessionId: threadId}, true)).rejects.toMatchObject({code: -32601});
        await expect(agent.sessionIndex.setArchived({sessionId: threadId}, false)).rejects.toMatchObject({code: -32601});
    });
});

describe("_session/archive and _session/unarchive", () => {
    const codexHome = "/home/user/.codex";
    const missingRollout = (id: string) => Object.assign(new Error(`no rollout found for thread id ${id}`), {code: -32600});
    const missingArchivedRollout = (id: string) => Object.assign(new Error(`no archived rollout found for thread id ${id}`), {code: -32600});

    async function createArchiveAgent() {
        const created = await createAgent("sessionIndex");
        vi.spyOn(created.client, "getHomePath").mockReturnValue(codexHome);
        const threadArchive = vi.spyOn(created.appServer, "threadArchive").mockResolvedValue({});
        const threadUnarchive = vi.spyOn(created.appServer, "threadUnarchive").mockResolvedValue({thread: createThread()});
        const threadRead = vi.spyOn(created.appServer, "threadRead");
        return {...created, threadArchive, threadUnarchive, threadRead};
    }

    it("archives and unarchives a thread that is not loaded", async () => {
        const {agent, threadArchive, threadUnarchive, threadRead} = await createArchiveAgent();

        await expect(agent.sessionIndex.setArchived({sessionId: threadId}, true)).resolves.toEqual({});
        await expect(agent.sessionIndex.setArchived({sessionId: threadId}, false)).resolves.toEqual({});

        expect(threadArchive).toHaveBeenCalledWith({threadId});
        expect(threadUnarchive).toHaveBeenCalledWith({threadId});
        expect(threadRead).not.toHaveBeenCalled();
    });

    it("succeeds when the thread already is in the requested state", async () => {
        const {agent, threadArchive, threadUnarchive, threadRead} = await createArchiveAgent();
        threadArchive.mockRejectedValue(missingRollout(threadId));
        threadUnarchive.mockRejectedValue(missingArchivedRollout(threadId));
        threadRead
            .mockResolvedValueOnce({thread: createThread({path: `${codexHome}/archived_sessions/rollout-1.jsonl`})} as never)
            .mockResolvedValueOnce({thread: createThread({path: `${codexHome}/sessions/2026/10/07/rollout-1.jsonl`})} as never);

        await expect(agent.sessionIndex.setArchived({sessionId: threadId}, true)).resolves.toEqual({});
        await expect(agent.sessionIndex.setArchived({sessionId: threadId}, false)).resolves.toEqual({});
    });

    it("answers -32002 when Codex finds no rollout of a thread that thread/read shows", async () => {
        const {agent, threadArchive, threadRead} = await createArchiveAgent();
        threadArchive.mockRejectedValue(missingRollout(threadId));
        threadRead
            .mockResolvedValueOnce({thread: createThread({path: `${codexHome}/sessions/rollout-1.jsonl`})} as never)
            .mockResolvedValueOnce({thread: createThread({path: null})} as never);

        await expect(agent.sessionIndex.setArchived({sessionId: threadId}, true)).rejects.toMatchObject({code: -32002, data: {sessionId: threadId}});
        await expect(agent.sessionIndex.setArchived({sessionId: threadId}, true)).rejects.toMatchObject({code: -32002, data: {sessionId: threadId}});
    });

    it("answers -32002 for a thread Codex does not have", async () => {
        const {agent, threadArchive, threadUnarchive, threadRead} = await createArchiveAgent();
        threadArchive.mockRejectedValue(missingRollout(threadId));
        threadUnarchive.mockRejectedValueOnce(Object.assign(new Error("invalid session id: bad"), {code: -32600}));
        threadRead.mockRejectedValue(missingRollout(threadId));

        await expect(agent.sessionIndex.setArchived({sessionId: threadId}, true)).rejects.toMatchObject({code: -32002, data: {sessionId: threadId}});
        await expect(agent.sessionIndex.setArchived({sessionId: "not-a-thread"}, false)).rejects.toMatchObject({code: -32002});
    });

    it("answers thread_active_writer for a thread another process holds", async () => {
        const {agent, threadArchive, threadUnarchive} = await createArchiveAgent();
        threadArchive.mockRejectedValue(ACTIVE_WRITER);
        threadUnarchive.mockRejectedValue(ACTIVE_WRITER);

        await expect(agent.sessionIndex.setArchived({sessionId: threadId}, true)).rejects.toMatchObject({data: {reason: "thread_active_writer", threadId}});
        await expect(agent.sessionIndex.setArchived({sessionId: threadId}, false)).rejects.toMatchObject({data: {reason: "thread_active_writer", threadId}});
    });

    it("stops a session that is open here: ends its turn, closes it, then archives the thread", async () => {
        const {fixture, agent, appServer, threadArchive, threadUnarchive} = await createArchiveAgent();
        await openLocalSession(fixture, threadId);
        agent.getSessionState(threadId).currentTurnId = "turn-id";
        const order: string[] = [];
        vi.spyOn(appServer, "turnInterrupt").mockImplementation(async () => {
            order.push("turn/interrupt");
            return {};
        });
        vi.spyOn(appServer, "threadUnsubscribe").mockImplementation(async () => {
            order.push("thread/unsubscribe");
            return {status: "unsubscribed"} as never;
        });
        threadArchive.mockImplementation(async () => {
            order.push("thread/archive");
            return {};
        });

        await expect(agent.sessionIndex.setArchived({sessionId: threadId}, true)).resolves.toEqual({});

        expect(order).toEqual(["turn/interrupt", "thread/unsubscribe", "thread/archive"]);
        expect(() => agent.getSessionState(threadId)).toThrow(`Session ${threadId} not found`);
        const infoUpdates = () => fixture.getAcpConnectionEvents([])
            .filter(event => event.method === "sessionUpdate" && event.args[0].update.sessionUpdate === "session_info_update");
        expect(infoUpdates()).toEqual([{
            method: "sessionUpdate",
            args: [{sessionId: threadId, update: {sessionUpdate: "session_info_update", _meta: {jetbrains: {air: {version: 1, archived: true}}}}}],
        }]);
        // A prompt fails as for a closed session.
        await expect(agent.prompt({sessionId: threadId, prompt: [{type: "text", text: "go on"}]}))
            .rejects.toThrow(`Session ${threadId} not found`);

        // Unarchive does not reopen it.
        fixture.clearAcpConnectionDump();
        await expect(agent.sessionIndex.setArchived({sessionId: threadId}, false)).resolves.toEqual({});
        expect(threadUnarchive).toHaveBeenCalledWith({threadId});
        expect(() => agent.getSessionState(threadId)).toThrow(`Session ${threadId} not found`);
        expect(infoUpdates()).toEqual([]);
    });

    it("unarchives a session that is open here and reports its archive state to it", async () => {
        const {fixture, agent, threadUnarchive} = await createArchiveAgent();
        await openLocalSession(fixture, threadId);

        await expect(agent.sessionIndex.setArchived({sessionId: threadId}, false)).resolves.toEqual({});

        expect(threadUnarchive).toHaveBeenCalledWith({threadId});
        expect(fixture.getAcpConnectionEvents([])
            .filter(event => event.method === "sessionUpdate" && event.args[0].update.sessionUpdate === "session_info_update")).toEqual([{
            method: "sessionUpdate",
            args: [{sessionId: threadId, update: {sessionUpdate: "session_info_update", _meta: {jetbrains: {air: {version: 1, archived: false}}}}}],
        }]);
    });

    it("sends no session update for a session that is not open here", async () => {
        const {fixture, agent} = await createArchiveAgent();

        await agent.sessionIndex.setArchived({sessionId: threadId}, true);
        await agent.sessionIndex.setArchived({sessionId: threadId}, false);

        expect(fixture.getAcpConnectionEvents([])
            .filter(event => event.method === "sessionUpdate" && event.args[0].update.sessionUpdate === "session_info_update")).toEqual([]);
    });

    it("runs the writes of a session one after another", async () => {
        const {agent, appServer, threadArchive} = await createArchiveAgent();
        const renameWrite = deferred<Record<string, never>>();
        const order: string[] = [];
        vi.spyOn(appServer, "threadSetName").mockImplementation(async () => {
            order.push("rename started");
            await renameWrite.promise;
            order.push("rename done");
            return {};
        });
        threadArchive.mockImplementation(async () => {
            order.push("archive");
            return {};
        });

        const rename = agent.sessionIndex.rename({sessionId: threadId, title: "Renamed"});
        const archive = agent.sessionIndex.setArchived({sessionId: threadId}, true);
        await vi.waitFor(() => expect(order).toEqual(["rename started"]));
        renameWrite.resolve({});
        await Promise.all([rename, archive]);

        expect(order).toEqual(["rename started", "rename done", "archive"]);
    });
});

describe("session/delete", () => {
    async function createDeleteAgent(kind: ClientKind) {
        const created = await createAgent(kind);
        const threadArchive = vi.spyOn(created.appServer, "threadArchive").mockResolvedValue({});
        const threadDelete = vi.spyOn(created.appServer, "threadDelete").mockResolvedValue({});
        return {...created, threadArchive, threadDelete};
    }

    it("deletes the thread for a sessionIndex client and archives it for other clients", async () => {
        const calls: Record<ClientKind, string[]> = {sessionIndex: [], airWithoutSessionIndex: [], plain: []};
        for (const kind of Object.keys(calls) as ClientKind[]) {
            const {agent, threadArchive, threadDelete} = await createDeleteAgent(kind);
            await expect(agent.deleteSession({sessionId: threadId})).resolves.toEqual({});
            calls[kind] = [
                ...threadArchive.mock.calls.map(() => "thread/archive"),
                ...threadDelete.mock.calls.map(() => "thread/delete"),
            ];
        }

        expect(calls).toEqual({
            sessionIndex: ["thread/delete"],
            airWithoutSessionIndex: ["thread/archive"],
            plain: ["thread/archive"],
        });
    });

    it("maps the errors of thread/delete for a sessionIndex client", async () => {
        const {agent, threadDelete} = await createDeleteAgent("sessionIndex");
        threadDelete
            .mockRejectedValueOnce(Object.assign(new Error(`thread not found: ${threadId}`), {code: -32600}))
            .mockRejectedValueOnce(ACTIVE_WRITER);

        await expect(agent.deleteSession({sessionId: threadId})).rejects.toMatchObject({code: -32002});
        await expect(agent.deleteSession({sessionId: threadId})).rejects.toMatchObject({data: {reason: "thread_active_writer"}});
    });

    it("keeps the idempotent delete of a client without sessionIndex", async () => {
        const {agent, threadArchive} = await createDeleteAgent("airWithoutSessionIndex");
        threadArchive.mockRejectedValue(missingRolloutError());

        await expect(agent.deleteSession({sessionId: threadId})).resolves.toEqual({});
    });

    it("closes a loaded session before it deletes the thread", async () => {
        const {fixture, agent, appServer, threadDelete} = await createDeleteAgent("sessionIndex");
        await openLocalSession(fixture, threadId);
        const order: string[] = [];
        vi.spyOn(appServer, "threadUnsubscribe").mockImplementation(async () => {
            order.push("thread/unsubscribe");
            return {status: "unsubscribed"};
        });
        threadDelete.mockImplementation(async () => {
            order.push("thread/delete");
            return {};
        });

        await expect(agent.deleteSession({sessionId: threadId})).resolves.toEqual({});

        expect(order).toEqual(["thread/unsubscribe", "thread/delete"]);
    });
});

function missingRolloutError(): Error {
    return Object.assign(new Error(`no rollout found for thread id ${threadId}`), {code: -32600});
}

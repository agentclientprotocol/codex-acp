import {afterEach, describe, expect, it, vi} from "vitest";
import * as acp from "@agentclientprotocol/sdk";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createCodexMockTestFixture, createTestModel, type CodexMockTestFixture} from "../acp-test-utils";
import type {Thread, ThreadListParams} from "../../app-server/v2";
import {SESSION_LIST_CHANGED_METHOD} from "../../SessionIndex";

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

function listChangedNotifications(fixture: CodexMockTestFixture): unknown[] {
    return fixture.getAcpConnectionEvents([])
        .filter(event => event.method === "notify" && event.args[0] === SESSION_LIST_CHANGED_METHOD)
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
            cursor: "cursor-1",
            _meta: {jetbrains: {air: {list: {limit: 500, archived: "only"}}}},
        });
        await agent.listSessions({cwd: null, _meta: {jetbrains: {air: {list: {limit: 0}}}}});

        await expect(`${JSON.stringify(threadList.mock.calls.map(call => call[0]), null, 2)}\n`)
            .toMatchFileSnapshot("data/session-index-list-params.json");
    });

    it("lists the sessions of every linked worktree of the cwd", async () => {
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

            const response = await agent.listSessions({cwd: repo});

            expect(threadList.mock.calls[0]?.[0].cwd).toEqual([repo, worktree]);
            expect(response.sessions[0]?.cwd).toBe(worktree);
        } finally {
            fs.rmSync(root, {recursive: true, force: true});
        }
    });

    it("maps the rows of a sessionIndex client, with the activity of own threads", async () => {
        const threads = [
            createThread({id: "running", status: {type: "active", activeFlags: []}, gitInfo: {sha: null, branch: "main", originUrl: null}}),
            createThread({id: "approval", status: {type: "active", activeFlags: ["waitingOnApproval"]}}),
            createThread({id: "input", status: {type: "active", activeFlags: ["waitingOnUserInput"]}}),
            createThread({id: "idle", status: {type: "idle"}, name: "Explicit name", recencyAt: null}),
            createThread({id: "foreign", status: {type: "notLoaded"}}),
            createThread({id: "broken", status: {type: "systemError"}}),
        ];
        const {fixture, agent} = await createAgent("sessionIndex", threads);
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

    it("never answers an empty page with a cursor", async () => {
        const {agent, threadList} = await createAgent("sessionIndex");
        threadList
            .mockResolvedValueOnce({data: [], nextCursor: "cursor-2", backwardsCursor: null})
            .mockResolvedValueOnce({data: [createThread()], nextCursor: "cursor-3", backwardsCursor: null});

        const response = await agent.listSessions({cwd: "/repo/project"});

        expect(response.sessions.map(session => session.sessionId)).toEqual([threadId]);
        expect(response.nextCursor).toBe("cursor-3");
        expect(threadList.mock.calls.map(call => call[0].cursor)).toEqual([null, "cursor-2"]);
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

describe("_session/list_changed", () => {
    it("notifies a sessionIndex client when page 1 of a listed cwd changes", async () => {
        vi.useFakeTimers();
        const {fixture, agent, threadList} = await createAgent("sessionIndex");
        await agent.listSessions({cwd: "/repo/project"});
        fixture.clearAcpConnectionDump();

        // An own notification that does not change the page sends nothing.
        fixture.sendServerNotification({method: "thread/status/changed", params: {threadId, status: {type: "notLoaded"}}});
        await vi.advanceTimersByTimeAsync(2_000);
        expect(listChangedNotifications(fixture)).toEqual([]);

        threadList.mockResolvedValue({
            data: [createThread({status: {type: "active", activeFlags: []}})],
            nextCursor: null,
            backwardsCursor: null,
        });
        fixture.sendServerNotification({method: "thread/status/changed", params: {threadId, status: {type: "active", activeFlags: []}}});
        await vi.advanceTimersByTimeAsync(2_000);

        expect(listChangedNotifications(fixture)).toEqual([{cwd: "/repo/project"}]);
        agent.dispose();
    });

    it("sends nothing to a client without sessionIndex", async () => {
        vi.useFakeTimers();
        const {fixture, agent, threadList} = await createAgent("airWithoutSessionIndex");
        await agent.listSessions({cwd: "/repo/project"});
        threadList.mockClear();
        threadList.mockResolvedValue({
            data: [createThread({status: {type: "active", activeFlags: []}})],
            nextCursor: null,
            backwardsCursor: null,
        });

        fixture.sendServerNotification({method: "thread/status/changed", params: {threadId, status: {type: "active", activeFlags: []}}});
        await vi.advanceTimersByTimeAsync(5_000);

        expect(threadList).not.toHaveBeenCalled();
        expect(listChangedNotifications(fixture)).toEqual([]);
    });
});

describe("_session/rename", () => {
    it("renames a thread that is not loaded", async () => {
        const {agent, appServer} = await createAgent("sessionIndex");
        const threadSetName = vi.spyOn(appServer, "threadSetName").mockResolvedValue({});

        await expect(agent.renameSessionIndexEntry({sessionId: threadId, title: `  New\n title ${"x".repeat(300)}`})).resolves.toEqual({});

        const name = threadSetName.mock.calls[0]?.[0].name ?? "";
        expect(name.startsWith("New title x")).toBe(true);
        expect(name).toHaveLength(256);
        expect(name.endsWith("…")).toBe(true);
    });

    it("rejects a blank title", async () => {
        const {agent, appServer} = await createAgent("sessionIndex");
        const threadSetName = vi.spyOn(appServer, "threadSetName");

        await expect(agent.renameSessionIndexEntry({sessionId: threadId, title: " \n "}))
            .rejects.toMatchObject({code: -32602});
        expect(threadSetName).not.toHaveBeenCalled();
    });

    it("sends the title of a loaded session and stops its automatic title", async () => {
        const {fixture, agent, appServer} = await createAgent("sessionIndex");
        await openLocalSession(fixture, threadId);
        vi.spyOn(appServer, "threadSetName").mockResolvedValue({});

        await agent.renameSessionIndexEntry({sessionId: threadId, title: "Renamed"});

        expect(agent.getSessionState(threadId).sessionTitleSource).toBe("explicit");
        const titleUpdates = fixture.getAcpConnectionEvents([])
            .filter(event => event.method === "sessionUpdate" && event.args[0].update.sessionUpdate === "session_info_update");
        expect(titleUpdates).toEqual([{
            method: "sessionUpdate",
            args: [{sessionId: threadId, update: {sessionUpdate: "session_info_update", title: "Renamed"}}],
        }]);
    });

    it("maps an unknown thread to -32002 and a held thread to thread_active_writer", async () => {
        const {agent, appServer} = await createAgent("sessionIndex");
        vi.spyOn(appServer, "threadSetName")
            .mockRejectedValueOnce(Object.assign(new Error(`thread not found: ${threadId}`), {code: -32600}))
            .mockRejectedValueOnce(ACTIVE_WRITER);

        await expect(agent.renameSessionIndexEntry({sessionId: threadId, title: "A"})).rejects.toMatchObject({code: -32002});
        await expect(agent.renameSessionIndexEntry({sessionId: threadId, title: "A"}))
            .rejects.toMatchObject({code: -32600, data: {reason: "thread_active_writer"}});
    });

    it("is not available without sessionIndex", async () => {
        const {agent} = await createAgent("airWithoutSessionIndex");

        await expect(agent.renameSessionIndexEntry({sessionId: threadId, title: "A"})).rejects.toMatchObject({code: -32601});
        await expect(agent.setSessionArchived({sessionId: threadId}, true)).rejects.toMatchObject({code: -32601});
        await expect(agent.setSessionArchived({sessionId: threadId}, false)).rejects.toMatchObject({code: -32601});
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

        await expect(agent.setSessionArchived({sessionId: threadId}, true)).resolves.toEqual({});
        await expect(agent.setSessionArchived({sessionId: threadId}, false)).resolves.toEqual({});

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

        await expect(agent.setSessionArchived({sessionId: threadId}, true)).resolves.toEqual({});
        await expect(agent.setSessionArchived({sessionId: threadId}, false)).resolves.toEqual({});
    });

    it("keeps the Codex error when the thread is in the other state", async () => {
        const {agent, threadArchive, threadRead} = await createArchiveAgent();
        threadArchive.mockRejectedValue(missingRollout(threadId));
        threadRead.mockResolvedValue({thread: createThread({path: `${codexHome}/sessions/rollout-1.jsonl`})} as never);

        await expect(agent.setSessionArchived({sessionId: threadId}, true)).rejects.toThrow(`no rollout found for thread id ${threadId}`);
    });

    it("answers -32002 for a thread Codex does not have", async () => {
        const {agent, threadArchive, threadUnarchive, threadRead} = await createArchiveAgent();
        threadArchive.mockRejectedValue(missingRollout(threadId));
        threadUnarchive.mockRejectedValueOnce(Object.assign(new Error("invalid session id: bad"), {code: -32600}));
        threadRead.mockRejectedValue(missingRollout(threadId));

        await expect(agent.setSessionArchived({sessionId: threadId}, true)).rejects.toMatchObject({code: -32002, data: {sessionId: threadId}});
        await expect(agent.setSessionArchived({sessionId: "not-a-thread"}, false)).rejects.toMatchObject({code: -32002});
    });

    it("answers thread_active_writer for a thread another process holds", async () => {
        const {agent, threadArchive, threadUnarchive} = await createArchiveAgent();
        threadArchive.mockRejectedValue(ACTIVE_WRITER);
        threadUnarchive.mockRejectedValue(ACTIVE_WRITER);

        await expect(agent.setSessionArchived({sessionId: threadId}, true)).rejects.toMatchObject({data: {reason: "thread_active_writer", threadId}});
        await expect(agent.setSessionArchived({sessionId: threadId}, false)).rejects.toMatchObject({data: {reason: "thread_active_writer", threadId}});
    });

    it("closes a loaded session before it archives the thread", async () => {
        const {fixture, agent, appServer, threadArchive} = await createArchiveAgent();
        await openLocalSession(fixture, threadId);
        const order: string[] = [];
        vi.spyOn(appServer, "threadUnsubscribe").mockImplementation(async () => {
            order.push("thread/unsubscribe");
            return {status: "unsubscribed"};
        });
        threadArchive.mockImplementation(async () => {
            order.push("thread/archive");
            return {};
        });

        await expect(agent.setSessionArchived({sessionId: threadId}, true)).resolves.toEqual({});

        expect(order).toEqual(["thread/unsubscribe", "thread/archive"]);
        expect(() => agent.getSessionState(threadId)).toThrow(`Session ${threadId} not found`);
    });

    it("counts a loaded session that Codex never persisted as archived", async () => {
        const {fixture, agent, threadArchive, threadRead} = await createArchiveAgent();
        await openLocalSession(fixture, otherThreadId);
        vi.spyOn(fixture.getCodexAppServerClient(), "threadUnsubscribe").mockResolvedValue({status: "unsubscribed"});
        threadArchive.mockRejectedValue(missingRollout(otherThreadId));
        threadRead.mockRejectedValue(missingRollout(otherThreadId));

        await expect(agent.setSessionArchived({sessionId: otherThreadId}, true)).resolves.toEqual({});
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

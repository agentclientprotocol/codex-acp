import {afterEach, describe, expect, it, vi} from "vitest";
import * as acp from "@agentclientprotocol/sdk/unstable";
import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createAcpAgentRouter} from "../../AcpAgentRouter";
import {CodexAcpServer} from "../../CodexAcpServer";
import {CodexAcpClient} from "../../CodexAcpClient";
import {CodexAppServerClient} from "../../CodexAppServerClient";
import {SESSION_BATCH_GET_METHOD} from "../../SessionIndex";
import {createMockConnections} from "./test-utils";
import {deferred} from "../acp-test-utils";
import type {Thread, ThreadItem} from "../../app-server/v2";

const cleanup: (() => void)[] = [];
afterEach(() => {
    vi.useRealTimers();
    cleanup.splice(0).reverse().forEach(dispose => dispose());
});

async function connect(version: 1 | 2, capabilities: string[]) {
    const mocks = createMockConnections();
    mocks.mockCodexConnection.sendRequest.mockImplementation(async (method: string, params: any) => {
        if (method === "initialize") return {};
        if (method === "thread/read") throw Object.assign(new Error(`invalid thread id: ${params.threadId}`), {code: -32600});
        return {};
    });
    const appServer = new CodexAppServerClient(mocks.mockCodexConnection);
    const client = new CodexAcpClient(appServer);
    vi.spyOn(client, "readAuthRequirement").mockResolvedValue({required: false, account: null});
    vi.spyOn(client, "getAgentConfiguredModelProvider").mockResolvedValue("openai");
    vi.spyOn(client, "getAccount").mockResolvedValue({account: null, userId: null, requiresOpenaiAuth: false});
    const router = createAcpAgentRouter(connection => new CodexAcpServer(connection, client));
    const incoming = new TransformStream<Uint8Array, Uint8Array>();
    const outgoing = new TransformStream<Uint8Array, Uint8Array>();
    router.connect(acp.ndJsonStream(outgoing.writable, incoming.readable));
    const protocol = version === 1 ? acp : acpV2;
    const connection = protocol.client({name: "batch-test"}).connect(acp.ndJsonStream(incoming.writable, outgoing.readable));
    cleanup.push(() => connection.close());
    // The extension and response shape are identical on both ACP protocol versions.
    const request = (method: string, params?: unknown, options?: {cancellationSignal?: AbortSignal}) =>
        (connection.agent.request as any)(method, params, options);
    const air = {_meta: {jetbrains: {air: {version: 1, capabilities}}}};
    const initialize = await request("initialize", version === 1
        ? {protocolVersion: 1, clientCapabilities: air}
        : {protocolVersion: 2, info: {name: "batch-test", version: "1"}, capabilities: air});
    mocks.mockCodexConnection.sendRequest.mockClear();
    return {request, initialize, backend: mocks.mockCodexConnection.sendRequest};
}

async function transcriptConnection(version: 1 | 2, historyMode: Thread["historyMode"] = "paginated") {
    const wire = await connect(version, ["sessionIndex", "sessionTranscriptText"]);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "batch-transcript-wire-"));
    cleanup.push(() => fs.rmSync(directory, {recursive: true, force: true}));
    const file = path.join(directory, "rollout.jsonl");
    fs.writeFileSync(file, "original transcript");
    const thread = {
        id: "stored", path: file, cwd: directory, historyMode, source: "cli", ephemeral: false,
        preview: "Saved question", name: null, forkedFromId: null, recencyAt: null,
        createdAt: 1, updatedAt: 2, status: {type: "notLoaded"},
    } as Thread;
    const answer = {type: "agentMessage", id: "answer", text: "Saved answer"} as ThreadItem;
    const entry = (item: ThreadItem) => ({turnId: "turn", item, startedAtMs: null, completedAtMs: null});
    wire.backend.mockImplementation(async (method: string, params: any) => {
        if (method === "thread/read") return {thread: {...thread, turns: params.includeTurns ? [{items: [answer]}] : []}};
        if (method === "thread/items/list") return {data: [entry(answer)], nextCursor: null, backwardsCursor: null};
        throw new Error(`Unexpected request: ${method}`);
    });
    const read = (options?: {cancellationSignal?: AbortSignal}) => wire.request(SESSION_BATCH_GET_METHOD, {
        sessionIds: [thread.id], _meta: {jetbrains: {air: {include: "transcriptTextSnapshot", cwd: directory}}},
    }, options);
    return {...wire, directory, thread, answer, entry, read};
}

describe.each([1, 2] as const)("_session/batch_get over ACP v%i", version => {
    it.each([
        {historyMode: "paginated", change: "path"},
        {historyMode: "legacy", change: "path"},
        {historyMode: "paginated", change: "cwd"},
        {historyMode: "paginated", change: "historyMode"},
    ] as const)("rejects a $change change during a $historyMode read", async ({historyMode, change}) => {
        const {backend, thread, answer, read, directory} = await transcriptConnection(version, historyMode);
        const respond = backend.getMockImplementation()!;
        backend.mockImplementation(async (method: string, params: any) => {
            if ((method === "thread/read" && params.includeTurns) || (method === "thread/items/list" && params.sortDirection === "asc")) {
                if (change === "path") {
                    thread.path = path.join(directory, "replacement.jsonl");
                    fs.writeFileSync(thread.path, "replacement transcript");
                } else if (change === "cwd") thread.cwd = path.join(directory, "other-project");
                else thread.historyMode = "legacy";
                if (answer.type === "agentMessage") answer.text = "Replacement answer";
            }
            return respond(method, params);
        });
        await expect(read()).rejects.toMatchObject({code: -32603, data: {reason: "transcriptChanged"}});
    });

    it("rejects legacy text from B even when the final selection is A again", async () => {
        const {backend, read, thread, directory, answer} = await transcriptConnection(version, "legacy");
        const respond = backend.getMockImplementation()!;
        const other = path.join(directory, "other.jsonl");
        fs.writeFileSync(other, "different transcript");
        backend.mockImplementation(async (method: string, params: any) => params.includeTurns
            ? {thread: {...thread, path: other, turns: [{items: [{...answer, text: "Text from B"}]}]}}
            : respond(method, params));
        await expect(read()).rejects.toMatchObject({code: -32603, data: {reason: "transcriptChanged"}});
    });

    it.each(["beforeRevision", "duringHistory", "duringVerification"] as const)("handles a rollout disappearing $0", async stage => {
        const {backend, read, thread} = await transcriptConnection(version);
        const respond = backend.getMockImplementation()!;
        let metadataReads = 0;
        backend.mockImplementation(async (method: string, params: any) => {
            if (method === "thread/read") metadataReads++;
            if (stage === "beforeRevision" && method === "thread/read" && metadataReads === 1
                || stage === "duringHistory" && params.sortDirection === "asc"
                || stage === "duringVerification" && method === "thread/read" && metadataReads === 2) fs.unlinkSync(thread.path!);
            return respond(method, params);
        });
        if (stage === "beforeRevision") expect(await read()).toEqual({sessions: []});
        else await expect(read()).rejects.toMatchObject({code: -32603, data: {reason: "transcriptChanged"}});
    });

    it.each(["paginated", "legacy"] as const)("reports a retry-later reason for a stalled %s read", async historyMode => {
        const {backend, read} = await transcriptConnection(version, historyMode);
        const respond = backend.getMockImplementation()!;
        const entered = deferred<void>();
        const pending = deferred<any>();
        vi.useFakeTimers({toFake: ["Date", "setTimeout", "clearTimeout"]});
        backend.mockImplementation(async (method: string, params: any) => {
            if (params.includeTurns || params.sortDirection === "desc") {
                entered.resolve();
                return pending.promise;
            }
            return respond(method, params);
        });
        const timedOut = expect(read()).rejects.toMatchObject({code: -32603, data: {reason: "transcriptReadTimeout"}});
        await entered.promise;
        await vi.advanceTimersByTimeAsync(60_000);
        await timedOut;
        pending.reject(new Error("Late backend failure"));
    });

    it("returns the same snapshot at different page speeds for an unchanged revision", async () => {
        const {backend, read, thread, entry} = await transcriptConnection(version);
        vi.useFakeTimers({toFake: ["Date", "setTimeout", "clearTimeout"]});
        let delayMs = 0;
        backend.mockImplementation(async (method: string, params: any) => {
            if (method === "thread/read") return {thread: {...thread, turns: []}};
            const index = params.sortDirection === "desc" ? 29 : Number(params.cursor ?? 0);
            if (params.sortDirection === "asc") vi.setSystemTime(Date.now() + delayMs);
            const item = {type: "agentMessage", id: `message-${index}`, text: `Answer ${index}`} as ThreadItem;
            return {data: [entry(item)], nextCursor: index === 29 ? null : `${index + 1}`};
        });
        const fast = (await read()).sessions[0]._meta.jetbrains.air.transcriptTextSnapshot;
        delayMs = 400;
        const slow = (await read()).sessions[0]._meta.jetbrains.air.transcriptTextSnapshot;
        expect(slow).toEqual(fast);
        expect(slow).toMatchObject({truncated: false, messages: Array.from({length: 30}, (_, index) => ({role: "assistant", text: `Answer ${index}`}))});
    });

    it("bounds raw items independently of page boundaries, including omitted tools", async () => {
        const {backend, read, thread, answer, entry} = await transcriptConnection(version);
        const results = [];
        for (const pageSize of [64, 100]) {
            let forwardPages = 0;
            backend.mockImplementation(async (method: string, params: any) => {
                if (method === "thread/read") return {thread: {...thread, turns: []}};
                if (params.sortDirection === "desc") return {data: [entry({...answer, id: "last"})], nextCursor: null};
                forwardPages++;
                const start = Number(params.cursor ?? 0);
                const data = Array.from({length: pageSize}, (_, index) => entry(start + index === 0 ? answer
                    : {type: "commandExecution", id: `tool-${start + index}`, command: "hidden", aggregatedOutput: "hidden"} as ThreadItem));
                return {data, nextCursor: `${start + pageSize}`};
            });
            const response = await read();
            const snapshot = response.sessions[0]._meta.jetbrains.air.transcriptTextSnapshot;
            results.push({pageSize, snapshot: {...snapshot, revision: "<revision>"}, forwardPages});
        }
        await expect(JSON.stringify(results, null, 2))
            .toMatchFileSnapshot("data/session-transcript-scan-budget.json");
    });

    it.each(["metadata", "boundary", "page", "verification"].flatMap(stage =>
        ["success", "error"].map(late => ({stage, late}))))("cancels a pending $stage read before its late $late", async ({stage, late}) => {
        const {backend, read, answer, entry} = await transcriptConnection(version);
        const respond = backend.getMockImplementation()!;
        const pending = deferred<any>();
        const entered = deferred<void>();
        let metadataReads = 0;
        let calls = 0;
        let finish: (() => Promise<any>) | undefined;
        backend.mockImplementation(async (method: string, params: any) => {
            calls++;
            if (method === "thread/read") metadataReads++;
            const waiting = stage === "metadata" && method === "thread/read"
                || stage === "boundary" && params.sortDirection === "desc"
                || stage === "page" && params.sortDirection === "asc"
                || stage === "verification" && method === "thread/read" && metadataReads === 2;
            if (waiting) {
                finish = () => respond(method, params);
                entered.resolve();
                return pending.promise;
            }
            return respond(method, params);
        });
        const controller = new AbortController();
        const cancelled = expect(read({cancellationSignal: controller.signal})).rejects.toMatchObject({code: -32800});
        await entered.promise;
        controller.abort();
        await cancelled;
        const callsAtCancellation = calls;
        if (late === "error") pending.reject(new Error("Late backend failure"));
        else pending.resolve(stage === "page"
            ? {data: [entry({...answer, id: "intermediate"})], nextCursor: "more", backwardsCursor: null}
            : await finish!());
        await new Promise(resolve => setImmediate(resolve));
        expect(calls).toBe(callsAtCancellation);
    });

    it.each([[[]], [["sessionBatchGet"]]])("is neither advertised nor served without sessionIndex: %j", async capabilities => {
        const {request, initialize, backend} = await connect(version, capabilities);
        expect(initialize._meta.jetbrains.air.capabilities).not.toContain("sessionBatchGet");
        await expect(request(SESSION_BATCH_GET_METHOD, {sessionIds: []})).rejects.toMatchObject({code: -32601});
        expect(backend).not.toHaveBeenCalled();
    });

    it("negotiates text separately and validates include on both protocols", async () => {
        const old = await connect(version, ["sessionIndex"]);
        expect(old.initialize._meta.jetbrains.air.capabilities).not.toContain("sessionTranscriptText");
        const meta = {jetbrains: {air: {include: "transcriptRevision", cwd: process.cwd()}}};
        await expect(old.request(SESSION_BATCH_GET_METHOD, {sessionIds: ["one"], _meta: meta})).rejects.toMatchObject({code: -32602});
        const current = await connect(version, ["sessionIndex", "sessionTranscriptText"]);
        expect(current.initialize._meta.jetbrains.air.capabilities).toContain("sessionTranscriptText");
        expect(await current.request(SESSION_BATCH_GET_METHOD, {sessionIds: ["missing"], _meta: meta})).toEqual({sessions: []});
        for (const air of [{include: []}, {include: "bad"}, {include: "transcriptRevision", cwd: "relative"}]) {
            await expect(current.request(SESSION_BATCH_GET_METHOD, {sessionIds: ["one"], _meta: {jetbrains: {air}}})).rejects.toMatchObject({code: -32602});
        }
    });

    it("is advertised with sessionIndex and reads only metadata", async () => {
        const {request, initialize, backend} = await connect(version, ["sessionIndex"]);
        expect(initialize._meta.jetbrains.air.capabilities).toContain("sessionBatchGet");
        const ids = ["second", "first"];
        expect(await request(SESSION_BATCH_GET_METHOD, {sessionIds: ids})).toEqual({sessions: []});
        expect(backend.mock.calls).toEqual(ids.map(threadId => ["thread/read", {threadId, includeTurns: false}]));
    });

    it("rejects malformed, extra, duplicate and blank input without store work", async () => {
        const {request, backend} = await connect(version, ["sessionIndex"]);
        const invalid = [undefined, null, [], "ids", {}, {sessionIds: null}, {sessionIds: "a"},
            {sessionIds: [1]}, {sessionIds: [""]}, {sessionIds: [" \n\t"]}, {sessionIds: ["a", "a"]},
            {sessionIds: [], cwd: null},
        ];
        for (const params of invalid) {
            await expect(request(SESSION_BATCH_GET_METHOD, params)).rejects.toMatchObject({code: -32602});
        }
        expect(await request(SESSION_BATCH_GET_METHOD, {sessionIds: []})).toEqual({sessions: []});
        expect(backend).not.toHaveBeenCalled();
    });

    it("accepts more than 100 distinct exact strings without trimming or normalization", async () => {
        const {request, backend} = await connect(version, ["sessionIndex"]);
        const ids = ["id", "ID", " id ", ...Array.from({length: 247}, (_, index) => `id-${index}`)];
        const result = await request(SESSION_BATCH_GET_METHOD, {sessionIds: ids});
        expect(result).toEqual({sessions: []});
        expect(backend.mock.calls.map(([, params]: [unknown, any]) => params.threadId)).toEqual(ids);
    });
});

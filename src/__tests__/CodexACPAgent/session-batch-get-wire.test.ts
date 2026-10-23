import {afterEach, describe, expect, it, vi} from "vitest";
import * as acp from "@agentclientprotocol/sdk/unstable";
import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {createAcpAgentRouter} from "../../AcpAgentRouter";
import {CodexAcpServer} from "../../CodexAcpServer";
import {CodexAcpClient} from "../../CodexAcpClient";
import {CodexAppServerClient} from "../../CodexAppServerClient";
import {SESSION_BATCH_GET_METHOD} from "../../SessionIndex";
import {createMockConnections} from "./test-utils";

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).reverse().forEach(dispose => dispose()));

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
    const router = createAcpAgentRouter(connection => new CodexAcpServer(connection, client));
    const incoming = new TransformStream<Uint8Array, Uint8Array>();
    const outgoing = new TransformStream<Uint8Array, Uint8Array>();
    router.connect(acp.ndJsonStream(outgoing.writable, incoming.readable));
    const protocol = version === 1 ? acp : acpV2;
    const connection = protocol.client({name: "batch-test"}).connect(acp.ndJsonStream(incoming.writable, outgoing.readable));
    cleanup.push(() => connection.close());
    // The extension and response shape are identical on both ACP protocol versions.
    const request = (method: string, params?: unknown) => (connection.agent.request as any)(method, params);
    const air = {_meta: {jetbrains: {air: {version: 1, capabilities}}}};
    const initialize = await request("initialize", version === 1
        ? {protocolVersion: 1, clientCapabilities: air}
        : {protocolVersion: 2, info: {name: "batch-test", version: "1"}, capabilities: air});
    mocks.mockCodexConnection.sendRequest.mockClear();
    return {request, initialize, backend: mocks.mockCodexConnection.sendRequest};
}

describe.each([1, 2] as const)("_session/batch_get over ACP v%i", version => {
    it("advertises and serves batch get only with sessionIndex", async () => {
        for (const capabilities of [[], ["sessionBatchGet"], ["sessionIndex"]]) {
            const {request, initialize, backend} = await connect(version, capabilities);
            const advertised = initialize._meta.jetbrains.air.capabilities;
            if (capabilities.includes("sessionIndex")) {
                expect(advertised).toContain("sessionBatchGet");
                const ids = ["second", "first"];
                expect(await request(SESSION_BATCH_GET_METHOD, {sessionIds: ids})).toEqual({sessions: []});
                for (const forbidden of ["thread/list", "thread/resume", "thread/start", "thread/turns/list", "thread/items/list"]) {
                    expect(backend.mock.calls.map(([method]: [string]) => method)).not.toContain(forbidden);
                }
                expect(backend.mock.calls.filter(([method]: [string]) => method === "thread/read")).toEqual(ids.map(threadId => ["thread/read", {threadId, includeTurns: false}]));
            } else {
                expect(advertised).not.toContain("sessionBatchGet");
                await expect(request(SESSION_BATCH_GET_METHOD, {sessionIds: []})).rejects.toMatchObject({code: -32601});
                expect(backend).not.toHaveBeenCalled();
            }
        }
    });

    it("rejects malformed, extra, duplicate, blank and oversized input without store work", async () => {
        const {request, backend} = await connect(version, ["sessionIndex"]);
        const invalid = [undefined, null, [], "ids", {}, {sessionIds: null}, {sessionIds: "a"},
            {sessionIds: [1]}, {sessionIds: [""]}, {sessionIds: [" \n\t"]}, {sessionIds: ["a", "a"]},
            {sessionIds: Array.from({length: 101}, (_, index) => `id-${index}`)},
            ...["cwd", "archived", "includeWorktrees", "limit", "cursor"].map(key => ({sessionIds: [], [key]: null})),
        ];
        for (const params of invalid) {
            await expect(request(SESSION_BATCH_GET_METHOD, params)).rejects.toMatchObject({code: -32602});
        }
        expect(await request(SESSION_BATCH_GET_METHOD, {sessionIds: []})).toEqual({sessions: []});
        expect(backend).not.toHaveBeenCalled();
    });

    it.each([
        {code: -32600, message: "failed to locate thread id known: Permission denied"},
        {code: -32603, message: "failed to read thread: thread-store internal error: failed to read thread metadata for known: database is locked"},
    ])("omits native metadata failures with code $code", async error => {
        const {request, backend} = await connect(version, ["sessionIndex"]);
        backend.mockRejectedValue(Object.assign(new Error(error.message), {code: error.code}));
        expect(await request(SESSION_BATCH_GET_METHOD, {sessionIds: ["known"]})).toEqual({sessions: []});
        expect(backend).toHaveBeenCalledExactlyOnceWith("thread/read", {threadId: "known", includeTurns: false});
    });

    it("accepts 100 distinct exact strings without trimming or normalization", async () => {
        const {request, backend} = await connect(version, ["sessionIndex"]);
        const ids = ["id", "ID", " id ", ...Array.from({length: 97}, (_, index) => `id-${index}`)];
        const result = await request(SESSION_BATCH_GET_METHOD, {sessionIds: ids});
        expect(result).toEqual({sessions: []});
        expect(backend.mock.calls.filter(([method]: [string]) => method === "thread/read").map(([, params]: [unknown, any]) => params.threadId)).toEqual(ids);
    });
});

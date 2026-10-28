import {afterEach, describe, expect, it, vi} from "vitest";
import {ErrorCodes, ResponseError} from "vscode-jsonrpc/node";
import {connectSession, sessionId, turnId, turnStarted, turnCompleted, settle, type PromptSession} from "./v2-prompt-harness";
import {deferred} from "../acp-test-utils";
import {sessionTitleArgument, SESSION_TITLE_TOOL} from "../../SessionTitleTool";
import type {DynamicToolCallParams, DynamicToolCallResponse} from "../../app-server/v2";
import {CodexAppServerClient} from "../../CodexAppServerClient";
import {FakeConnection} from "../app-server-recovery/fake-app-server";

const params = (overrides: Partial<DynamicToolCallParams> = {}): DynamicToolCallParams => ({
    threadId: sessionId, turnId, callId: "rename-1", namespace: null, tool: "set_thread_title",
    arguments: {title: "  Native\n rename  "}, ...overrides,
});

describe("title tool arguments", () => {
    it.each([null, [], {}, {title: null}, {title: 1}, {title: " \n "}, {title: "Name", threadId: "other"}])("rejects %j", value => {
        expect(sessionTitleArgument(value)).toBeNull();
    });

    it("normalizes whitespace and truncates without splitting a surrogate pair", () => {
        expect(sessionTitleArgument({title: " A\n title "})).toBe("A title");
        const title = sessionTitleArgument({title: "a".repeat(254) + "😀" + "b".repeat(5)})!;
        expect(title).toBe("a".repeat(254) + "…");
    });

    it("completes calls without a registered adapter handler", async () => {
        const rpc = new FakeConnection();
        new CodexAppServerClient(rpc.connection);
        rpc.notify(turnStarted());
        await expect(rpc.requestHandlers.get("item/tool/call")!(params())).resolves.toMatchObject({success: false});
    });
});

for (const version of [1, 2] as const) {
    describe(`native title tool ACP v${version}`, () => {
        let client: PromptSession;
        afterEach(async () => { await settle(); client?.connection.close(); });
        const open = async () => {
            client = await connectSession(version);
            client.emit(turnStarted());
            return client;
        };
        const call = (overrides: Partial<DynamicToolCallParams> = {}) =>
            client.triggerApproval("item/tool/call", params(overrides)) as Promise<DynamicToolCallResponse>;

        it("registers one eager tool and persists and publishes the normalized title without AIR", async () => {
            const registrations: unknown[] = [];
            const {codexResponse} = await import("./v2-prompt-harness");
            client = await connectSession(version, {codexResponses: {
                "thread/start": async p => { registrations.push(p); return codexResponse("thread/start"); },
            }});
            client.emit(turnStarted());
            const write = vi.spyOn(client.appServer, "threadSetName").mockResolvedValue({});
            const result = await call();
            expect(registrations).toEqual([expect.objectContaining({dynamicTools: [SESSION_TITLE_TOOL]})]);
            expect(write).toHaveBeenCalledExactlyOnceWith({threadId: sessionId, name: "Native rename"});
            const updates = client.scopedUpdates.filter(x => x.update.sessionUpdate === "session_info_update" && "title" in x.update);
            await expect(JSON.stringify({result, updates}, null, 2) + "\n").toMatchFileSnapshot(`data/session-title-tool-v${version}.json`);
            const automatic = vi.fn(async () => true);
            expect(await client.agent.sessionIndex.titleWriter(sessionId)("Automatic", automatic)).toBe(false);
            expect(automatic).not.toHaveBeenCalled();
        });

        it.each([
            {tool: "unknown"}, {namespace: "other"}, {arguments: {title: "x", threadId: "other"}},
            {threadId: "unloaded"}, {turnId: "old-turn"},
        ])("rejects invalid or unrelated requests %j", async overrides => {
            await open();
            const write = vi.spyOn(client.appServer, "threadSetName");
            expect((await call(overrides)).success).toBe(false);
            expect(write).not.toHaveBeenCalled();
        });

        it("rejects a completed turn", async () => {
            await open();
            client.emit(turnCompleted());
            expect((await call()).success).toBe(false);
        });

        it("rechecks the turn after waiting for an automatic write", async () => {
            await open();
            const held = deferred<boolean>();
            const automatic = client.agent.sessionIndex.titleWriter(sessionId)("Automatic", () => held.promise);
            const write = vi.spyOn(client.appServer, "threadSetName");
            const rename = call();
            client.emit(turnCompleted());
            held.resolve(true);
            await automatic;
            expect((await rename).success).toBe(false);
            expect(write).not.toHaveBeenCalled();
        });

        it("rechecks session close after waiting for another write", async () => {
            await open();
            const held = deferred<boolean>();
            const automatic = client.agent.sessionIndex.titleWriter(sessionId)("Automatic", () => held.promise);
            const write = vi.spyOn(client.appServer, "threadSetName");
            const rename = call();
            const close = client.agent.closeSession({sessionId});
            held.resolve(true);
            await automatic;
            expect((await rename).success).toBe(false);
            await close;
            expect(write).not.toHaveBeenCalled();
        });

        it("releases automatic writes after a confirmed rejection", async () => {
            await open();
            vi.spyOn(client.appServer, "threadSetName").mockRejectedValue(new ResponseError(-32600, "rejected"));
            expect((await call()).contentItems).toEqual([{type: "inputText", text: "Session title was not changed: rejected"}]);
            const automatic = vi.fn(async () => true);
            expect(await client.agent.sessionIndex.titleWriter(sessionId)("Automatic", automatic)).toBe(true);
            expect(automatic).toHaveBeenCalledOnce();
        });

        it("restores the original title source when two queued renames are rejected", async () => {
            await open();
            const source = client.agent.getSessionState(sessionId).sessionTitleSource;
            vi.spyOn(client.appServer, "threadSetName").mockRejectedValue(new ResponseError(-32600, "rejected"));
            const results = await Promise.all([call(), call({callId: "rename-2"})]);
            expect(results.map(result => result.success)).toEqual([false, false]);
            expect(client.agent.getSessionState(sessionId).sessionTitleSource).toBe(source);
        });

        it("blocks a queued automatic write when the rename saved but its acknowledgement was lost", async () => {
            await open();
            let saved = "Initial";
            const ack = deferred<Record<string, never>>();
            vi.spyOn(client.appServer, "threadSetName").mockImplementation(async ({name}) => { saved = name; return ack.promise; });
            const rename = call();
            await vi.waitFor(() => expect(saved).toBe("Native rename"));
            const automatic = client.agent.sessionIndex.titleWriter(sessionId)("Automatic", async () => { saved = "Automatic"; return true; });
            ack.reject(new ResponseError(ErrorCodes.PendingResponseRejected, "acknowledgement lost"));
            expect((await rename).contentItems).toEqual([{type: "inputText", text: "The rename outcome is uncertain; it may have been saved. Automatic title writes are blocked. Check the saved title before retrying."}]);
            expect(await automatic).toBe(false);
            expect(saved).toBe("Native rename");
            expect(client.agent.getSessionState(sessionId).sessionTitleSource).toBe("explicit");
        });

        it("reports saved persistence when the client notification fails", async () => {
            await open();
            const write = vi.spyOn(client.appServer, "threadSetName").mockResolvedValue({});
            await client.waitForNotifications();
            const connection = (client.agent as unknown as {connection: {notify: (...args: unknown[]) => unknown}}).connection;
            vi.spyOn(connection, "notify").mockRejectedValue(new Error("client disconnected"));
            const result = await call();
            expect(write).toHaveBeenCalledOnce();
            expect(result).toEqual({success: false, contentItems: [{type: "inputText", text: 'Session title saved as "Native rename", but the session changed or the client update failed. Do not retry the rename.'}]});
            expect(await client.agent.sessionIndex.titleWriter(sessionId)("Automatic", async () => true)).toBe(false);
        });
    });
}

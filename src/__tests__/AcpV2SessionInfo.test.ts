import {describe, expect, it, vi} from "vitest";
import {AcpV2SessionInfo} from "../AcpV2SessionInfo";
import {AcpV2Connection, type AcpV2ClientConnection} from "../ACPSessionConnection";
import {CodexEventHandler} from "../CodexEventHandler";
import {createTestSessionState} from "./acp-test-utils";
import type {SessionFailure} from "../CodexAcpServer";

type Update = Parameters<AcpV2SessionInfo["update"]>[0];

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return {promise, resolve};
}

describe("V2 session metadata", () => {
    it("uses shallow patches, explicit removals, and a clear before resynchronization", async () => {
        const sent: Update[] = [];
        const info = new AcpV2SessionInfo(async update => { sent.push(update); });
        await info.update({sessionUpdate: "session_info_update", _meta: {retained: true, removed: true, ns: {old: true}}});
        await info.update({sessionUpdate: "session_info_update", title: "Title"});
        await info.update({sessionUpdate: "session_info_update", _meta: {}});
        await info.update({sessionUpdate: "session_info_update", _meta: {removed: null, ns: {nested: null}}});
        const start = sent.length;
        await info.snapshot("Current");
        expect(sent.slice(start)).toEqual([
            {sessionUpdate: "session_info_update", title: "Current", _meta: null},
            {sessionUpdate: "session_info_update", _meta: {retained: true, ns: {nested: null}}},
        ]);
        await info.update({sessionUpdate: "session_info_update", _meta: null});
        const empty = sent.length;
        await info.snapshot(null);
        expect(sent.slice(empty)).toEqual([{sessionUpdate: "session_info_update", title: null, _meta: null}]);
    });

    it("copies JSON at publication and does not store notification metadata", async () => {
        const sent: Array<{update: Update; metadata: unknown}> = [];
        const info = new AcpV2SessionInfo(async (update, metadata) => { sent.push({update, metadata}); });
        const value = {nested: {count: 1}};
        const pending = info.update({sessionUpdate: "session_info_update", _meta: value}, {event: {literal: null}});
        value.nested.count = 2;
        await pending;
        expect(sent[0]?.metadata).toEqual({event: {literal: null}});
        await info.snapshot("Current");
        expect(sent.at(-1)).toEqual({
            update: {sessionUpdate: "session_info_update", _meta: {nested: {count: 1}}},
            metadata: undefined,
        });
    });

    it("does not interleave a newer live patch between a clear and its restoration", async () => {
        const sent: Update[] = [];
        const clearing = deferred();
        const release = deferred();
        const info = new AcpV2SessionInfo(async update => {
            sent.push(update);
            if (update._meta === null) { clearing.resolve(); await release.promise; }
        }, {ns: {version: "old"}});
        const snapshot = info.snapshot("Current");
        await clearing.promise;
        const live = info.update({sessionUpdate: "session_info_update", _meta: {ns: {version: "new"}}});
        release.resolve();
        await Promise.all([snapshot, live]);
        expect(sent.map(update => update._meta)).toEqual([null, {ns: {version: "old"}}, {ns: {version: "new"}}]);
    });

    it("takes its snapshot after earlier queued patches, including domain metadata changes", async () => {
        const sent: Update[] = [];
        const info = new AcpV2SessionInfo(async update => { sent.push(update); });
        const live = info.update({sessionUpdate: "session_info_update", _meta: {ns: {version: 1}}});
        const patch = info.patchMetadata(current => ({ns: {...current["ns"] as object, added: true}}));
        const snapshot = info.snapshot("Current");
        await Promise.all([live, patch, snapshot]);
        expect(sent.at(-1)?._meta).toEqual({ns: {version: 1, added: true}});
    });

    it("preserves accompanying session info fields while composing metadata", async () => {
        const sent: Update[] = [];
        const info = new AcpV2SessionInfo(async update => { sent.push(update); });
        const fields = {title: "Current", updatedAt: "2026-10-30T12:00:00Z"};
        const pending = info.patchMetadata(() => ({current: true}), fields);
        fields.title = "Changed after publication";
        await pending;
        expect(sent).toEqual([{title: "Current", updatedAt: "2026-10-30T12:00:00Z",
            sessionUpdate: "session_info_update", _meta: {current: true}}]);
    });

    it("stops queued and in-flight restoration after disposal", async () => {
        const sent: Update[] = [];
        const clearing = deferred();
        const release = deferred();
        const info = new AcpV2SessionInfo(async update => {
            sent.push(update);
            clearing.resolve();
            await release.promise;
        }, {old: true});
        const snapshot = info.snapshot("Current");
        await clearing.promise;
        const late = info.update({sessionUpdate: "session_info_update", _meta: {late: true}});
        info.dispose();
        release.resolve();
        await Promise.all([snapshot, late]);
        expect(sent).toEqual([{sessionUpdate: "session_info_update", title: "Current", _meta: null}]);
    });

    it("can resynchronize known metadata after an earlier write failed", async () => {
        const send = vi.fn(async (_update: Update) => {});
        send.mockRejectedValueOnce(new Error("Write failed"));
        const info = new AcpV2SessionInfo(send);
        await expect(info.update({sessionUpdate: "session_info_update", _meta: {current: true}})).rejects.toThrow("Write failed");
        await info.snapshot("Current");
        expect(send.mock.calls.at(-1)?.[0]._meta).toEqual({current: true});
    });

    it.each([1, 2])("clears only the resolved failure revision, preserving sibling metadata (published revision %s)", async revision => {
        const sent: Update[] = [];
        const client = {notify: vi.fn(async (_method, params) => { sent.push(params.update); }), request: vi.fn()} as unknown as AcpV2ClientConnection;
        const v2 = new AcpV2Connection(client);
        const failure: SessionFailure = {id: "incident", revision: 1, category: "service", severity: "warning", title: "Retrying", actions: ["retry"]};
        const state = createTestSessionState({sessionId: "session", sessionFailure: failure});
        const handler = new CodexEventHandler(v2.extensionOnlyV1View(), state, true, "epoch", state.subagents, undefined, false, false, false);
        await v2.client.notify("session/update", {sessionId: "session", update: {
            sessionUpdate: "session_info_update",
            _meta: {jetbrains: {other: true, air: {version: 1, sibling: {value: null}, sessionFailure: {...failure, revision}}}},
        }});
        await handler.clearSessionFailure();
        await v2.snapshotSessionInfo("session", "Current");
        const air = (sent.at(-1)?._meta?.["jetbrains"] as {air: Record<string, unknown>}).air;
        expect(air["sibling"]).toEqual({value: null});
        expect(air["sessionFailure"]).toEqual(revision === 1 ? undefined : {...failure, revision});
    });
});

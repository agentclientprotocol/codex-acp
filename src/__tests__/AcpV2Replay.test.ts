import * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {describe, expect, it, vi} from "vitest";
import {ACPSessionConnection, AcpV2Connection, type AcpV2ClientConnection} from "../ACPSessionConnection";
import {AcpClientDelivery} from "../AcpClientDelivery";
import {AcpV2Replay, type ReplayedEntities, toV2ReplayUpdates} from "../AcpV2Replay";

describe("V2 replay boundaries", () => {
    it("holds live updates and requests, including current state produced by history, until each replay is complete", async () => {
        const sent: acp.UpdateSessionNotification[] = [];
        const replay = new AcpV2Replay(async params => { sent.push(params); });
        let finish!: () => void;
        let historyReady!: () => void;
        const gate = new Promise<void>(resolve => { finish = resolve; });
        const ready = new Promise<void>(resolve => { historyReady = resolve; });
        const operation = replay.run("root", () => replay.withHistory("root", async () => {
            await replay.notify({sessionId: "root", update: {sessionUpdate: "subagent_update", sessionId: "child"}});
            await replay.notify({sessionId: "child", update: {sessionUpdate: "subagent_update", sessionId: "empty"}});
            await replay.notify({sessionId: "child", update: {
                sessionUpdate: "session_message", messageId: "task", content: [{type: "text", text: "Investigate"}],
            }});
            await replay.notify({sessionId: "child", update: {sessionUpdate: "state_update", state: "unknown"}});
            historyReady();
            await gate;
        }));
        await ready;
        await replay.notify({sessionId: "root", update: {
            sessionUpdate: "subagent_update", sessionId: "child", state: {state: "unknown"},
        }});
        await replay.notify({sessionId: "root", update: {sessionUpdate: "notice", title: "Live", severity: "info"}});
        await replay.notify({sessionId: "child", update: {sessionUpdate: "agent_message_chunk",
            messageId: "answer", content: {type: "text", text: "Live child"}}});
        await replay.notify({sessionId: "root", update: {sessionUpdate: "subagent_update", sessionId: "new-child"}});
        await replay.notify({sessionId: "new-child", update: {sessionUpdate: "agent_message_chunk",
            messageId: "new-answer", content: {type: "text", text: "New child"}}});
        const request = vi.fn();
        const waiting = replay.wait("child").then(request);
        await replay.notify({sessionId: "unrelated", update: {sessionUpdate: "state_update", state: "idle"}});
        expect(sent.map(params => params.update.sessionUpdate)).toEqual([
            "subagent_update", "subagent_update", "session_message", "state_update",
        ]);
        expect(request).not.toHaveBeenCalled();
        finish();
        await operation;
        await waiting;
        expect(request).toHaveBeenCalledOnce();
        await expect(`${JSON.stringify(sent, null, 2)}\n`).toMatchFileSnapshot("data/v2-replay-boundaries.json");
    });

    it("holds a known child from receipt and releases it at its own marker, not its parent's", async () => {
        const sent: acp.UpdateSessionNotification[] = [];
        let unblockRoot!: () => void;
        const rootWrite = new Promise<void>(resolve => { unblockRoot = resolve; });
        const replay = new AcpV2Replay(async params => {
            if (params.sessionId === "root" && params.update.sessionUpdate === "replay_complete") await rootWrite;
            sent.push(params);
        });
        const live: acp.UpdateSessionNotification = {sessionId: "child", update: {
            sessionUpdate: "agent_message_chunk", messageId: "live", content: {type: "text", text: "Live"},
        }};
        const operation = replay.run("root", async () => {
            await replay.notify(live);
            expect(sent).toEqual([]);
            await replay.withHistory("root", () => replay.notify({sessionId: "root", update: {
                sessionUpdate: "subagent_update", sessionId: "child",
            }}));
        }, undefined, ["child", "not-announced"]);
        try {
            await replay.wait("child");
            expect(sent.map(({sessionId, update}) => [sessionId, update.sessionUpdate])).toEqual([
                ["root", "subagent_update"], ["child", "replay_complete"], ["child", "agent_message_chunk"],
            ]);
        } finally { unblockRoot(); await operation; }
        expect(sent.at(-1)).toEqual({sessionId: "root", update: {sessionUpdate: "replay_complete"}});
    });

    it("writes a nested live announcement before releasing the child's traffic at the end of a replay", async () => {
        const sent: acp.UpdateSessionNotification[] = [];
        const replay = new AcpV2Replay(async params => { sent.push(params); });
        const notice: acp.UpdateSessionNotification = {sessionId: "parent", update: {sessionUpdate: "notice", severity: "info", title: "Live"}};
        const announcement: acp.UpdateSessionNotification = {sessionId: "parent", update: {sessionUpdate: "subagent_update", sessionId: "leaf"}};
        const live: acp.UpdateSessionNotification = {sessionId: "leaf", update: {sessionUpdate: "state_update", state: "running"}};
        await replay.run("root", async () => {
            await replay.notify(notice);
            await replay.notify(announcement);
            await replay.notify(live);
        }, undefined, ["parent"]);
        expect(sent).toEqual([
            {sessionId: "root", update: {sessionUpdate: "replay_complete"}}, notice, announcement,
            {sessionId: "leaf", update: {sessionUpdate: "replay_complete"}}, live,
        ]);
    });

    it.each(["failure", "cancellation"] as const)("does not certify a replay after %s and releases pending requests", async outcome => {
        const sent: acp.UpdateSessionNotification[] = [];
        const replay = new AcpV2Replay(async params => { sent.push(params); });
        const controller = new AbortController();
        let waiting!: Promise<void>;
        const failed = replay.run("session", async () => {
            waiting = replay.wait("session");
            // Attach the rejection handler before the replay releases it.
            void waiting.catch(() => {});
            await replay.notify({sessionId: "session", update: {sessionUpdate: "state_update", state: "running"}});
            if (outcome === "failure") throw new Error("History unavailable");
            controller.abort();
        }, controller.signal);
        await expect(failed).rejects.toThrow(outcome === "failure" ? "History unavailable" : "Session replay was cancelled");
        await expect(waiting).rejects.toMatchObject({code: -32800});
        expect(sent).toEqual([]);
        await replay.run("session", async () => {});
        expect(sent).toEqual([{sessionId: "session", update: {sessionUpdate: "replay_complete"}}]);
    });
});

const entities: Array<{name: string; initial: acp.SessionUpdate; next: acp.SessionUpdate}> = [
    {name: "tool", initial: {sessionUpdate: "tool_call_update", toolCallId: "same", title: "Tool", status: "in_progress"},
        next: {sessionUpdate: "tool_call_update", toolCallId: "same", status: "completed"}},
    {name: "terminal", initial: {sessionUpdate: "terminal_update", terminalId: "same", command: "echo OK"},
        next: {sessionUpdate: "terminal_update", terminalId: "same", exitStatus: {exitCode: 0}}},
    {name: "compaction", initial: {sessionUpdate: "compaction_update", compactionId: "same", status: "in_progress"},
        next: {sessionUpdate: "compaction_update", compactionId: "same", status: "completed"}},
];

function metadataAfter(updates: acp.SessionUpdate[]) {
    let stored: Record<string, unknown> = {stale: true, old: {nested: "retained"}};
    for (const update of updates) {
        if (update._meta === null) stored = {};
        else if (update._meta) for (const [key, value] of Object.entries(update._meta)) {
            if (value === null) delete stored[key];
            else stored[key] = value;
        }
    }
    return stored;
}

describe("V2 replay initialization", () => {
    it.each(entities)("clears stale $name metadata and preserves current keys through later partial updates", ({initial, next}) => {
        const initialized: ReplayedEntities = new Map();
        const current = {_meta: {fresh: {nested: null}, removed: null}};
        const first = toV2ReplayUpdates({...initial, ...current}, initialized);
        expect(first).toHaveLength(2);
        expect(first[0]?._meta).toBeNull();
        const later = toV2ReplayUpdates(next, initialized);
        expect(later).toEqual([next]);
        expect(metadataAfter([...first, ...later])).toEqual({fresh: {nested: null}});
        const repeated = toV2ReplayUpdates({...initial, ...current}, new Map());
        expect(repeated[0]?._meta).toBeNull();
    });

    it.each(entities)("clears empty $name metadata in the snapshot itself", ({initial}) => {
        for (const meta of [undefined, null, {}]) {
            const updates = toV2ReplayUpdates({...initial, ...(meta === undefined ? {} : {_meta: meta})}, new Map());
            expect(updates).toEqual([{...initial, _meta: null}]);
            expect(metadataAfter(updates)).toEqual({});
        }
    });

    it("keeps tool and terminal identities separate even when their IDs match", () => {
        const initialized: ReplayedEntities = new Map();
        for (const {initial} of entities) {
            expect(toV2ReplayUpdates(initial, initialized)[0]?._meta).toBeNull();
        }
    });

    it("primes messages once without treating chunk metadata as an entity patch", () => {
        const initialized: ReplayedEntities = new Map();
        const chunk: acp.SessionUpdate = {sessionUpdate: "agent_message_chunk", messageId: "message",
            content: {type: "text", text: "Part"}, _meta: {chunkValue: null}};
        expect(toV2ReplayUpdates(chunk, initialized)).toEqual([
            {sessionUpdate: "agent_message", messageId: "message", content: [], _meta: null}, chunk,
        ]);
        expect(toV2ReplayUpdates(chunk, initialized)).toEqual([chunk]);
    });

    const text = {type: "text", text: "Part"} as const;
    const chunks: Array<{chunk: acp.SessionUpdate; primer: acp.SessionUpdate}> = [
        {chunk: {sessionUpdate: "session_message_chunk", messageId: "same", content: text},
            primer: {sessionUpdate: "session_message", messageId: "same", content: []}},
        {chunk: {sessionUpdate: "tool_call_content_chunk", toolCallId: "same", content: {type: "content", content: text}},
            primer: {sessionUpdate: "tool_call_update", toolCallId: "same", content: []}},
        {chunk: {sessionUpdate: "terminal_output_chunk", terminalId: "same", data: "T0s="},
            primer: {sessionUpdate: "terminal_update", terminalId: "same", output: {data: ""}}},
        {chunk: {sessionUpdate: "compaction_summary_chunk", compactionId: "same", content: text},
            primer: {sessionUpdate: "compaction_update", compactionId: "same", summary: [], status: "in_progress"}},
    ];
    it.each(chunks)("primes $chunk.sessionUpdate once without applying chunk metadata to the entity", ({chunk, primer}) => {
        const initialized: ReplayedEntities = new Map();
        const part = {...chunk, _meta: {value: null}};
        expect(toV2ReplayUpdates(part, initialized)).toEqual([{...primer, _meta: null}, part]);
        expect(toV2ReplayUpdates(part, initialized)).toEqual([part]);
        const snapshotted: ReplayedEntities = new Map();
        toV2ReplayUpdates(primer, snapshotted);
        expect(toV2ReplayUpdates(part, snapshotted)).toEqual([part]);
    });

    it("primes a replayed terminal after a header that did not initialize output", () => {
        const initialized: ReplayedEntities = new Map();
        const header = {sessionUpdate: "terminal_update", terminalId: "terminal", command: "echo OK"} as const;
        const chunk = {sessionUpdate: "terminal_output_chunk", terminalId: "terminal", data: "T0s="} as const;
        expect(toV2ReplayUpdates(header, initialized)).toEqual([{...header, _meta: null}]);
        expect(toV2ReplayUpdates(chunk, initialized)).toEqual([
            {sessionUpdate: "terminal_update", terminalId: "terminal", output: {data: ""}}, chunk,
        ]);
    });

    it("repeats each compaction's current status on metadata patches and summary primers", () => {
        const initialized: ReplayedEntities = new Map();
        const base = {sessionUpdate: "compaction_update", compactionId: "c"} as const;
        const completed = {...base, status: "completed", _meta: {fresh: true}};
        expect(toV2ReplayUpdates(completed, initialized)).toEqual([
            {...base, status: "completed", _meta: null}, completed,
        ]);
        toV2ReplayUpdates({...base, compactionId: "other", status: "failed"}, initialized);
        const patch = {...base, _meta: {more: true}};
        expect(toV2ReplayUpdates(patch, initialized)).toEqual([{...patch, status: "completed"}]);
        const chunk = {sessionUpdate: "compaction_summary_chunk", compactionId: "c", content: text} as const;
        expect(toV2ReplayUpdates(chunk, initialized)).toEqual([
            {...base, status: "completed", summary: []}, chunk,
        ]);
        expect(toV2ReplayUpdates({...base, status: null}, initialized)).toEqual([{...base, status: "in_progress"}]);
        expect(toV2ReplayUpdates(patch, initialized)).toEqual([{...patch, status: "in_progress"}]);
    });

    it("does not reset plan or session metadata", () => {
        const updates: acp.SessionUpdate[] = [
            {sessionUpdate: "plan_update", plan: {type: "markdown", planId: "plan", content: "Plan"}, _meta: {value: null}},
            {sessionUpdate: "session_info_update", title: "Current", _meta: {value: null}},
        ];
        for (const update of updates) expect(toV2ReplayUpdates(update, new Map())).toEqual([update]);
    });

    it("keeps tool-report tracking and live metadata patches outside replay initialization", async () => {
        const sent: acp.SessionUpdate[] = [];
        const client = {
            notify: vi.fn(async (_method, params) => { sent.push(params.update); }),
            request: vi.fn(),
        } as unknown as AcpV2ClientConnection;
        const v2 = new AcpV2Connection(client);
        const delivery = new AcpClientDelivery(v2.extensionOnlyV1View());
        v2.setClientDelivery(delivery);
        v2.registerView(delivery.asClientConnection());
        const session = new ACPSessionConnection(delivery.asClientConnection(), "session");
        await session.replayUpdate({sessionUpdate: "tool_call", toolCallId: "tool", title: "Tool",
            status: "completed", _meta: {fresh: true}}, new Map());
        expect(sent.map(update => update._meta)).toEqual([null, {fresh: true}]);
        const before = sent.length;
        await session.update({sessionUpdate: "tool_call_update", toolCallId: "tool", status: "completed"});
        await session.update({sessionUpdate: "tool_call_update", toolCallId: "tool",
            _meta: {terminal_output_delta: {terminal_id: "tool", data: "Late"}}});
        expect(sent).toHaveLength(before);
        await session.update({sessionUpdate: "tool_call_update", toolCallId: "tool", _meta: {live: true}});
        expect(sent.at(-1)?._meta).toEqual({live: true});
        expect(metadataAfter(sent)).toEqual({fresh: true, live: true});
    });
});

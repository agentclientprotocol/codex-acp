import * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {describe, expect, it, vi} from "vitest";
import {ACPSessionConnection, AcpV2Connection, type AcpV2ClientConnection} from "../ACPSessionConnection";
import {AcpClientDelivery} from "../AcpClientDelivery";
import {toV2ReplayUpdates} from "../AcpV2Replay";

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
        const initialized = new Set<string>();
        const current = {_meta: {fresh: {nested: null}, removed: null}};
        const first = toV2ReplayUpdates({...initial, ...current}, initialized);
        expect(first).toHaveLength(2);
        expect(first[0]?._meta).toBeNull();
        const later = toV2ReplayUpdates(next, initialized);
        expect(later).toEqual([next]);
        expect(metadataAfter([...first, ...later])).toEqual({fresh: {nested: null}});
        const repeated = toV2ReplayUpdates({...initial, ...current}, new Set());
        expect(repeated[0]?._meta).toBeNull();
    });

    it.each(entities)("clears empty $name metadata in the snapshot itself", ({initial}) => {
        for (const meta of [undefined, null, {}]) {
            const updates = toV2ReplayUpdates({...initial, ...(meta === undefined ? {} : {_meta: meta})}, new Set());
            expect(updates).toEqual([{...initial, _meta: null}]);
            expect(metadataAfter(updates)).toEqual({});
        }
    });

    it("keeps tool and terminal identities separate even when their IDs match", () => {
        const initialized = new Set<string>();
        for (const {initial} of entities) {
            expect(toV2ReplayUpdates(initial, initialized)[0]?._meta).toBeNull();
        }
    });

    it("primes messages once without treating chunk metadata as an entity patch", () => {
        const initialized = new Set<string>();
        const chunk: acp.SessionUpdate = {sessionUpdate: "agent_message_chunk", messageId: "message",
            content: {type: "text", text: "Part"}, _meta: {chunkValue: null}};
        expect(toV2ReplayUpdates(chunk, initialized)).toEqual([
            {sessionUpdate: "agent_message", messageId: "message", content: [], _meta: null}, chunk,
        ]);
        expect(toV2ReplayUpdates(chunk, initialized)).toEqual([chunk]);
    });

    it("does not reset plan, output-chunk or session metadata", () => {
        const updates: acp.SessionUpdate[] = [
            {sessionUpdate: "plan_update", plan: {type: "markdown", planId: "plan", content: "Plan"}, _meta: {value: null}},
            {sessionUpdate: "terminal_output_chunk", terminalId: "terminal", data: "T0s=", _meta: {value: null}},
            {sessionUpdate: "session_info_update", title: "Current", _meta: {value: null}},
        ];
        for (const update of updates) expect(toV2ReplayUpdates(update, new Set())).toEqual([update]);
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
            status: "completed", _meta: {fresh: true}}, new Set());
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

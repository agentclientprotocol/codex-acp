import * as acp from "@agentclientprotocol/sdk/unstable";
import {describe, expect, it, vi} from "vitest";
import type {AcpClientConnection} from "../ACPSessionConnection";
import {AcpClientDelivery} from "../AcpClientDelivery";

function createClient() {
    const notify = vi.fn().mockResolvedValue(undefined);
    const request = vi.fn().mockResolvedValue({outcome: {outcome: "cancelled"}});
    const client = {notify, request} as unknown as AcpClientConnection;
    return {client, notify, request};
}

describe("AcpClientDelivery", () => {
    it("fences closed-session publication and requests without interpreting extension payloads", async () => {
        const {client, notify, request} = createClient();
        const delivery = new AcpClientDelivery(client);
        delivery.closeSession("closed");
        await delivery.notify(acp.methods.client.session.update, {sessionId: "closed",
            update: {sessionUpdate: "agent_message_chunk", content: {type: "text", text: "Late"}}});
        await expect(delivery.request(acp.methods.client.session.requestPermission, {
            sessionId: "closed", toolCall: {toolCallId: "late"}, options: [],
        })).rejects.toMatchObject({code: -32800});
        expect(notify).not.toHaveBeenCalled();
        expect(request).not.toHaveBeenCalled();
        await delivery.notify("_custom", {sessionId: "closed"});
        delivery.openSession("closed");
        await delivery.notify(acp.methods.client.session.update, {sessionId: "closed",
            update: {sessionUpdate: "agent_message_chunk", content: {type: "text", text: "Current"}}});
        expect(notify.mock.calls.map(call => call[0])).toEqual(["_custom", "session/update"]);
    });

    it("keeps request-scoped URL completion but drops old, duplicate, declined and unknown completions", async () => {
        const {client, notify, request} = createClient();
        request.mockResolvedValue({action: "accept"});
        const delivery = new AcpClientDelivery(client);
        const create = (elicitationId: string, scope: object) => delivery.request(acp.methods.client.elicitation.create,
            {mode: "url", elicitationId, ...scope});
        const complete = (elicitationId: string) => delivery.notify(acp.methods.client.elicitation.complete, {elicitationId});
        await create("old", {sessionId: "s"});
        await create("login", {requestId: 1});
        let accept!: (response: unknown) => void;
        request.mockReturnValueOnce(new Promise(resolve => { accept = resolve; }));
        const late = create("late", {sessionId: "s"});
        delivery.closeSession("s");
        delivery.openSession("s");
        accept({action: "accept"});
        await late;
        await complete("late");
        await complete("old");
        await complete("unknown");
        await complete("login");
        await complete("login");
        request.mockResolvedValueOnce({action: "decline"});
        await create("declined", {sessionId: "s"});
        await complete("declined");
        await create("current", {sessionId: "s"});
        await complete("current");
        expect(notify.mock.calls.map(call => call[1])).toEqual([{elicitationId: "login"}, {elicitationId: "current"}]);
    });

    it("reopens a child only after its new announcement is delivered", async () => {
        const {client, notify} = createClient();
        const delivery = new AcpClientDelivery(client);
        delivery.closeSession("child");
        await delivery.notify(acp.methods.client.session.update, {sessionId: "parent",
            update: {sessionUpdate: "subagent_update", sessionId: "child"}});
        expect(delivery.canPublishSession("child")).toBe(true);
        expect(notify).toHaveBeenCalledOnce();
        delivery.closeSession("parent");
        delivery.closeSession("child");
        await delivery.notify(acp.methods.client.session.update, {sessionId: "parent",
            update: {sessionUpdate: "subagent_update", sessionId: "child"}});
        expect(delivery.canPublishSession("child")).toBe(false);
    });

    it("cancels only pending interactions of the closing session", async () => {
        const signals: AbortSignal[] = [];
        const release: Array<() => void> = [];
        const request = vi.fn(async (_method: string, _params: unknown, options?: acp.SendRequestOptions) => {
            if (options?.cancellationSignal) signals.push(options.cancellationSignal);
            return await new Promise<void>(resolve => { release.push(resolve); });
        });
        const delivery = new AcpClientDelivery({request, notify: vi.fn()} as unknown as AcpClientConnection);
        const elicitation = acp.methods.client.elicitation.create;
        const pending = [
            delivery.request(elicitation, {sessionId: "closing"}),
            delivery.request(acp.methods.client.session.requestPermission, {sessionId: "closing", toolCall: {toolCallId: "tool"}}),
            delivery.request(elicitation, {sessionId: "other"}),
            delivery.request(elicitation, {requestId: 1}),
            delivery.request("_custom", {sessionId: "closing"}),
        ];
        expect(signals).toHaveLength(3);
        delivery.cancelSessionRequests("closing");
        expect(signals.map(signal => signal.aborted)).toEqual([true, true, false]);
        expect(request.mock.calls[3]![2]).toBeUndefined();
        expect(request.mock.calls[4]![2]).toBeUndefined();
        for (const resolve of release) resolve();
        await Promise.all(pending);
    });

    it("preserves caller cancellation and forgets completed requests", async () => {
        const {client, request} = createClient();
        const caller = new AbortController();
        let signal!: AbortSignal;
        request.mockImplementation(async (_method, _params, options) => {
            signal = options.cancellationSignal;
            caller.abort();
            return {action: "cancel"};
        });
        const delivery = new AcpClientDelivery(client);
        await delivery.request(acp.methods.client.elicitation.create, {sessionId: "s"}, {cancellationSignal: caller.signal});
        expect(signal.aborted).toBe(true);
        request.mockImplementation(async (_method, _params, options) => {
            signal = options.cancellationSignal;
            return {action: "accept"};
        });
        await delivery.request(acp.methods.client.elicitation.create, {sessionId: "s"});
        delivery.cancelSessionRequests("s");
        expect(signal.aborted).toBe(false);
    });

    it("does not open an interaction while its session is closing", async () => {
        const {client, request} = createClient();
        let closing = true;
        const delivery = new AcpClientDelivery(client, () => closing);
        await expect(delivery.request(acp.methods.client.elicitation.create, {sessionId: "s"}))
            .rejects.toMatchObject({code: -32800});
        expect(request).not.toHaveBeenCalled();
        closing = false;
        await delivery.request(acp.methods.client.elicitation.create, {sessionId: "s"});
        expect(request).toHaveBeenCalledOnce();
    });

    it("sends only the changed fields of a tool call update from any emission site", async () => {
        const {client, notify} = createClient();
        const connection = new AcpClientDelivery(client).asClientConnection();
        await connection.notify(acp.methods.client.session.update, {
            sessionId: "s",
            update: {sessionUpdate: "tool_call", toolCallId: "t", title: "Guardian Review", status: "in_progress"},
        });
        await connection.notify(acp.methods.client.session.update, {
            sessionId: "s",
            update: {sessionUpdate: "tool_call_update", toolCallId: "t", title: "Guardian Review", status: "completed"},
        });

        expect(notify.mock.calls[1]).toEqual([acp.methods.client.session.update, {
            sessionId: "s",
            update: {sessionUpdate: "tool_call_update", toolCallId: "t", status: "completed"},
        }]);
    });

    it("drops an update that repeats every reported field", async () => {
        const {client, notify} = createClient();
        const connection = new AcpClientDelivery(client).asClientConnection();
        const update = {sessionUpdate: "tool_call", toolCallId: "t", title: "Search", status: "in_progress"} as const;
        await connection.notify(acp.methods.client.session.update, {sessionId: "s", update});
        await connection.notify(acp.methods.client.session.update, {
            sessionId: "s",
            update: {...update, sessionUpdate: "tool_call_update"},
        });

        expect(notify).toHaveBeenCalledTimes(1);
    });

    it("counts the permission request tool call as a report", async () => {
        const {client, notify, request} = createClient();
        request.mockResolvedValue({outcome: {outcome: "selected", optionId: "allow"}});
        const connection = new AcpClientDelivery(client).asClientConnection();
        await connection.notify(acp.methods.client.session.update, {
            sessionId: "s",
            update: {sessionUpdate: "tool_call", toolCallId: "t", title: "mcp.server.tool", status: "in_progress"},
        });
        await connection.request(acp.methods.client.session.requestPermission, {
            sessionId: "s",
            toolCall: {toolCallId: "t", status: "pending"},
            options: [],
        });
        await connection.notify(acp.methods.client.session.update, {
            sessionId: "s",
            update: {sessionUpdate: "tool_call_update", toolCallId: "t", status: "in_progress"},
        });

        expect(notify.mock.calls[1]![1]).toEqual({
            sessionId: "s",
            update: {sessionUpdate: "tool_call_update", toolCallId: "t", status: "in_progress"},
        });
    });

    for (const [name, answer] of [
        ["cancelled", (request: ReturnType<typeof vi.fn>) => request.mockResolvedValue({outcome: {outcome: "cancelled"}})],
        ["failed", (request: ReturnType<typeof vi.fn>) => request.mockRejectedValue(new Error("closed"))],
    ] as const) {
        it(`sends the fields of a ${name} permission request again in the next update`, async () => {
            const {client, notify, request} = createClient();
            answer(request);
            const connection = new AcpClientDelivery(client).asClientConnection();
            await connection.request(acp.methods.client.session.requestPermission, {
                sessionId: "s",
                toolCall: {toolCallId: "t", title: "Run command", status: "pending", rawInput: {command: "npm test"}},
                options: [],
            }).catch(() => undefined);
            const update = {
                sessionUpdate: "tool_call_update",
                toolCallId: "t",
                title: "Run command",
                status: "failed",
                rawInput: {command: "npm test"},
            } as const;
            await connection.notify(acp.methods.client.session.update, {sessionId: "s", update});

            expect(notify.mock.calls[0]![1]).toEqual({sessionId: "s", update});
        });
    }
});

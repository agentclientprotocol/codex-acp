import {afterEach, describe, expect, it, vi} from "vitest";
import {ACPSessionConnection, type AcpClientConnection} from "../ACPSessionConnection";
import {CodexPlanStream} from "../CodexPlanStream";
import {ClientCapabilities} from "../tool-calls/ClientCapabilities";

function createStream(capabilities: ClientCapabilities) {
    const notify = vi.fn(async (_method: unknown, _params: unknown) => {});
    const session = new ACPSessionConnection({notify, request: vi.fn()} as unknown as AcpClientConnection, "s");
    const updates = () => notify.mock.calls.map(call => (call[1] as {update: unknown}).update);
    return {stream: new CodexPlanStream(session, capabilities), updates};
}

describe("CodexPlanStream", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("sends the whole plan once and then only AIR content deltas", async () => {
        vi.useFakeTimers();
        const {stream, updates} = createStream(ClientCapabilities.DEFAULT.with({
            planUpdates: true,
            air: {planContentDelta: true},
        }));

        stream.delta("plan", "# Plan\n");
        await stream.flush();
        stream.delta("plan", "1. Step");
        await stream.flush();
        await stream.completed("plan", "# Plan\n1. Step");

        expect(updates()).toEqual([
            {sessionUpdate: "plan_update", plan: {type: "markdown", planId: "plan", content: "# Plan\n"}},
            {
                sessionUpdate: "plan_update",
                plan: {type: "markdown", planId: "plan", content: ""},
                _meta: {jetbrains: {air: {version: 1, contentDelta: "1. Step"}}},
            },
        ]);
    });

    it("replaces the plan with a snapshot when the completed plan differs from the streamed text", async () => {
        const {stream, updates} = createStream(ClientCapabilities.DEFAULT.with({
            planUpdates: true,
            air: {planContentDelta: true},
        }));

        stream.delta("plan", "draft");
        await stream.flush();
        await stream.completed("plan", "final");

        expect(updates().at(-1)).toEqual({
            sessionUpdate: "plan_update",
            plan: {type: "markdown", planId: "plan", content: "final"},
        });
    });

    it("sends snapshots to a client without the AIR plan content delta", async () => {
        const {stream, updates} = createStream(ClientCapabilities.DEFAULT.with({planUpdates: true}));

        stream.delta("plan", "# Plan\n");
        await stream.flush();
        stream.delta("plan", "1. Step");
        await stream.flush();

        expect(updates()).toEqual([
            {sessionUpdate: "plan_update", plan: {type: "markdown", planId: "plan", content: "# Plan\n"}},
            {sessionUpdate: "plan_update", plan: {type: "markdown", planId: "plan", content: "# Plan\n1. Step"}},
        ]);
    });

    it("streams message text to AIR without plan updates and sends only the missing end", async () => {
        const {stream} = createStream(ClientCapabilities.DEFAULT.with({airClient: true}));

        const first = stream.delta("plan", "# Plan\n");
        const completed = await stream.completed("plan", "# Plan\n1. Step");

        expect(first).toMatchObject({sessionUpdate: "agent_message_chunk", content: {text: "# Plan\n"}});
        expect(completed).toMatchObject({
            text: "# Plan\n1. Step",
            update: {sessionUpdate: "agent_message_chunk", content: {text: "1. Step"}},
        });
    });

    it("sends the whole plan once to another client without plan updates", async () => {
        const {stream} = createStream(ClientCapabilities.DEFAULT);

        const first = stream.delta("plan", "# Plan\n");
        const completed = await stream.completed("plan", "# Plan\n1. Step");

        expect(first).toBeNull();
        expect(completed).toEqual({
            text: "# Plan\n1. Step",
            update: {sessionUpdate: "agent_message_chunk", messageId: "plan", content: {type: "text", text: "# Plan\n1. Step"}},
        });
    });
});

import {beforeEach, describe, expect, it, vi} from "vitest";
import type {ServerNotification} from "../../app-server";
import type {TokenUsageBreakdown} from "../../app-server/v2";
import {createCodexMockTestFixture, createTestSessionState} from "../acp-test-utils";

const threadId = "accounting-thread";
const request = {sessionId: threadId, prompt: [{type: "text" as const, text: "test"}]};

function count(input: number, output: number, cached = 0): TokenUsageBreakdown {
    return {totalTokens: input + output, inputTokens: input, cachedInputTokens: cached,
        cacheWriteInputTokens: 0, outputTokens: output, reasoningOutputTokens: 0};
}

function usage(turnId: string, total: TokenUsageBreakdown, last = total): ServerNotification {
    return {method: "thread/tokenUsage/updated", params: {
        threadId, turnId, tokenUsage: {total, last, modelContextWindow: 128000},
    }};
}

describe("prompt usage accounting", () => {
    let fixture: ReturnType<typeof createCodexMockTestFixture>;
    beforeEach(() => {
        vi.clearAllMocks();
        fixture = createCodexMockTestFixture();
        vi.spyOn(fixture.getCodexAcpAgent(), "getSessionState")
            .mockReturnValue(createTestSessionState({sessionId: threadId}));
    });

    function turn(turnId: string, events: ServerNotification[], status = "completed") {
        fixture.getCodexAppServerClient().turnStart = vi.fn().mockResolvedValue({
            turn: {id: turnId, items: [], status: "inProgress", error: null},
        });
        fixture.getCodexAppServerClient().awaitTurnCompleted = vi.fn().mockImplementation(async () => {
            for (const event of events) fixture.sendServerNotification(event);
            return {threadId, turn: {id: turnId, items: [], status, error: null}};
        });
        return fixture.getCodexAcpAgent().prompt(request);
    }

    it("counts identical requests separately and replayed snapshots once", async () => {
        const first = usage("one", count(100, 20, 30));
        const second = usage("one", count(200, 40, 60), count(100, 20, 30));
        const result = await turn("one", [first, first, second, second]);
        expect(result.usage).toEqual({totalTokens: 240, inputTokens: 140,
            cachedReadTokens: 60, outputTokens: 40, thoughtTokens: 0});
        expect(result._meta?.["quota"]).toMatchObject({token_count: {totalTokens: 240}});
        expect(result._meta?.["usageAccounting"]).toMatchObject({scope: "root_thread_prompt", completeness: "reported"});
    });

    it("does not charge a previous prompt again", async () => {
        await turn("one", [usage("one", count(100, 20))]);
        const result = await turn("two", [
            usage("one", count(100, 20)), // delayed historical notification
            usage("two", count(300, 50), count(200, 30)),
            usage("two", count(600, 90), count(300, 40)),
        ]);
        expect(result.usage?.totalTokens).toBe(570);
    });

    it("uses a live turn baseline after load, resume, or fork without in-memory counters", async () => {
        fixture.getCodexAcpAgent().getSessionState(threadId).totalTokenUsage = null;
        fixture.sendServerNotification(usage("historic", count(50000, 5000)));
        const result = await turn("resumed", [
            usage("resumed", count(50100, 5020), count(100, 20)),
            usage("resumed", count(50300, 5050), count(200, 30)),
        ]);
        expect(result.usage?.totalTokens).toBe(350);
    });

    it("does not charge a rate-limit-only snapshot at the beginning of the next turn", async () => {
        await turn("one", [usage("one", count(100, 20))]);
        const result = await turn("two", [
            usage("two", count(100, 20)), // same history, attributed to the new active turn
            usage("two", count(300, 50), count(200, 30)),
        ]);
        expect(result.usage?.totalTokens).toBe(230);
    });

    it("keeps a missing resume baseline partial instead of charging historical last usage", async () => {
        fixture.getCodexAcpAgent().getSessionState(threadId).totalTokenUsage = null;
        const result = await turn("resumed", [
            usage("resumed", count(50000, 5000), count(100, 20)),
            usage("resumed", count(50200, 5030), count(200, 30)),
        ]);
        expect(result.usage?.totalTokens).toBe(230);
        expect(result._meta?.["usageAccounting"]).toMatchObject({completeness: "partial"});
    });

    it("reports missing usage instead of borrowing the last prompt", async () => {
        await turn("one", [usage("one", count(100, 20))]);
        const result = await turn("two", []);
        expect(result.usage).toBeNull();
        expect(result._meta?.["usageAccounting"]).toMatchObject({completeness: "partial"});
    });

    it("retains all observed requests when cancelled", async () => {
        const result = await turn("one", [
            usage("one", count(100, 20)),
            usage("one", count(300, 50), count(200, 30)),
        ], "interrupted");
        expect(result.stopReason).toBe("cancelled");
        expect(result.usage?.totalTokens).toBe(350);
        expect(result._meta?.["usageAccounting"]).toMatchObject({completeness: "partial"});
    });

    it("retains observed usage on a typed failed turn", async () => {
        await fixture.getCodexAcpAgent().initialize({protocolVersion: 1, clientCapabilities: {
            _meta: {jetbrains: {air: {version: 1, capabilities: ["sessionFailure"]}}},
        }});
        const result = await turn("one", [usage("one", count(100, 20))], "failed");
        expect(result.usage?.totalTokens).toBe(120);
        expect(result._meta?.["usageAccounting"]).toMatchObject({completeness: "partial"});
        expect(result._meta?.["jetbrains"]).toMatchObject({air: {sessionFailure: {severity: "error"}}});
    });

    it("preserves known usage and marks counter replacement incomplete", async () => {
        const result = await turn("one", [
            usage("one", count(100, 20)),
            usage("one", count(0, 0)),
            usage("one", count(200, 30)),
        ]);
        expect(result.usage?.totalTokens).toBe(350);
        expect(result._meta?.["usageAccounting"]).toMatchObject({completeness: "partial"});
    });

    it("rejects synthetic context-full totals without inference counts", async () => {
        const synthetic = {...count(0, 0), totalTokens: 128000};
        const result = await turn("one", [usage("one", count(100, 20)), usage("one", synthetic)]);
        expect(result.usage?.totalTokens).toBe(120);
        expect(result._meta?.["usageAccounting"]).toMatchObject({completeness: "partial"});
    });
});

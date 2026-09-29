import {describe, expect, it, vi} from "vitest";
import type {ServerNotification} from "../../app-server";
import type {Turn} from "../../app-server/v2";
import {createCodexMockTestFixture, createTestSessionState} from "../acp-test-utils";

const sessionId = "compact-command-session";
const turnId = "compact-command-turn";

describe("compact command lifecycle", () => {
    it.each(["interrupted", "failed"] as const)("captures an early %s turn before compact acknowledgement", async (status) => {
        const fixture = createCodexMockTestFixture();
        const appServer = fixture.getCodexAppServerClient();
        const completed = turnCompleted(status);
        vi.spyOn(appServer, "threadCompactStart").mockImplementation(async () => {
            fixture.sendServerNotification({method: "turn/started", params: {threadId: sessionId, turn: turn("inProgress")}});
            fixture.sendServerNotification(completed);
            return {};
        });
        const onTurnStarted = vi.fn();

        await expect(appServer.runCompact({threadId: sessionId}, onTurnStarted)).resolves.toEqual(completed);
        expect(onTurnStarted).toHaveBeenCalledExactlyOnceWith(turnId);
    });

    it("waits for the compact turn when another turn finishes", async () => {
        const fixture = createCodexMockTestFixture();
        const appServer = fixture.getCodexAppServerClient();
        vi.spyOn(appServer, "threadCompactStart").mockResolvedValue({});
        let settled = false;
        const pending = appServer.runCompact({threadId: sessionId}).then(result => {
            settled = true;
            return result;
        });
        // The preceding compact prompt may resolve on item/completed before this
        // previous turn/completed reaches the next compact request.
        fixture.sendServerNotification({
            method: "turn/completed",
            params: {threadId: sessionId, turn: {...turn("completed"), id: "previous-turn"}},
        });
        await Promise.resolve();
        expect(settled).toBe(false);
        fixture.sendServerNotification({method: "turn/started", params: {threadId: sessionId, turn: turn("inProgress")}});
        fixture.sendServerNotification({
            method: "item/completed",
            params: {
                threadId: sessionId, turnId: "other-turn", completedAtMs: 1,
                item: {type: "contextCompaction", id: "other-compaction"},
            },
        });
        fixture.sendServerNotification({
            method: "turn/completed",
            params: {threadId: sessionId, turn: {...turn("interrupted"), id: "other-turn"}},
        });
        await Promise.resolve();
        expect(settled).toBe(false);

        const completed: ServerNotification = {
            method: "item/completed",
            params: {
                threadId: sessionId, turnId, completedAtMs: 2,
                item: {type: "contextCompaction", id: "compaction-item"},
            },
        };
        fixture.sendServerNotification(completed);
        await expect(pending).resolves.toEqual(completed);
    });

    it("releases compact observation after the request is rejected", async () => {
        const fixture = createCodexMockTestFixture();
        const appServer = fixture.getCodexAppServerClient();
        const start = vi.spyOn(appServer, "threadCompactStart").mockRejectedValueOnce(new Error("Cannot compact"));
        const onTurnStarted = vi.fn();
        await expect(appServer.runCompact({threadId: sessionId}, onTurnStarted)).rejects.toThrow("Cannot compact");
        fixture.sendServerNotification({method: "turn/started", params: {threadId: sessionId, turn: turn("inProgress")}});
        fixture.sendServerNotification(turnCompleted("interrupted"));
        expect(onTurnStarted).not.toHaveBeenCalled();

        start.mockResolvedValue({});
        const retry = appServer.runCompact({threadId: sessionId});
        const completed: ServerNotification = {method: "thread/compacted", params: {threadId: sessionId, turnId}};
        fixture.sendServerNotification(completed);
        await expect(retry).resolves.toEqual(completed);
    });

    it("rejects a compact wait when the Codex connection closes", async () => {
        const fixture = createCodexMockTestFixture();
        const appServer = fixture.getCodexAppServerClient();
        vi.spyOn(appServer, "threadCompactStart").mockResolvedValue({});
        let close = () => {};
        const dispose = vi.fn();
        appServer.connection.onClose = vi.fn(listener => {
            close = () => listener(undefined);
            return {dispose};
        });
        const pending = appServer.runCompact({threadId: sessionId});
        await Promise.resolve();
        close();

        await expect(pending).rejects.toThrow("Codex connection closed during compaction.");
        expect(dispose).toHaveBeenCalledOnce();
    });

    it("cancels the manual compact turn and finishes the ACP prompt", async () => {
        const fixture = await commandFixture();
        const appServer = fixture.getCodexAppServerClient();
        const start = vi.spyOn(appServer, "threadCompactStart").mockResolvedValue({});
        const interrupt = vi.spyOn(appServer, "turnInterrupt").mockImplementation(async () => {
            fixture.sendServerNotification(turnCompleted("interrupted"));
            return {};
        });
        const prompt = fixture.getCodexAcpAgent().prompt({sessionId, prompt: [{type: "text", text: "/compact"}]});
        await vi.waitFor(() => expect(start).toHaveBeenCalled());
        startCompaction(fixture);
        await fixture.getCodexAcpClient().waitForSessionNotifications(sessionId);

        await fixture.getCodexAcpAgent().cancel({sessionId});
        expect(interrupt).toHaveBeenCalledWith({threadId: sessionId, turnId});
        await expect(prompt).resolves.toMatchObject({stopReason: "cancelled"});
        expect(fixture.getAcpConnectionDump([])).toContain('"status": "cancelled"');
    });

    it("returns the failed compact turn through ACP failure handling", async () => {
        const fixture = await commandFixture();
        const start = vi.spyOn(fixture.getCodexAppServerClient(), "threadCompactStart").mockResolvedValue({});
        const prompt = fixture.getCodexAcpAgent().prompt({sessionId, prompt: [{type: "text", text: "/compact"}]});
        await vi.waitFor(() => expect(start).toHaveBeenCalled());
        startCompaction(fixture);
        fixture.sendServerNotification(turnCompleted("failed"));

        await expect(prompt).resolves.toMatchObject({
            _meta: {jetbrains: {air: {sessionFailure: {severity: "error"}}}},
        });
        expect(fixture.getAcpConnectionDump([])).toContain('"status": "failed"');
    });
});

async function commandFixture() {
    const fixture = createCodexMockTestFixture();
    const session = createTestSessionState({sessionId});
    vi.spyOn(fixture.getCodexAcpAgent(), "getSessionState")
        .mockReturnValue(session);
    // @ts-expect-error - registering local session state for the ACP cancel path
    fixture.getCodexAcpAgent().sessions.set(sessionId, session);
    await fixture.getCodexAcpAgent().initialize({
        protocolVersion: 1,
        clientCapabilities: {
            session: {compaction: {}},
            _meta: {jetbrains: {air: {version: 1, capabilities: ["sessionFailure"]}}},
        },
    });
    fixture.clearAcpConnectionDump();
    return fixture;
}

function startCompaction(fixture: ReturnType<typeof createCodexMockTestFixture>) {
    fixture.sendServerNotification({method: "turn/started", params: {threadId: sessionId, turn: turn("inProgress")}});
    fixture.sendServerNotification({
        method: "item/started",
        params: {threadId: sessionId, turnId, startedAtMs: 0, item: {type: "contextCompaction", id: "compaction-item"}},
    });
}

function turnCompleted(status: "failed" | "interrupted"): Extract<ServerNotification, {method: "turn/completed"}> {
    return {method: "turn/completed", params: {threadId: sessionId, turn: turn(status)}};
}

function turn(status: Turn["status"]): Turn {
    return {
        id: turnId, items: [], itemsView: "full", status,
        error: status === "failed" ? {
            message: "Compaction service failed.", codexErrorInfo: "serverOverloaded", additionalDetails: null, misalignment: null,
        } : null,
        startedAt: null, completedAt: null, durationMs: null,
    };
}

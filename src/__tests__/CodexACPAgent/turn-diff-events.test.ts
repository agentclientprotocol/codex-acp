import {describe, expect, it, vi} from "vitest";
import type {ServerNotification} from "../../app-server";
import type {AcpClientConnection} from "../../ACPSessionConnection";
import {createTestEventHandler, createTestSessionState} from "../acp-test-utils";
import {AGENT_FILE_CHANGE_REPORT_MAX_DIFF_BYTES} from "../../AgentFileChangeReport";

describe("CodexEventHandler - turn diff events", () => {
    const sessionId = "root-thread";

    function createHandler(collectTurnDiffs: boolean) {
        const sessionState = createTestSessionState({
            sessionId,
            currentTurnId: "turn-1",
            account: {type: "apiKey"},
        });
        const connection = {
            notify: vi.fn(async () => {}),
            request: vi.fn(),
        } as unknown as AcpClientConnection;
        const handler = createTestEventHandler(connection, sessionState, {typedSessionFailures: true, collectTurnDiffs});
        return {handler, sessionState};
    }

    function turnDiff(threadId: string, diff: string): ServerNotification {
        return {
            method: "turn/diff/updated",
            params: {threadId, turnId: "turn-1", diff},
        };
    }

    it("retains root-thread diffs only when collection was negotiated", async () => {
        const disabled = createHandler(false).handler;
        await disabled.handleNotification(turnDiff(sessionId, "disabled diff"));
        expect(disabled.getTurnDiff("turn-1")).toBe("");

        const enabled = createHandler(true).handler;
        await enabled.handleNotification(turnDiff("child-thread", "child diff"));
        expect(enabled.getTurnDiff("turn-1")).toBe("");

        await enabled.handleNotification(turnDiff(sessionId, "root diff"));
        expect(enabled.getTurnDiff("turn-1")).toBe("root diff");
    });

    it("clears a prior snapshot when Codex emits the final empty aggregate", async () => {
        const {handler} = createHandler(true);
        await handler.handleNotification(turnDiff(sessionId, "root diff"));

        await handler.handleNotification(turnDiff(sessionId, ""));

        expect(handler.getTurnDiff("turn-1")).toBe("");
    });

    it("retains only a marker for an oversized aggregate", async () => {
        const {handler} = createHandler(true);
        await handler.handleNotification(turnDiff(
            sessionId,
            "x".repeat(AGENT_FILE_CHANGE_REPORT_MAX_DIFF_BYTES + 1),
        ));

        expect(handler.getTurnDiff("turn-1")).toBe("");
        expect(handler.isTurnDiffOversized("turn-1")).toBe(true);

        await handler.handleNotification(turnDiff(sessionId, "replacement"));
        expect(handler.getTurnDiff("turn-1")).toBe("replacement");
        expect(handler.isTurnDiffOversized("turn-1")).toBe(false);
    });

    it("discards retained diffs when disposed", async () => {
        const {handler} = createHandler(true);
        await handler.handleNotification(turnDiff(sessionId, "root diff"));

        await handler.dispose();
        await handler.handleSessionScopedNotification(turnDiff(sessionId, "late diff"));

        expect(handler.getTurnDiff("turn-1")).toBe("");
    });

    it("treats a root-thread diff as progress even when collection is disabled", async () => {
        const {handler, sessionState} = createHandler(false);
        await handler.handleNotification({
            method: "error",
            params: {
                threadId: sessionId,
                turnId: "turn-1",
                willRetry: true,
                error: {
                    message: "Provider stream disconnected",
                    codexErrorInfo: {responseStreamDisconnected: {httpStatusCode: null}},
                    additionalDetails: null,
                    misalignment: null,
                },
            },
        });
        expect(sessionState.sessionFailure).toMatchObject({severity: "warning"});

        await handler.handleNotification(turnDiff(sessionId, "recovered diff"));

        expect(sessionState.sessionFailure).toBeUndefined();
        expect(handler.getTurnDiff("turn-1")).toBe("");
    });

    it("does not treat a child-thread diff as root-turn progress", async () => {
        const {handler, sessionState} = createHandler(true);
        await handler.handleNotification({
            method: "error",
            params: {
                threadId: sessionId,
                turnId: "turn-1",
                willRetry: true,
                error: {
                    message: "Provider stream disconnected",
                    codexErrorInfo: {responseStreamDisconnected: {httpStatusCode: null}},
                    additionalDetails: null,
                    misalignment: null,
                },
            },
        });

        await handler.handleNotification(turnDiff("child-thread", "child diff"));

        expect(sessionState.sessionFailure).toMatchObject({severity: "warning"});
        expect(handler.getTurnDiff("turn-1")).toBe("");
    });
});

import {describe, expect, it, vi} from "vitest";
import type {ServerNotification} from "../../app-server";
import type {AcpClientConnection} from "../../ACPSessionConnection";
import {CodexEventHandler} from "../../CodexEventHandler";
import {createTestSessionState} from "../acp-test-utils";

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
        const handler = new CodexEventHandler(
            connection,
            sessionState,
            false,
            true,
            "test-epoch",
            undefined,
            undefined,
            collectTurnDiffs,
        );
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

    it("discards retained diffs when disposed", async () => {
        const {handler} = createHandler(true);
        await handler.handleNotification(turnDiff(sessionId, "root diff"));

        await handler.dispose();

        expect(handler.getTurnDiff("turn-1")).toBe("");
    });

    it("treats a root-thread diff as progress after a retry warning", async () => {
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
        expect(sessionState.sessionFailure).toMatchObject({severity: "warning"});

        await handler.handleNotification(turnDiff(sessionId, "recovered diff"));

        expect(sessionState.sessionFailure).toBeUndefined();
        expect(handler.getTurnDiff("turn-1")).toBe("recovered diff");
    });
});

import { describe, expect, it, vi } from "vitest";
import type { ServerNotification } from "../../app-server";
import { setupPromptTestSession } from "../acp-test-utils";

describe("CodexEventHandler - session info updates", () => {
    const sessionId = "test-session-id";

    it("uses the first user prompt as a fallback session title", async () => {
        const { mockFixture } = setupPromptTestSession({
            sessionId,
            sessionTitleSource: "unset",
        });

        await mockFixture.getCodexAcpAgent().prompt({
            sessionId,
            prompt: [
                { type: "text", text: "  Fix the flaky\n test  " },
                { type: "text", text: "in CI" },
            ],
        });

        await expect(`${mockFixture.getAcpConnectionDump([])}\n`).toMatchFileSnapshot(
            "data/session-info-update-fallback-title.json"
        );
    });

    it("does not replace an explicit session title with the prompt fallback", async () => {
        const { mockFixture } = setupPromptTestSession({
            sessionId,
            sessionTitle: "Explicit title",
            sessionTitleSource: "explicit",
        });

        await mockFixture.getCodexAcpAgent().prompt({
            sessionId,
            prompt: [{ type: "text", text: "Fallback title" }],
        });

        expect(mockFixture.getAcpConnectionEvents([])).toEqual([]);
    });

    it("maps thread name updates to ACP session info updates", async () => {
        const { mockFixture } = setupPromptTestSession({ sessionId });

        await mockFixture.getCodexAcpAgent().prompt({
            sessionId,
            prompt: [{ type: "text", text: "test" }],
        });

        mockFixture.clearAcpConnectionDump();

        const notifications: ServerNotification[] = [
            {
                method: "thread/name/updated",
                params: {
                    threadId: sessionId,
                    threadName: "Renamed session",
                },
            },
            {
                method: "thread/name/updated",
                params: {
                    threadId: sessionId,
                },
            },
        ];

        for (const notification of notifications) {
            mockFixture.sendServerNotification(notification);
        }

        await vi.waitFor(() => {
            expect(mockFixture.getAcpConnectionEvents([])).toHaveLength(2);
        });

        await expect(`${mockFixture.getAcpConnectionDump([])}\n`).toMatchFileSnapshot(
            "data/session-info-update-title.json"
        );
    });

    it("maps Codex thread lifecycle metadata to ACP session info updates", async () => {
        const { mockFixture } = setupPromptTestSession({ sessionId });

        await mockFixture.getCodexAcpAgent().prompt({
            sessionId,
            prompt: [{ type: "text", text: "test" }],
        });

        mockFixture.clearAcpConnectionDump();

        const notifications: ServerNotification[] = [
            {
                method: "thread/status/changed",
                params: {
                    threadId: sessionId,
                    status: {
                        type: "active",
                        activeFlags: ["waitingOnApproval"],
                    },
                },
            },
            {
                method: "thread/archived",
                params: {
                    threadId: sessionId,
                },
            },
            {
                method: "thread/unarchived",
                params: {
                    threadId: sessionId,
                },
            },
            {
                method: "thread/closed",
                params: {
                    threadId: sessionId,
                },
            },
        ];

        for (const notification of notifications) {
            mockFixture.sendServerNotification(notification);
        }

        await vi.waitFor(() => {
            expect(mockFixture.getAcpConnectionEvents([])).toHaveLength(4);
        });

        await expect(`${mockFixture.getAcpConnectionDump([])}\n`).toMatchFileSnapshot(
            "data/session-info-update-metadata.json"
        );
    });
});

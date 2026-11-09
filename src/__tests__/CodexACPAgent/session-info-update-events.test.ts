import { describe, expect, it, vi } from "vitest";
import type { ServerNotification } from "../../app-server";
import { setupPromptTestSession } from "../acp-test-utils";
import { MAX_SESSION_TITLE_LENGTH } from "../../SessionTitle";

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

    it("cuts a long fallback session title to the limit", async () => {
        const { mockFixture } = setupPromptTestSession({
            sessionId,
            sessionTitleSource: "unset",
        });

        await mockFixture.getCodexAcpAgent().prompt({
            sessionId,
            prompt: [{ type: "text", text: "a".repeat(25_023) }],
        });

        expect(mockFixture.getAcpConnectionEvents([])).toContainEqual({
            method: "sessionUpdate",
            args: [{ sessionId, update: { sessionUpdate: "session_info_update", title: `${"a".repeat(MAX_SESSION_TITLE_LENGTH - 1)}…` } }],
        });
    });

    it("cuts a long thread name to the limit", async () => {
        const { mockFixture } = setupPromptTestSession({ sessionId });

        await mockFixture.getCodexAcpAgent().prompt({
            sessionId,
            prompt: [{ type: "text", text: "test" }],
        });

        mockFixture.clearAcpConnectionDump();

        mockFixture.sendServerNotification({
            method: "thread/name/updated",
            params: {
                threadId: sessionId,
                threadName: "b".repeat(1_000),
            },
        });

        await vi.waitFor(() => {
            expect(mockFixture.getAcpConnectionEvents([])).toContainEqual({
                method: "sessionUpdate",
                args: [{ sessionId, update: { sessionUpdate: "session_info_update", title: `${"b".repeat(MAX_SESSION_TITLE_LENGTH - 1)}…` } }],
            });
        });
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

    it("ignores a late automatic title echo after a sessionIndex rename", async () => {
        const { mockFixture } = setupPromptTestSession({
            sessionId,
            sessionTitle: "Explicit",
            sessionTitleSource: "explicit",
            sessionIndexExplicitTitle: "Explicit",
            automaticTitleEcho: "Automatic",
        });
        await mockFixture.getCodexAcpAgent().prompt({ sessionId, prompt: [{ type: "text", text: "test" }] });
        mockFixture.clearAcpConnectionDump();

        mockFixture.sendServerNotification({ method: "thread/name/updated", params: { threadId: sessionId, threadName: "Automatic" } });
        mockFixture.sendServerNotification({ method: "thread/name/updated", params: { threadId: sessionId, threadName: "Explicit" } });

        await vi.waitFor(() => {
            expect(mockFixture.getAcpConnectionEvents([])).toEqual([{
                method: "sessionUpdate",
                args: [{ sessionId, update: { sessionUpdate: "session_info_update", title: "Explicit" } }],
            }]);
        });
    });

    it("shows a later rename from elsewhere after a sessionIndex rename", async () => {
        const { mockFixture } = setupPromptTestSession({
            sessionId,
            sessionTitle: "Explicit",
            sessionTitleSource: "explicit",
            sessionIndexExplicitTitle: "Explicit",
            automaticTitleEcho: "Automatic",
        });
        await mockFixture.getCodexAcpAgent().prompt({ sessionId, prompt: [{ type: "text", text: "test" }] });
        mockFixture.clearAcpConnectionDump();

        for (const threadName of ["Explicit", "From the TUI", "Automatic"]) {
            mockFixture.sendServerNotification({ method: "thread/name/updated", params: { threadId: sessionId, threadName } });
        }

        await vi.waitFor(() => {
            expect(mockFixture.getAcpConnectionEvents([]).map(event => event.args[0].update.title))
                .toEqual(["Explicit", "From the TUI", "Automatic"]);
        });
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

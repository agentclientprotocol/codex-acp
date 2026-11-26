import { describe, expect, it, vi } from "vitest";
import type { ServerNotification } from "../../app-server";
import type { TurnCompletedNotification } from "../../app-server/v2";
import { deferred, setupPromptTestSession } from "../acp-test-utils";
import { MAX_SESSION_TITLE_LENGTH } from "../../SessionTitle";
import {
    connectSession, createThread, createTurn, itemCompleted, itemStarted, sessionId as wireSessionId, titleThreadId,
    turnCompleted, turnStarted, userMessageItem, type PromptSession,
} from "./v2-prompt-harness";

function publishedTitles(client: PromptSession) {
    return client.scopedUpdates.flatMap(({sessionId, update}) =>
        sessionId === wireSessionId && update.sessionUpdate === "session_info_update" && update.title ? [update.title] : []);
}

describe("CodexEventHandler - session info updates", () => {
    const sessionId = "test-session-id";

    it.each([
        {version: 1, save: "succeeds"}, {version: 2, save: "succeeds"},
        {version: 1, save: "fails"}, {version: 2, save: "fails"},
    ] as const)("publishes one title on ACP v$version when saving it $save", async ({version, save}) => {
        const client = await connectSession(version);
        try {
            const start = vi.spyOn(client.appServer, "turnStart");
            const accepted = deferred<void>();
            client.setTurnStart(async () => {
                await accepted.promise;
                return {turn: createTurn("inProgress")};
            });
            client.setCodexResponse("thread/name/set", async params => {
                const {threadId, name} = params as {threadId: string; name: string};
                if (save === "fails") throw new Error("Cannot save the generated title");
                client.emit({method: "thread/name/updated", params: {threadId, threadName: name}});
                return {};
            });
            const response = client.sendPrompt([
                {type: "text", text: "Fix the flaky test in CI"},
                {type: "resource", resource: {uri: "file:///build.log", text: "BUILD_LOG_CONTENT"}},
            ]);
            await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
            const main = start.mock.calls[0]![0];
            const user = {type: "userMessage" as const, id: "user", clientId: main.clientUserMessageId ?? null, content: main.input};
            client.emit(turnStarted("unrelated-turn"));
            client.emit(itemCompleted(userMessageItem(null), "unrelated-turn"));
            client.emit(turnCompleted("unrelated-turn"));
            client.emit(turnStarted());
            client.emit(itemStarted(user));
            await client.waitForNotifications();
            expect(start).toHaveBeenCalledTimes(1);
            expect(publishedTitles(client)).toEqual([]);

            client.emit(itemCompleted(user));
            client.emit(itemCompleted(user));
            await client.waitForNotifications();
            accepted.resolve();
            await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2));
            const titleRequest = start.mock.calls[1]![0];
            expect(titleRequest.threadId).toBe(titleThreadId);
            expect(titleRequest.input[0]).toMatchObject({text: expect.stringContaining("Fix the flaky test in CI")});
            expect(JSON.stringify(titleRequest.input)).not.toMatch(/build\.log|BUILD_LOG_CONTENT/);
            expect(publishedTitles(client)).toEqual([]);
            if (save === "fails") {
                client.emit(turnCompleted());
                await response;
                await client.promptRunFinished();
                expect(publishedTitles(client)).toEqual([]);
            }
            client.emit({method: "turn/completed", params: {threadId: titleThreadId, turn: {
                ...createTurn("completed", "title-turn"), items: [{
                    type: "agentMessage", id: "title", text: '{"title":"Stabilize CI tests"}',
                    phase: null, memoryCitation: null, moderation: null, delivery: null, questions: null,
                }],
            }}});
            await vi.waitFor(() => expect(publishedTitles(client)).toEqual([save === "succeeds" ? "Stabilize CI tests" : "Fix the flaky test in CI"]));
            if (save === "succeeds") {
                client.emit(turnCompleted());
                await response;
                await client.promptRunFinished();
            }
            expect(start).toHaveBeenCalledTimes(2);
        } finally {
            client.connection.close();
        }
    });

    it.each([
        {version: 1, fails: "during"}, {version: 2, fails: "during"},
        {version: 1, fails: "after"}, {version: 2, fails: "after"},
    ] as const)("uses the original prompt if naming fails $fails reopening an ACP v$version session", async ({version, fails}) => {
        const client = await connectSession(version);
        try {
            const titleTurn = deferred<TurnCompletedNotification>();
            const run = vi.spyOn(client.appServer, "runTurn").mockReturnValueOnce(titleTurn.promise);
            const generator = client.agent.getSessionState(wireSessionId).titleGen!;
            const replayFinished = vi.spyOn(generator, "waitForIdle");
            generator.onUserMessage("Original ACP prompt");
            await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());

            const thread = {...createThread(), preview: "Provider preview including attachments"};
            const readingThread = deferred<void>();
            const releaseRead = deferred<void>();
            client.setCodexResponse("thread/resume", async () => {
                readingThread.resolve();
                await releaseRead.promise;
                return {thread, model: "gpt-5", modelProvider: "openai", reasoningEffort: "medium", serviceTier: null, turnsBackwardsCursor: null};
            });
            client.setCodexResponse("thread/read", async () => ({thread}));
            const reopen = client.request(version === 1 ? "session/load" : "session/resume", {
                sessionId: wireSessionId, cwd: thread.cwd, mcpServers: [],
            });
            await readingThread.promise;
            if (fails === "after") {
                releaseRead.resolve();
                if (version === 1) await vi.waitFor(() => expect(replayFinished).toHaveBeenCalledOnce());
                else await reopen;
            }
            expect(publishedTitles(client)).toEqual([]);
            titleTurn.reject(new Error("Title generation failed"));
            await vi.waitFor(() => expect(publishedTitles(client)).toEqual(["Original ACP prompt"]));
            releaseRead.resolve();
            await reopen;
            // A resume snapshot can repeat the fallback that arrived while the thread was being read.
            expect([...new Set(publishedTitles(client))]).toEqual(["Original ACP prompt"]);
        } finally {
            client.connection.close();
        }
    });

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

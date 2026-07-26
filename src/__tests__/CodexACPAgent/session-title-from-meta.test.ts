import {describe, expect, it, vi} from "vitest";
import {createCodexMockTestFixture, createTestModel, type CodexMockTestFixture} from "../acp-test-utils";
import type * as acp from "@agentclientprotocol/sdk";

const threadId = "thread-id";
const sessionTitle = "Fizz · #buzz-dev";

describe("session title from _meta", () => {
    it("names the thread with the title supplied in _meta", async () => {
        const fixture = createFixture();

        await fixture.getCodexAcpAgent().newSession(newSessionRequest({sessionTitle}));

        await expect(fixture.getCodexConnectionDump([])).toMatchFileSnapshot(
            "data/session-new-sets-thread-name.json"
        );
    });

    it("does not name the thread when _meta carries no title", async () => {
        const fixture = createFixture();

        await fixture.getCodexAcpAgent().newSession(newSessionRequest());

        await expect(fixture.getCodexConnectionDump([])).toMatchFileSnapshot(
            "data/session-new-without-thread-name.json"
        );
    });

    it("collapses whitespace in the requested title before naming the thread", async () => {
        const fixture = createFixture();

        await fixture.getCodexAcpAgent().newSession(newSessionRequest({sessionTitle: "  Fizz  ·\n\t#buzz-dev  "}));

        expect(threadNamesSet(fixture)).toEqual([sessionTitle]);
    });

    it("does not name the thread when the requested title is blank", async () => {
        const fixture = createFixture();

        await fixture.getCodexAcpAgent().newSession(newSessionRequest({sessionTitle: " \n\t "}));

        expect(threadNamesSet(fixture)).toEqual([]);
    });

    it("does not name the thread when the requested title is not a string", async () => {
        const fixture = createFixture();

        await fixture.getCodexAcpAgent().newSession(newSessionRequest({sessionTitle: 42}));

        expect(threadNamesSet(fixture)).toEqual([]);
    });

    it("seeds the session title state so a prompt fallback cannot overwrite it", async () => {
        const fixture = createFixture();

        const response = await fixture.getCodexAcpAgent().newSession(newSessionRequest({sessionTitle}));

        expect(fixture.getCodexAcpAgent().getSessionState(response.sessionId)).toMatchObject({
            sessionTitle,
            sessionTitleSource: "explicit",
        });
    });

    it("leaves the title unset when none was requested", async () => {
        const fixture = createFixture();

        const response = await fixture.getCodexAcpAgent().newSession(newSessionRequest());

        expect(fixture.getCodexAcpAgent().getSessionState(response.sessionId)).toMatchObject({
            sessionTitle: null,
            sessionTitleSource: "unset",
        });
    });

    it("creates the session successfully when naming the thread fails", async () => {
        const fixture = createFixture();
        vi.spyOn(fixture.getCodexAppServerClient(), "threadSetName")
            .mockRejectedValue(new Error("thread/name/set is not supported"));

        const response = await fixture.getCodexAcpAgent().newSession(newSessionRequest({sessionTitle}));

        expect(response.sessionId).toBe(threadId);
        // A rejected naming request must not be recorded as an applied title,
        // so a later fallback title is still free to fill the gap.
        expect(fixture.getCodexAcpAgent().getSessionState(threadId)).toMatchObject({
            sessionTitle: null,
            sessionTitleSource: "unset",
        });
    });
});

function newSessionRequest(meta?: Record<string, unknown>): acp.NewSessionRequest {
    // cwd is empty so skill discovery is skipped and the recorded frames hold
    // only what these tests are about.
    return {cwd: "", mcpServers: [], ...(meta ? {_meta: meta} : {})};
}

/** Names carried by the `thread/name/set` frames sent to Codex, in order. */
function threadNamesSet(fixture: CodexMockTestFixture): unknown[] {
    return fixture.getCodexConnectionEvents([])
        .filter(event => event.eventType === "request" && event.method === "thread/name/set")
        .map(event => (event as {params: {name: unknown}}).params.name);
}

/**
 * Fixture whose `thread/start` and `model/list` calls are stubbed at the
 * wrapper level, so they leave no transport frames and the connection dump
 * shows only whether `thread/name/set` was sent.
 */
function createFixture(): CodexMockTestFixture {
    const fixture = createCodexMockTestFixture();
    const codexAcpClient = fixture.getCodexAcpClient();
    const codexAppServerClient = fixture.getCodexAppServerClient();

    vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);
    vi.spyOn(codexAcpClient, "getAccount").mockResolvedValue({account: null, requiresOpenaiAuth: false});
    vi.spyOn(codexAppServerClient, "threadStart").mockResolvedValue({
        thread: {id: threadId} as any,
        model: "model-id",
        reasoningEffort: "medium",
        modelProvider: "openai",
    } as any);
    vi.spyOn(codexAcpClient, "fetchAvailableModels").mockResolvedValue([createTestModel()]);

    return fixture;
}

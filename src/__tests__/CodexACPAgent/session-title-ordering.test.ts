import {describe, expect, it, vi} from "vitest";
import * as acp from "@agentclientprotocol/sdk";
import {CodexAcpClient} from "../../CodexAcpClient";
import {CodexAcpServer} from "../../CodexAcpServer";
import {CodexAppServerClient} from "../../CodexAppServerClient";
import {createMockCodexConnection, createTestModel} from "../acp-test-utils";

const threadId = "thread-id";
const sessionTitle = "Nightly · #release-prep";
const promptText = "Fix the flaky test";

/**
 * These tests drive a real in-process SDK client/agent pair rather than the
 * smart mock, because what is under test is ordering: the SDK client installs
 * its per-session update queue only once `session/new` resolves, and silently
 * drops updates for sessions with no queue attached. An update published from
 * inside the create path is therefore unobservable, and a mock that records
 * every notification it is handed cannot tell the two cases apart.
 */
describe("explicit session title over a real ACP connection", () => {
    it("delivers the requested title to the client after session/new returns", async () => {
        await withConnectedClient(async (ctx) => {
            const session = await startSession(ctx, {sessionTitle});

            await expect(nextSessionTitle(session)).resolves.toBe(sessionTitle);
        });
    });

    it("leaves the first title to the prompt fallback when none was requested", async () => {
        await withConnectedClient(async (ctx) => {
            const session = await startSession(ctx);
            void session.prompt(promptText);

            await expect(nextSessionTitle(session)).resolves.toBe(promptText);
        });
    });

    it("does not follow the requested title with a prompt-derived one", async () => {
        await withConnectedClient(async (ctx) => {
            const session = await startSession(ctx, {sessionTitle});
            await expect(nextSessionTitle(session)).resolves.toBe(sessionTitle);

            expect(await sessionTitlesDuringPrompt(session)).toEqual([]);
        });
    });
});

/** Starts a session, optionally requesting a title through `_meta`. */
async function startSession(ctx: acp.ClientContext, meta?: Record<string, unknown>): Promise<acp.ActiveSession> {
    // cwd is empty so skill discovery is skipped.
    return await ctx.buildSession({cwd: "", mcpServers: [], ...(meta ? {_meta: meta} : {})}).start();
}

/** Title carried by the next `session_info_update` the client observes. */
async function nextSessionTitle(session: acp.ActiveSession): Promise<unknown> {
    while (true) {
        const message = await session.nextUpdate();
        if (message.kind === "stop") {
            throw new Error("prompt turn stopped before a session title arrived");
        }
        if (message.update.sessionUpdate === "session_info_update") {
            return message.update.title;
        }
    }
}

/** Titles carried by `session_info_update`s seen during one prompt turn. */
async function sessionTitlesDuringPrompt(session: acp.ActiveSession): Promise<unknown[]> {
    void session.prompt(promptText);
    const titles: unknown[] = [];
    while (true) {
        const message = await session.nextUpdate();
        if (message.kind === "stop") return titles;
        if (message.update.sessionUpdate === "session_info_update") {
            titles.push(message.update.title);
        }
    }
}

/**
 * Runs `op` against a real ACP connection to a `CodexAcpServer` whose Codex
 * side is stubbed at the wrapper level.
 */
async function withConnectedClient(op: (ctx: acp.ClientContext) => Promise<void>): Promise<void> {
    const codexConnection = createMockCodexConnection();
    const appServerClient = new CodexAppServerClient(codexConnection.connection);
    const codexAcpClient = new CodexAcpClient(appServerClient);

    vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);
    vi.spyOn(codexAcpClient, "getAccount").mockResolvedValue({account: null, requiresOpenaiAuth: false});
    vi.spyOn(codexAcpClient, "fetchAvailableModels").mockResolvedValue([createTestModel()]);
    vi.spyOn(appServerClient, "threadStart").mockResolvedValue({
        thread: {id: threadId} as any,
        model: "model-id",
        reasoningEffort: "medium",
        modelProvider: "openai",
    } as any);
    vi.spyOn(appServerClient, "threadSetName").mockResolvedValue({} as any);
    vi.spyOn(codexAcpClient, "sendPrompt").mockResolvedValue({
        threadId,
        turn: {
            id: "turn-id",
            items: [],
            itemsView: "notLoaded",
            status: "completed",
            error: null,
            startedAt: null,
            completedAt: null,
            durationMs: null,
        },
    } as any);

    let server: CodexAcpServer | null = null;
    const getServer = (): CodexAcpServer => {
        if (!server) throw new Error("agent is not connected");
        return server;
    };
    const agentApp = acp.agent({name: "codex-acp-ordering-test"})
        .onConnect((connection) => {
            server = new CodexAcpServer(connection.client, codexAcpClient, undefined, () => null);
        })
        .onRequest(acp.methods.agent.initialize, (c) => getServer().initialize(c.params))
        .onRequest(acp.methods.agent.session.new, (c) => getServer().newSession(c.params))
        .onRequest(acp.methods.agent.session.prompt, (c) => getServer().prompt(c.params, c.signal));

    await acp.client({name: "ordering-test-client"}).connectWith(agentApp, async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, {protocolVersion: acp.PROTOCOL_VERSION});
        await op(ctx);
    });
}

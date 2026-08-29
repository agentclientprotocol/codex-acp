/**
 * The backend-acceptance marker (`executablemd.session-materialization/v1`).
 *
 * A client that defers creating durable session state until a conversation
 * really exists needs one fact from the adapter: the App Server took the turn.
 * Nothing a turn produces says that — text, a stop reason and a terminal
 * response each say the adapter is talking — so the adapter says it itself, at
 * the one boundary where it becomes true.
 *
 * The shared fixture keeps this marker out of the session updates every other
 * test compares (see `isSessionMaterializationEvent`), so these read it from
 * the accessor that keeps it.
 */
import { describe, expect, it, vi } from "vitest";
import * as acp from "@agentclientprotocol/sdk";
import {
    createCodexMockTestFixture,
    createTestSessionState,
} from "../acp-test-utils";

const SESSION_MATERIALIZATION_META = "executablemd.session-materialization/v1";

function createTurn(status: "inProgress" | "completed", id: string) {
    return {
        id,
        items: [],
        itemsView: "notLoaded" as const,
        status,
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
    };
}

/** One prompt whose turn the App Server starts and completes. */
async function runPrompt(sessionId: string, options: {startTurn?: boolean} = {}) {
    const mockFixture = createCodexMockTestFixture();
    const codexAcpAgent = mockFixture.getCodexAcpAgent();
    const codexAppServerClient = mockFixture.getCodexAppServerClient();
    await codexAcpAgent.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {fs: {readTextFile: false, writeTextFile: false}, terminal: false},
    });
    const sessionState = createTestSessionState({sessionId});
    vi.spyOn(codexAcpAgent, "getSessionState").mockReturnValue(sessionState);
    if (options.startTurn === false) {
        // `turn/start` never answers with a turn, so the backend accepted
        // nothing — the boundary the marker names was never reached.
        vi.spyOn(codexAppServerClient, "turnStart").mockRejectedValue(new Error("turn refused"));
    } else {
        vi.spyOn(codexAppServerClient, "turnStart").mockResolvedValue({
            turn: createTurn("inProgress", "turn-id"),
        });
        vi.spyOn(codexAppServerClient, "awaitTurnCompleted").mockResolvedValue({
            threadId: sessionId,
            turn: createTurn("completed", "turn-id"),
        });
    }
    try {
        await codexAcpAgent.prompt({sessionId, prompt: [{type: "text", text: "hello"}]});
    } catch {
        // A refused turn/start fails the prompt; what these ask about is the
        // marker, and a prompt that raised published none.
    }
    return mockFixture;
}

describe("session materialization marker", () => {
    it("reports acceptance once, on the session whose turn started", async () => {
        const mockFixture = await runPrompt("accepted-session");

        const markers = mockFixture.getSessionMaterializationEvents();
        expect(markers).toHaveLength(1);
        expect(markers[0].args[1]).toEqual({
            sessionId: "accepted-session",
            update: {
                sessionUpdate: "session_info_update",
                _meta: {[SESSION_MATERIALIZATION_META]: {state: "accepted"}},
            },
        });
    });

    it("carries no session information of its own", async () => {
        const mockFixture = await runPrompt("control-only-session");

        const update = mockFixture.getSessionMaterializationEvents()[0].args[1].update;
        // Title and updatedAt are what a `session_info_update` otherwise
        // carries. This one states acceptance and nothing else, so a client
        // reading it as session info reads nothing.
        expect(Object.keys(update).sort()).toEqual(["_meta", "sessionUpdate"]);
    });

    it("publishes nothing when the backend never started a turn", async () => {
        const mockFixture = await runPrompt("refused-session", {startTurn: false});

        expect(mockFixture.getSessionMaterializationEvents()).toEqual([]);
    });

    it("stays out of the session updates a prompt reports", async () => {
        const mockFixture = await runPrompt("separated-session");

        const updates = mockFixture.getAcpConnectionEvents([])
            .filter(event => event.method === "sessionUpdate")
            .map(event => event.args[0].update);
        expect(updates.filter((update: {_meta?: Record<string, unknown>}) =>
            update._meta?.[SESSION_MATERIALIZATION_META] !== undefined)).toEqual([]);
    });
});

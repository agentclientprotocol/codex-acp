// Real codex-acp + real `codex app-server`; the model is a local mock.
// With REWIND_REAL_MODEL=1 it is the real model instead, using the real `~/.codex` (auth and config).
import * as acp from "@agentclientprotocol/sdk/unstable";
import os from "node:os";
import path from "node:path";
import {afterEach, expect, it} from "vitest";
import {legacySetSessionModel} from "../../AcpExtensions";
import {createSpawnedAgentFixture, DEFAULT_TEST_MODEL_ID, type SpawnedAgentFixture} from "../CodexACPAgent/e2e/spawned-agent-fixture";
import {agentText, describeIntegration, expectNoUnscriptedModelRequests, openSession, sendPrompt, stopAll} from "./integration-fixture";
import {type MockResponsesServer, startMockResponsesServer, textResponse} from "./mock-responses-server";

const REWIND = "_session/rewind";
const MARKERS = ["ZEBRA", "MANGO", "COBALT"];
const REAL_MODEL = process.env["REWIND_REAL_MODEL"] === "1";
const REAL_MODEL_TIMEOUT_MS = 300_000;
const RECALL_PROMPT = "RECALL: list every secret word I asked you to remember earlier in this conversation. Reply with only those words.";

/** The mock model: it answers a `RECALL` prompt with the marker words that Codex sent in the conversation. */
function recallingModel(mock: MockResponsesServer, slow?: {prompt: string; release: Promise<void>}): void {
    mock.setResponseHandler(async request => {
        const input = JSON.stringify((request as {input: unknown}).input);
        if (slow && input.includes(slow.prompt)) await slow.release;
        const recalled = MARKERS.filter(marker => input.includes(marker));
        return textResponse(input.includes("RECALL") ? `seen:${recalled.join(",")}` : "ok");
    });
}

async function connectAir(connection: acp.ClientContext, baseUrl: string): Promise<void> {
    await initializeAir(connection);
    await connection.request(acp.methods.agent.authenticate, {
        methodId: "gateway",
        _meta: {gateway: {baseUrl, headers: {}}},
    });
}

async function initializeAir(connection: acp.ClientContext): Promise<void> {
    await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
            fs: {readTextFile: true, writeTextFile: true},
            terminal: true,
            auth: {_meta: {gateway: true}},
            session: {cursors: {}},
            _meta: {jetbrains: {air: {version: 1, capabilities: ["sessionRewind"]}}},
        },
        clientInfo: {name: "vitest", version: "1.0.0"},
    } as acp.InitializeRequest);
}

/** The recalled marker words are loose: the real model words its reply freely. */
function expectRecalled(reply: string, expected: string[]): void {
    const text = reply.toUpperCase();
    for (const marker of MARKERS) {
        if (expected.includes(marker)) expect(text).toContain(marker);
        else expect(text).not.toContain(marker);
    }
}

describeIntegration("integration: _session/rewind", () => {
    let mock: MockResponsesServer | undefined;
    let agent: SpawnedAgentFixture;
    let sessionId: string;

    afterEach(async () => {
        await stopAll(agent, mock);
    });

    async function start(slow?: {prompt: string; release: Promise<void>}): Promise<void> {
        if (REAL_MODEL) {
            // Authentication stays whatever `~/.codex` already has, so there is no `authenticate` call.
            agent = await createSpawnedAgentFixture(
                connection => initializeAir(connection),
                {CODEX_HOME: path.join(os.homedir(), ".codex")},
            );
            ({sessionId} = await agent.createSession());
            await legacySetSessionModel(agent.connection, {sessionId, modelId: DEFAULT_TEST_MODEL_ID.toString()});
            console.log(`[rewind real model] ${DEFAULT_TEST_MODEL_ID} thread ${sessionId}`);
            return;
        }
        const server = mock = await startMockResponsesServer();
        recallingModel(server, slow);
        agent = await createSpawnedAgentFixture(connection => connectAir(connection, server.baseUrl));
        sessionId = await openSession(agent);
    }

    const cursorIds = (): string[] => agent.readSessionUpdates(sessionId)
        .flatMap(update => update.sessionUpdate === "cursor_update" ? [update.cursorId] : []);
    const rewind = (cursorId: string) => agent.connection.request(REWIND, {sessionId, cursorId});

    /** Three turns, one marker word each. Returns the cursor before each turn but the first. */
    async function markedTurns(): Promise<string[]> {
        for (const marker of MARKERS) await sendPrompt(agent, sessionId, `remember the secret word ${marker}. Reply with just "ok".`);
        const cursors = cursorIds();
        expect(cursors).toHaveLength(2);
        return cursors;
    }

    async function recall(): Promise<string> {
        const before = agentText(agent, sessionId).length;
        expect((await sendPrompt(agent, sessionId, RECALL_PROMPT)).stopReason).toBe("end_turn");
        const reply = agentText(agent, sessionId).slice(before);
        if (REAL_MODEL) console.log(`[rewind real model] recall reply: ${JSON.stringify(reply)}`);
        return reply;
    }

    it("rewinds the last turn: the model no longer sees it", async () => {
        await start();
        const [, beforeThird] = await markedTurns();

        const updatesBefore = agent.readSessionUpdates(sessionId).length;
        await expect(rewind(beforeThird!)).resolves.toEqual({rewound: true});

        // The reload that `thread/revert` makes is not the client's business.
        expect(agent.readSessionUpdates(sessionId).slice(updatesBefore)).toEqual([]);
        expectRecalled(await recall(), ["ZEBRA", "MANGO"]);
        await expect(rewind(beforeThird!)).rejects.toMatchObject({code: -32602});
        if (mock) expectNoUnscriptedModelRequests(mock);
    });

    it("rewinds a middle turn: the model sees only the turns before it, and the next turn gets a new cursor", async () => {
        await start();
        const [beforeSecond] = await markedTurns();

        await expect(rewind(beforeSecond!)).resolves.toEqual({rewound: true});

        expectRecalled(await recall(), ["ZEBRA"]);
        expect(cursorIds()).toHaveLength(3);
        expect(cursorIds().at(-1)).not.toBe(beforeSecond);
        if (mock) expectNoUnscriptedModelRequests(mock);
    });

    it("persists the cut: a restarted agent loads the cut history", async () => {
        await start();
        const [beforeSecond] = await markedTurns();
        await expect(rewind(beforeSecond!)).resolves.toEqual({rewound: true});

        agent = await agent.restart();
        // The old app-server may still hold the thread's writer lock; with the shared `~/.codex` that rejects the load.
        if (REAL_MODEL) await new Promise(resolve => setTimeout(resolve, 5_000));
        const replayed = agent.readSessionUpdates(sessionId).length;
        await agent.connection.request(acp.methods.agent.session.load, {sessionId, cwd: agent.workspaceDir, mcpServers: []});

        const replayedUserText = agent.readSessionUpdates(sessionId).slice(replayed)
            .flatMap(update => update.sessionUpdate === "user_message_chunk" && update.content.type === "text" ? [update.content.text] : [])
            .join(" ");
        expect(replayedUserText).toContain("ZEBRA");
        expect(replayedUserText).not.toContain("MANGO");
        expect(replayedUserText).not.toContain("COBALT");
        expectRecalled(await recall(), ["ZEBRA"]);
        if (mock) expectNoUnscriptedModelRequests(mock);
    });

    it("is busy while a prompt runs: nothing is reverted and the turn goes on", async () => {
        let release: () => void = () => {};
        await start({prompt: "SLOW", release: new Promise<void>(resolve => { release = resolve; })});
        const [beforeSecond] = await markedTurns().then(cursors => cursors);
        const slow = sendPrompt(agent, sessionId, REAL_MODEL
            ? "SLOW work: write a 600-word story about a lighthouse keeper."
            : "SLOW work");
        const chunks = () => agent.readSessionUpdates(sessionId).filter(update => update.sessionUpdate === "agent_message_chunk").length;
        if (REAL_MODEL) {
            const chunksBefore = chunks();
            await expect.poll(chunks, {timeout: 60_000}).toBeGreaterThan(chunksBefore);
        } else {
            await expect.poll(() => mock!.requests.some(request => JSON.stringify(request).includes("SLOW work"))).toBe(true);
        }

        await expect(rewind(beforeSecond!)).resolves.toEqual({rewound: false, reason: "busy"});

        release();
        expect((await slow).stopReason).toBe("end_turn");
        expectRecalled(await recall(), MARKERS);
        if (mock) expectNoUnscriptedModelRequests(mock);
    });
}, REAL_MODEL ? REAL_MODEL_TIMEOUT_MS : undefined);

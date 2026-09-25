import {afterEach, describe, expect, it, vi} from 'vitest';
import * as acp from '@agentclientprotocol/sdk';
import * as acpV2 from '@agentclientprotocol/sdk/experimental/v2';
import {OPENAI_PROVIDER_ID} from '../../CodexAcpClient';
import {
    sessionId,
    connectSession,
    createReplacementCodexAcpClient,
    createTurn,
    userMessageItem,
    itemCompleted,
    turnStarted,
    turnCompleted,
    agentMessageDelta,
    settle,
    stateUpdates,
    type PromptSession,
} from './v2-prompt-harness';
import {expectConformingV2SessionUpdates} from './v2-session-update-guard';

function agentMessageChunks(transcript: PromptSession['transcript']) {
    return transcript.flatMap(entry => "sessionUpdate" in entry ? [entry.sessionUpdate] : [])
        .filter(update => update.sessionUpdate === "agent_message_chunk");
}

function setProviderParams() {
    return {
        providerId: OPENAI_PROVIDER_ID,
        apiType: "openai" as const,
        baseUrl: "https://gateway.example/v1",
    };
}

/** Runs a normal prompt to completion on `client`, so `v2PromptsInFlight` no longer owns the session. */
async function runPromptToCompletion(client: PromptSession) {
    const response = client.sendPrompt([{type: "text", text: "Hello"}]);
    await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
    const clientUserMessageId = client.turnStartParams[0]!["clientUserMessageId"] as string;
    client.emit(turnStarted());
    client.emit(itemCompleted(userMessageItem(clientUserMessageId)));
    await response;
    client.emit(turnCompleted());
    await client.promptRunFinished();
    await settle();
}

/**
 * Tests for 10(f2): a provider restart (`providers/set`/`providers/disable`) reinstalls the
 * baseline Codex turn tracker on the replacement client before re-resuming each session (fix 1,
 * reusing 10(f1) plumbing), and closes out a turn left running on the old client with a v2-only
 * `idle`/`cancelled` (fix 2), since the old app-server process's EOF drops the notification and
 * no `turn/completed` for it ever arrives.
 */
describe('provider restart reinstalls the baseline turn tracker', () => {
    let closeClient: (() => void) | null = null;

    afterEach(() => {
        closeClient?.();
        closeClient = null;
        expectConformingV2SessionUpdates();
    });

    it('v2: renders a Codex-started turn after providers/set, for a session never prompted', async () => {
        const client = await connectSession(2);
        closeClient = () => client.connection.close();
        const replacement = createReplacementCodexAcpClient();
        vi.spyOn(client.agent as any, "restartCodexClient").mockResolvedValue(replacement.codexAcpClient);

        await client.request(acpV2.methods.agent.providers.set, setProviderParams());

        replacement.emit(turnStarted());
        replacement.emit(agentMessageDelta("Working on the goal"));
        replacement.emit(turnCompleted());
        await settle();

        expect(stateUpdates(client.transcript)).toEqual([
            {state: "running"},
            {state: "idle", stopReason: "end_turn"},
        ]);
        expect(agentMessageChunks(client.transcript)).toEqual([
            expect.objectContaining({sessionUpdate: "agent_message_chunk"}),
        ]);
    });

    it('v1: renders a Codex-started turn after providers/set, for a session never prompted', async () => {
        const client = await connectSession(1);
        closeClient = () => client.connection.close();
        const replacement = createReplacementCodexAcpClient();
        vi.spyOn(client.agent as any, "restartCodexClient").mockResolvedValue(replacement.codexAcpClient);

        await client.request(acp.methods.agent.providers.set, setProviderParams());

        replacement.emit(turnStarted());
        replacement.emit(agentMessageDelta("Working on the goal"));
        replacement.emit(turnCompleted());
        await settle();

        expect(agentMessageChunks(client.transcript)).toEqual([
            expect.objectContaining({sessionUpdate: "agent_message_chunk"}),
        ]);
    });

    it('v2: also renders a Codex-started turn after restart for a session that had been prompted before it', async () => {
        const client = await connectSession(2);
        closeClient = () => client.connection.close();
        await runPromptToCompletion(client);
        const beforeRestart = client.transcript.length;

        const replacement = createReplacementCodexAcpClient();
        vi.spyOn(client.agent as any, "restartCodexClient").mockResolvedValue(replacement.codexAcpClient);
        await client.request(acpV2.methods.agent.providers.set, setProviderParams());

        replacement.emit(turnStarted("goal-turn"));
        replacement.emit(agentMessageDelta("Working on the goal", "goal-turn"));
        replacement.emit(turnCompleted("goal-turn"));
        await settle();

        const afterRestart = client.transcript.slice(beforeRestart);
        expect(stateUpdates(afterRestart)).toEqual([
            {state: "running"},
            {state: "idle", stopReason: "end_turn"},
        ]);
        expect(agentMessageChunks(afterRestart)).toEqual([
            expect.objectContaining({sessionUpdate: "agent_message_chunk"}),
        ]);
    });

    it('v2: closes out a turn still running at restart with exactly one idle/cancelled, then a later prompt runs normally', async () => {
        const client = await connectSession(2);
        closeClient = () => client.connection.close();

        // An unowned (Codex-started) turn is already running when the restart begins.
        client.emit(turnStarted());
        await settle();
        expect(stateUpdates(client.transcript)).toEqual([{state: "running"}]);

        const replacement = createReplacementCodexAcpClient();
        vi.spyOn(client.agent as any, "restartCodexClient").mockResolvedValue(replacement.codexAcpClient);
        await client.request(acpV2.methods.agent.providers.set, setProviderParams());
        await settle();

        expect(stateUpdates(client.transcript)).toEqual([
            {state: "running"},
            {state: "idle", stopReason: "cancelled"},
        ]);
        const sessions = (client.agent as unknown as {sessions: Map<string, {codexReportedRunningTurnId: string | null}>}).sessions;
        expect(sessions.get(sessionId)?.codexReportedRunningTurnId).toBeNull();

        // isSessionBusy is back to false: a normal prompt through the replacement client still
        // gets a clean running -> idle bracket, with no leftover state from the closed-out turn.
        replacement.setTurnStart(async () => ({turn: createTurn("inProgress", "turn-after-restart")}));
        const promptResponse = client.sendPrompt([{type: "text", text: "Hello"}]);
        await vi.waitFor(() => expect(replacement.turnStartParams).toHaveLength(1));
        const clientUserMessageId = replacement.turnStartParams[0]!["clientUserMessageId"] as string;
        replacement.emit(turnStarted("turn-after-restart"));
        replacement.emit(itemCompleted(userMessageItem(clientUserMessageId), "turn-after-restart"));
        await promptResponse;
        replacement.emit(turnCompleted("turn-after-restart"));
        await client.promptRunFinished();
        await settle();

        expect(stateUpdates(client.transcript).slice(-2)).toEqual([
            {state: "running"},
            {state: "idle", stopReason: "end_turn"},
        ]);
    });

    it('v2: closes out the cut-off turn before a continuation turn Codex auto-starts right after resume', async () => {
        const client = await connectSession(2);
        closeClient = () => client.connection.close();

        // An unowned (Codex-started) turn is already running when the restart begins.
        client.emit(turnStarted());
        await settle();
        expect(stateUpdates(client.transcript)).toEqual([{state: "running"}]);

        const replacement = createReplacementCodexAcpClient();
        vi.spyOn(client.agent as any, "restartCodexClient").mockResolvedValue(replacement.codexAcpClient);

        // Simulate Codex auto-starting a continuation turn moments after `thread/resume`
        // resolves, by emitting its `turn/started` as a side effect of `resumeSession` itself.
        // The close-out for the cut-off turn must happen before this call, not after it.
        const originalResumeSession = replacement.codexAcpClient.resumeSession.bind(replacement.codexAcpClient);
        vi.spyOn(replacement.codexAcpClient, "resumeSession").mockImplementation(async (...args: Parameters<typeof originalResumeSession>) => {
            const result = await originalResumeSession(...args);
            replacement.emit(turnStarted("new-turn"));
            return result;
        });

        await client.request(acpV2.methods.agent.providers.set, setProviderParams());
        await settle();

        expect(stateUpdates(client.transcript)).toEqual([
            {state: "running"},
            {state: "idle", stopReason: "cancelled"},
            {state: "running"},
        ]);
        expect((client.agent as any).isSessionBusy(sessionId)).toBe(true);

        replacement.emit(agentMessageDelta("Working on the goal", "new-turn"));
        replacement.emit(turnCompleted("new-turn"));
        await settle();

        expect(stateUpdates(client.transcript)).toEqual([
            {state: "running"},
            {state: "idle", stopReason: "cancelled"},
            {state: "running"},
            {state: "idle", stopReason: "end_turn"},
        ]);
        expect(agentMessageChunks(client.transcript)).toEqual([
            expect.objectContaining({sessionUpdate: "agent_message_chunk"}),
        ]);
    });

    it('v1: a turn still running at restart gets no new frames from the close-out (v2-only)', async () => {
        const client = await connectSession(1);
        closeClient = () => client.connection.close();

        client.emit(turnStarted());
        await settle();
        const beforeRestart = client.transcript.length;

        const replacement = createReplacementCodexAcpClient();
        vi.spyOn(client.agent as any, "restartCodexClient").mockResolvedValue(replacement.codexAcpClient);
        await client.request(acp.methods.agent.providers.set, setProviderParams());
        await settle();

        expect(client.transcript.length).toBe(beforeRestart);
    });

    it('v2: a failed restart does not wedge the session notification queue', async () => {
        const client = await connectSession(2);
        closeClient = () => client.connection.close();
        vi.spyOn(client.agent as any, "restartCodexClient").mockRejectedValueOnce(new Error("boom"));

        await expect(client.request(acpV2.methods.agent.providers.set, setProviderParams())).rejects.toThrow();

        // The restart never replaced the client; a normal prompt on the original one must still
        // complete, proving its per-session notification queue is not wedged.
        await runPromptToCompletion(client);

        expect(stateUpdates(client.transcript)).toEqual([
            {state: "running"},
            {state: "idle", stopReason: "end_turn"},
        ]);
    });
});

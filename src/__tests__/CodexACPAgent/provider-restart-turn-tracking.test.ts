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
    commandExecutionItem,
    itemStarted,
    itemCompleted,
    turnStarted,
    turnCompleted,
    agentMessageDelta,
    settle,
    stateUpdates,
    indexOf,
    isState,
    type PromptSession,
    type TranscriptEntry,
} from './v2-prompt-harness';
import {expectConformingV2SessionUpdates} from './v2-session-update-guard';

function toolCallUpdates(transcript: TranscriptEntry[]) {
    return transcript.flatMap(entry => "sessionUpdate" in entry ? [entry.sessionUpdate] : [])
        .filter(update => update.sessionUpdate === "tool_call_update");
}

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

/**
 * D2: the cut-off turn's still-open tool calls never get `item/completed` -- the old app-server
 * process's EOF drops it -- so without this fix they stay `in_progress` forever. The restart
 * close-out must fail them (and end any open terminal) before the turn's own idle/cancelled
 * state, on both v1 and v2, and must not touch a tool call that already completed.
 */
describe('provider restart fails outstanding tool calls left open by the cut-off turn (D2)', () => {
    let closeClient: (() => void) | null = null;

    afterEach(() => {
        closeClient?.();
        closeClient = null;
        expectConformingV2SessionUpdates();
    });

    it('v2: fails an in-progress command tool call and ends its terminal, before idle/cancelled', async () => {
        const client = await connectSession(2);
        closeClient = () => client.connection.close();

        client.emit(turnStarted());
        client.emit(itemStarted(commandExecutionItem("exec-1")));
        await settle();

        const replacement = createReplacementCodexAcpClient();
        vi.spyOn(client.agent as any, "restartCodexClient").mockResolvedValue(replacement.codexAcpClient);
        await client.request(acpV2.methods.agent.providers.set, setProviderParams());
        await settle();

        expect(stateUpdates(client.transcript)).toEqual([
            {state: "running"},
            {state: "idle", stopReason: "cancelled"},
        ]);

        const failedIndex = indexOf(client.transcript, entry =>
            "sessionUpdate" in entry
            && entry.sessionUpdate.sessionUpdate === "tool_call_update"
            && (entry.sessionUpdate as {toolCallId: string, status?: string}).toolCallId === "exec-1"
            && (entry.sessionUpdate as {status?: string}).status === "failed");
        const idleIndex = indexOf(client.transcript, isState("idle"));
        expect(failedIndex).toBeGreaterThan(-1);
        expect(failedIndex).toBeLessThan(idleIndex);

        // v2 renders both the item's creation and its later close-out under the same
        // `tool_call_update` tag; only the second one is this fix's synthetic failure.
        expect(toolCallUpdates(client.transcript)).toEqual([
            expect.objectContaining({toolCallId: "exec-1", status: "in_progress"}),
            {sessionUpdate: "tool_call_update", toolCallId: "exec-1", status: "failed"},
        ]);
        const terminalUpdate = client.transcript.find(entry =>
            "sessionUpdate" in entry
            && entry.sessionUpdate.sessionUpdate === "terminal_update"
            && "exitStatus" in entry.sessionUpdate);
        expect(terminalUpdate).toEqual({
            sessionUpdate: {
                sessionUpdate: "terminal_update",
                terminalId: "exec-1",
                exitStatus: {exitCode: null, signal: null},
            },
        });
    });

    it('v1: fails an in-progress command tool call and ends its terminal, with nothing else v1-visible changing', async () => {
        const client = await connectSession(1);
        closeClient = () => client.connection.close();

        client.emit(turnStarted());
        client.emit(itemStarted(commandExecutionItem("exec-1")));
        await settle();
        const beforeRestart = client.transcript.length;

        const replacement = createReplacementCodexAcpClient();
        vi.spyOn(client.agent as any, "restartCodexClient").mockResolvedValue(replacement.codexAcpClient);
        await client.request(acp.methods.agent.providers.set, setProviderParams());
        await settle();

        const newUpdates = client.transcript.slice(beforeRestart)
            .flatMap(entry => "sessionUpdate" in entry ? [entry.sessionUpdate] : []);
        expect(newUpdates).toEqual([
            expect.objectContaining({
                sessionUpdate: "tool_call_update",
                toolCallId: "exec-1",
                status: "failed",
                _meta: expect.objectContaining({
                    terminal_exit: {exit_code: null, signal: null, terminal_id: "exec-1"},
                }),
            }),
        ]);
    });

    it('v2: does not re-fail a tool call that already completed before the restart', async () => {
        const client = await connectSession(2);
        closeClient = () => client.connection.close();

        client.emit(turnStarted());
        client.emit(itemStarted(commandExecutionItem("exec-done")));
        client.emit(itemCompleted(commandExecutionItem("exec-done", "completed")));
        await settle();
        // v2 renders both the item's creation and its completion under the same
        // `tool_call_update` tag.
        expect(toolCallUpdates(client.transcript)).toEqual([
            expect.objectContaining({toolCallId: "exec-done", status: "in_progress"}),
            expect.objectContaining({toolCallId: "exec-done", status: "completed"}),
        ]);
        const beforeRestart = client.transcript.length;

        const replacement = createReplacementCodexAcpClient();
        vi.spyOn(client.agent as any, "restartCodexClient").mockResolvedValue(replacement.codexAcpClient);
        await client.request(acpV2.methods.agent.providers.set, setProviderParams());
        await settle();

        const newToolCallUpdates = toolCallUpdates(client.transcript.slice(beforeRestart));
        expect(newToolCallUpdates).toEqual([]);
        expect(stateUpdates(client.transcript)).toEqual([
            {state: "running"},
            {state: "idle", stopReason: "cancelled"},
        ]);
    });

    it('v2: does not re-fail an item that missed its item/completed but whose own turn already ended', async () => {
        const client = await connectSession(2);
        closeClient = () => client.connection.close();

        // exec-1 starts and never gets an item/completed, but its own turn (turn-a) ends anyway.
        client.emit(turnStarted("turn-a"));
        client.emit(itemStarted(commandExecutionItem("exec-1"), "turn-a"));
        client.emit(turnCompleted("turn-a"));
        await settle();

        // A later turn (turn-b) is running when the restart happens; exec-1 belongs to the
        // already-finished turn-a and must not be failed as if it were cut off by this restart.
        client.emit(turnStarted("turn-b"));
        await settle();

        const replacement = createReplacementCodexAcpClient();
        vi.spyOn(client.agent as any, "restartCodexClient").mockResolvedValue(replacement.codexAcpClient);
        await client.request(acpV2.methods.agent.providers.set, setProviderParams());
        await settle();

        expect(toolCallUpdates(client.transcript).some(update =>
            (update as {toolCallId: string, status?: string}).toolCallId === "exec-1"
            && (update as {status?: string}).status === "failed",
        )).toBe(false);
    });
});

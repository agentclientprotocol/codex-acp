import {afterEach, describe, expect, it} from 'vitest';
import {
    sessionId,
    cwd,
    connectSession,
    turnStarted,
    turnCompleted,
    agentMessageDelta,
    settle,
    type PromptSession,
} from './v2-prompt-harness';

function agentMessageChunks(transcript: PromptSession['transcript']) {
    return transcript.flatMap(entry => "sessionUpdate" in entry ? [entry.sessionUpdate] : [])
        .filter(update => update.sessionUpdate === "agent_message_chunk");
}

/**
 * G-render: on ACP v1, the baseline Codex-turn tracker (installed for every session, before any
 * `session/prompt` has run) now renders items for a Codex-initiated turn, reusing the same
 * `CodexEventHandler` rendering `session/prompt` uses. Previously it only tracked turn state and
 * rendered nothing, so a Codex-started turn (e.g. a `/goal` auto-continuation right after
 * `session/new`/`session/resume`) was invisible on v1.
 */
describe('agent-initiated Codex turns over ACP v1', () => {
    let closeClient: (() => void) | null = null;

    afterEach(() => {
        closeClient?.();
        closeClient = null;
    });

    it('renders items for a Codex turn that starts right after session/new, before any prompt has run', async () => {
        const client = await connectSession(1);
        closeClient = () => client.connection.close();
        const start = client.transcript.length;

        client.emit(turnStarted());
        await settle();
        client.emit(agentMessageDelta("Working on the goal"));
        await settle();
        client.emit(turnCompleted());
        await settle();

        const transcript = client.transcript.slice(start);
        expect(agentMessageChunks(transcript)).toEqual([
            expect.objectContaining({sessionUpdate: "agent_message_chunk"}),
        ]);
    });

    it('renders items for a Codex turn that starts right after session/resume, before any prompt has run', async () => {
        const client = await connectSession(1);
        closeClient = () => client.connection.close();
        await client.request("session/resume", {sessionId, cwd, mcpServers: []});
        const start = client.transcript.length;

        client.emit(turnStarted());
        await settle();
        client.emit(agentMessageDelta("Working on the goal"));
        await settle();
        client.emit(turnCompleted());
        await settle();

        const transcript = client.transcript.slice(start);
        expect(agentMessageChunks(transcript)).toEqual([
            expect.objectContaining({sessionUpdate: "agent_message_chunk"}),
        ]);
    });
});

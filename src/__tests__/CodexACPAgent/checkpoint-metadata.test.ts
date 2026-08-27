import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createCodexMockTestFixture, createTestSessionState, type CodexMockTestFixture } from '../acp-test-utils';
import type { Turn } from '../../app-server/v2';

/**
 * The App Server turn a prompt response names.
 *
 * A client that keeps this can say exactly where a conversation had reached,
 * rather than "wherever that session is now". Everything here compares the
 * identity the App Server emitted with the identity the response returned,
 * byte for byte — the point is that they are the same string, not that one is
 * present.
 */

function turn(id: string, status: string): Turn {
    return {
        id,
        items: [],
        itemsView: 'notLoaded',
        status,
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
    } as unknown as Turn;
}

/**
 * Drive one prompt whose App Server turn completes with `emitted` as its id.
 *
 * `statuses` lets a case end the turn as something other than a completion, so
 * an interrupted turn can be asked the same question.
 */
function promptWith(
    fixture: CodexMockTestFixture,
    sessionId: string,
    emitted: string,
    status = 'completed',
) {
    const codexAcpAgent = fixture.getCodexAcpAgent();
    const client = fixture.getCodexAppServerClient();

    client.turnStart = vi.fn().mockResolvedValue({ turn: turn(emitted, 'inProgress') });
    client.awaitTurnCompleted = vi.fn().mockResolvedValue({
        threadId: sessionId,
        turn: turn(emitted, status),
    });
    vi.spyOn(codexAcpAgent, 'getSessionState').mockReturnValue(createTestSessionState({ sessionId }));

    return codexAcpAgent.prompt({
        sessionId,
        prompt: [{ type: 'text', text: 'test prompt' }],
    });
}

describe('Prompt checkpoint metadata', () => {
    let mockFixture: CodexMockTestFixture;
    const sessionId = 'test-session-id';

    beforeEach(() => {
        mockFixture = createCodexMockTestFixture();
        vi.clearAllMocks();
    });

    it('returns the exact turn id the App Server emitted', async () => {
        const emitted = 'turn-01J9ZQ8N4K5X7YB2M3P6R8T0V1';

        const response = await promptWith(mockFixture, sessionId, emitted);

        expect(response.stopReason).toBe('end_turn');
        // The same string, not a derived or shortened one: a client compares it
        // against what it kept, and any normalisation here would break that.
        expect(response._meta?.['codex']).toEqual({ turnId: emitted });
    });

    it('keeps the quota metadata it already reported', async () => {
        const response = await promptWith(mockFixture, sessionId, 'turn-quota');

        // The checkpoint is added beside what a client already reads, never in
        // place of it.
        expect(response._meta).toHaveProperty('quota');
        expect(response._meta?.['codex']).toEqual({ turnId: 'turn-quota' });
    });

    it('names no turn when the turn was interrupted', async () => {
        const response = await promptWith(mockFixture, sessionId, 'turn-interrupted', 'interrupted');

        expect(response.stopReason).toBe('cancelled');
        // A cancelled prompt reached no point anything could resume from,
        // whatever turn happened to be in flight when it was cancelled.
        expect(response._meta?.['codex']).toBeUndefined();
    });

    it('names no turn when the prompt failed', async () => {
        const codexAcpAgent = mockFixture.getCodexAcpAgent();
        const client = mockFixture.getCodexAppServerClient();
        client.turnStart = vi.fn().mockResolvedValue({ turn: turn('turn-failed', 'inProgress') });
        client.awaitTurnCompleted = vi.fn().mockRejectedValue(new Error('the provider failed'));
        vi.spyOn(codexAcpAgent, 'getSessionState').mockReturnValue(
            createTestSessionState({ sessionId }),
        );

        await expect(
            codexAcpAgent.prompt({ sessionId, prompt: [{ type: 'text', text: 'test prompt' }] }),
        ).rejects.toThrow();
    });

    it('gives interleaved sessions their own turn ids', async () => {
        // Two prompts in flight at once on two sessions. A response built from
        // session-global state — the adapter's own `currentTurnId`, say — would
        // hand at least one of them the other's turn, and the whole point of a
        // checkpoint is that it names this exact turn.
        const first = createCodexMockTestFixture();
        const second = createCodexMockTestFixture();

        const [alpha, beta] = await Promise.all([
            promptWith(first, 'session-alpha', 'turn-alpha'),
            promptWith(second, 'session-beta', 'turn-beta'),
        ]);

        expect(alpha._meta?.['codex']).toEqual({ turnId: 'turn-alpha' });
        expect(beta._meta?.['codex']).toEqual({ turnId: 'turn-beta' });
    });
});

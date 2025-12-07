import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CodexACPAgent } from '../../CodexACPAgent';
import { createMockConnections, testEventHandling, type MockConnections } from './test-utils';

describe('CodexACPAgent - reasoning events', () => {
    let agent: CodexACPAgent;
    let mocks: MockConnections;
    const sessionId = 'test-session-id';

    beforeEach(async () => {
        mocks = createMockConnections();

        agent = new CodexACPAgent(mocks.mockAcpConnection, mocks.mockCodexConnection);

        mocks.mockCodexConnection.sendRequest
            .mockResolvedValueOnce(undefined)
            .mockResolvedValueOnce({ conversationId: sessionId });
        await agent.newSession({
            cwd: "",
            mcpServers: []
        });

        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    describe('agent_reasoning event (non-streaming)', () => {
        it('should send agent_thought_chunk with text content', async () => {
            await testEventHandling(agent, sessionId, mocks, {
                type: 'agent_reasoning',
                text: 'Analyzing the problem and considering different approaches...',
            });

            expect(mocks.mockAcpConnection.sessionUpdate).toHaveBeenCalledWith({
                sessionId,
                update: {
                    sessionUpdate: 'agent_thought_chunk',
                    content: {
                        type: 'text',
                        text: 'Analyzing the problem and considering different approaches...',
                    },
                },
            });
        });

        it('should handle empty reasoning text', async () => {
            await testEventHandling(agent, sessionId, mocks, {
                type: 'agent_reasoning',
                text: '',
            });

            expect(mocks.mockAcpConnection.sessionUpdate).toHaveBeenCalledWith({
                sessionId,
                update: {
                    sessionUpdate: 'agent_thought_chunk',
                    content: {
                        type: 'text',
                        text: '',
                    },
                },
            });
        });

        it('should handle multi-line reasoning text', async () => {
            const multiLineText = `Step 1: Understanding the request
Step 2: Analyzing available options
Step 3: Making a decision`;

            await testEventHandling(agent, sessionId, mocks, {
                type: 'agent_reasoning',
                text: multiLineText,
            });

            expect(mocks.mockAcpConnection.sessionUpdate).toHaveBeenCalledWith({
                sessionId,
                update: {
                    sessionUpdate: 'agent_thought_chunk',
                    content: {
                        type: 'text',
                        text: multiLineText,
                    },
                },
            });
        });

        it('should handle special characters in reasoning text', async () => {
            const specialText = 'Using `CodexACPAgent` with @annotations & symbols: {key: "value"}';

            await testEventHandling(agent, sessionId, mocks, {
                type: 'agent_reasoning',
                text: specialText,
            });

            expect(mocks.mockAcpConnection.sessionUpdate).toHaveBeenCalledWith({
                sessionId,
                update: {
                    sessionUpdate: 'agent_thought_chunk',
                    content: {
                        type: 'text',
                        text: specialText,
                    },
                },
            });
        });
    });

    describe('reasoning_content_delta event (streaming)', () => {
        it('should send agent_thought_chunk with delta text', async () => {
            await testEventHandling(agent, sessionId, mocks, {
                type: 'reasoning_content_delta',
                delta: 'First chunk of reasoning...',
            });

            expect(mocks.mockAcpConnection.sessionUpdate).toHaveBeenCalledWith({
                sessionId,
                update: {
                    sessionUpdate: 'agent_thought_chunk',
                    content: {
                        type: 'text',
                        text: 'First chunk of reasoning...',
                    },
                },
            });
        });

        it('should handle multiple delta chunks', async () => {
            await testEventHandling(agent, sessionId, mocks, [
                { type: 'reasoning_content_delta', delta: 'First ' },
                { type: 'reasoning_content_delta', delta: 'second ' },
                { type: 'reasoning_content_delta', delta: 'third.' },
            ]);

            const thoughtChunkCalls = mocks.mockAcpConnection.sessionUpdate.mock.calls.filter(
                (call: any) => call[0].update.sessionUpdate === 'agent_thought_chunk'
            );

            expect(thoughtChunkCalls).toHaveLength(3);
            expect(thoughtChunkCalls[0][0].update.content.text).toBe('First ');
            expect(thoughtChunkCalls[1][0].update.content.text).toBe('second ');
            expect(thoughtChunkCalls[2][0].update.content.text).toBe('third.');
        });

        it('should suppress agent_reasoning when deltas were sent', async () => {
            await testEventHandling(agent, sessionId, mocks, [
                { type: 'reasoning_content_delta', delta: 'Streamed content' },
                { type: 'agent_reasoning', text: 'Should be suppressed' },
            ]);

            const thoughtChunkCalls = mocks.mockAcpConnection.sessionUpdate.mock.calls.filter(
                (call: any) => call[0].update.sessionUpdate === 'agent_thought_chunk'
            );

            // Should only have the delta, not the full reasoning
            expect(thoughtChunkCalls).toHaveLength(1);
            expect(thoughtChunkCalls[0][0].update.content.text).toBe('Streamed content');
        });
    });

    describe('reasoning_raw_content_delta event (streaming)', () => {
        it('should send agent_thought_chunk with delta text', async () => {
            await testEventHandling(agent, sessionId, mocks, {
                type: 'reasoning_raw_content_delta',
                delta: 'Raw content delta...',
            });

            expect(mocks.mockAcpConnection.sessionUpdate).toHaveBeenCalledWith({
                sessionId,
                update: {
                    sessionUpdate: 'agent_thought_chunk',
                    content: {
                        type: 'text',
                        text: 'Raw content delta...',
                    },
                },
            });
        });

        it('should suppress agent_reasoning after raw delta', async () => {
            await testEventHandling(agent, sessionId, mocks, [
                { type: 'reasoning_raw_content_delta', delta: 'Raw delta' },
                { type: 'agent_reasoning', text: 'Should be suppressed' },
            ]);

            const thoughtChunkCalls = mocks.mockAcpConnection.sessionUpdate.mock.calls.filter(
                (call: any) => call[0].update.sessionUpdate === 'agent_thought_chunk'
            );

            expect(thoughtChunkCalls).toHaveLength(1);
            expect(thoughtChunkCalls[0][0].update.content.text).toBe('Raw delta');
        });
    });

    describe('agent_reasoning_section_break event', () => {
        it('should send double newline for section break', async () => {
            await testEventHandling(agent, sessionId, mocks, {
                type: 'agent_reasoning_section_break',
            });

            expect(mocks.mockAcpConnection.sessionUpdate).toHaveBeenCalledWith({
                sessionId,
                update: {
                    sessionUpdate: 'agent_thought_chunk',
                    content: {
                        type: 'text',
                        text: '\n\n',
                    },
                },
            });
        });

        it('should work between delta chunks for formatting', async () => {
            await testEventHandling(agent, sessionId, mocks, [
                { type: 'reasoning_content_delta', delta: 'First section' },
                { type: 'agent_reasoning_section_break' },
                { type: 'reasoning_content_delta', delta: 'Second section' },
            ]);

            const thoughtChunkCalls = mocks.mockAcpConnection.sessionUpdate.mock.calls.filter(
                (call: any) => call[0].update.sessionUpdate === 'agent_thought_chunk'
            );

            expect(thoughtChunkCalls).toHaveLength(3);
            expect(thoughtChunkCalls[0][0].update.content.text).toBe('First section');
            expect(thoughtChunkCalls[1][0].update.content.text).toBe('\n\n');
            expect(thoughtChunkCalls[2][0].update.content.text).toBe('Second section');
        });

        it('should suppress agent_reasoning after section break', async () => {
            await testEventHandling(agent, sessionId, mocks, [
                { type: 'agent_reasoning_section_break' },
                { type: 'agent_reasoning', text: 'Should be suppressed' },
            ]);

            const thoughtChunkCalls = mocks.mockAcpConnection.sessionUpdate.mock.calls.filter(
                (call: any) => call[0].update.sessionUpdate === 'agent_thought_chunk'
            );

            expect(thoughtChunkCalls).toHaveLength(1);
            expect(thoughtChunkCalls[0][0].update.content.text).toBe('\n\n');
        });
    });

    describe('seenReasoningDeltas flag behavior', () => {
        it('should send agent_reasoning when no deltas were sent (non-streaming)', async () => {
            await testEventHandling(agent, sessionId, mocks, {
                type: 'agent_reasoning',
                text: 'Complete reasoning in non-streaming mode',
            });

            const thoughtChunkCalls = mocks.mockAcpConnection.sessionUpdate.mock.calls.filter(
                (call: any) => call[0].update.sessionUpdate === 'agent_thought_chunk'
            );

            expect(thoughtChunkCalls).toHaveLength(1);
            expect(thoughtChunkCalls[0][0].update.content.text).toBe('Complete reasoning in non-streaming mode');
        });

        it('should reset seenReasoningDeltas flag for next turn', async () => {
            // First turn with streaming
            await testEventHandling(agent, sessionId, mocks, [
                { type: 'reasoning_content_delta', delta: 'Turn 1 delta' },
                { type: 'agent_reasoning', text: 'Turn 1 should be suppressed' },
            ]);

            vi.clearAllMocks();

            // Second turn without streaming
            await testEventHandling(agent, sessionId, mocks, {
                type: 'agent_reasoning',
                text: 'Turn 2 should be sent',
            });

            const thoughtChunkCalls = mocks.mockAcpConnection.sessionUpdate.mock.calls.filter(
                (call: any) => call[0].update.sessionUpdate === 'agent_thought_chunk'
            );

            // Should send the agent_reasoning from turn 2 since flag was reset
            expect(thoughtChunkCalls).toHaveLength(1);
            expect(thoughtChunkCalls[0][0].update.content.text).toBe('Turn 2 should be sent');
        });
    });

    describe('mixed streaming scenarios', () => {
        it('should handle mix of content_delta and raw_content_delta', async () => {
            await testEventHandling(agent, sessionId, mocks, [
                { type: 'reasoning_content_delta', delta: 'Formatted ' },
                { type: 'reasoning_raw_content_delta', delta: 'raw ' },
                { type: 'reasoning_content_delta', delta: 'content' },
            ]);

            const thoughtChunkCalls = mocks.mockAcpConnection.sessionUpdate.mock.calls.filter(
                (call: any) => call[0].update.sessionUpdate === 'agent_thought_chunk'
            );

            expect(thoughtChunkCalls).toHaveLength(3);
            expect(thoughtChunkCalls[0][0].update.content.text).toBe('Formatted ');
            expect(thoughtChunkCalls[1][0].update.content.text).toBe('raw ');
            expect(thoughtChunkCalls[2][0].update.content.text).toBe('content');
        });

        it('should handle empty deltas', async () => {
            await testEventHandling(agent, sessionId, mocks, {
                type: 'reasoning_content_delta',
                delta: '',
            });

            expect(mocks.mockAcpConnection.sessionUpdate).toHaveBeenCalledWith({
                sessionId,
                update: {
                    sessionUpdate: 'agent_thought_chunk',
                    content: {
                        type: 'text',
                        text: '',
                    },
                },
            });
        });

        it('should handle complex streaming with section breaks', async () => {
            await testEventHandling(agent, sessionId, mocks, [
                { type: 'reasoning_content_delta', delta: 'Section 1' },
                { type: 'agent_reasoning_section_break' },
                { type: 'reasoning_raw_content_delta', delta: 'Section 2 raw' },
                { type: 'agent_reasoning_section_break' },
                { type: 'reasoning_content_delta', delta: 'Section 3' },
                { type: 'agent_reasoning', text: 'Should be suppressed' },
            ]);

            const thoughtChunkCalls = mocks.mockAcpConnection.sessionUpdate.mock.calls.filter(
                (call: any) => call[0].update.sessionUpdate === 'agent_thought_chunk'
            );

            expect(thoughtChunkCalls).toHaveLength(5);
            expect(thoughtChunkCalls[0][0].update.content.text).toBe('Section 1');
            expect(thoughtChunkCalls[1][0].update.content.text).toBe('\n\n');
            expect(thoughtChunkCalls[2][0].update.content.text).toBe('Section 2 raw');
            expect(thoughtChunkCalls[3][0].update.content.text).toBe('\n\n');
            expect(thoughtChunkCalls[4][0].update.content.text).toBe('Section 3');
        });
    });
});

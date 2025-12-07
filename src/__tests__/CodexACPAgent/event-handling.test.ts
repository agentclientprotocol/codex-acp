import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CodexACPAgent } from '../../CodexACPAgent';
import { createMockConnections, testEventHandling, type MockConnections } from './test-utils';
import type { EventMsg } from '../../app-server';

describe('CodexACPAgent - event handling', () => {
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

    describe('agent_reasoning event', () => {
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
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CodexACPAgent } from '../../CodexACPAgent';
import * as acp from '@agentclientprotocol/sdk';
import { createMockConnections } from './test-utils';

describe('CodexACPAgent - initialize', () => {
    let agent: CodexACPAgent;
    let mockAcpConnection: any;
    let mockCodexConnection: any;

    beforeEach(() => {
        const mocks = createMockConnections();
        mockAcpConnection = mocks.mockAcpConnection;
        mockCodexConnection = mocks.mockCodexConnection;

        agent = new CodexACPAgent(mockAcpConnection, mockCodexConnection);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('should return protocol version and agent capabilities', async () => {
        const params: acp.InitializeRequest = {
            protocolVersion: acp.PROTOCOL_VERSION
        };
        const result = await agent.initialize(params);

        expect(result).toEqual({
            protocolVersion: acp.PROTOCOL_VERSION,
            agentCapabilities: {
                loadSession: false,
            },
        });
    });
});

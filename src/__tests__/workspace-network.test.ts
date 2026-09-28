import {describe, expect, it, vi} from 'vitest';
import {CodexAcpClient} from '../CodexAcpClient';
import {AgentMode} from '../AgentMode';
import {ModelId} from '../ModelId';
import {createCodexMockTestFixture} from './acp-test-utils';

const completedTurn = {
    threadId: 'session',
    turn: {
        id: 'turn', items: [], status: 'completed' as const, error: null,
        itemsView: 'notLoaded' as const, startedAt: null, completedAt: null, durationMs: null,
    },
};

describe('workspace network configuration', () => {
    it.each([
        {value: true, expected: true},
        {value: false, expected: false},
        {value: undefined, expected: false},
        {value: 'true', expected: false},
    ])('sends networkAccess=$expected for network_access=$value without widening writes', async ({value, expected}) => {
        const fixture = createCodexMockTestFixture();
        const server = fixture.getCodexAppServerClient();
        const runTurn = vi.spyOn(server, 'runTurn').mockResolvedValue(completedTurn);
        const client = new CodexAcpClient(server, value === undefined ? {} : {
            sandbox_workspace_write: {network_access: value},
        });
        await client.sendPrompt(
            {sessionId: 'session', prompt: [{type: 'text', text: 'Hello'}]},
            AgentMode.Agent, ModelId.create('test-model', 'medium'), null, false, '', ['/workspace/extra'],
        );
        expect(runTurn.mock.calls[0]![0]).toMatchObject({
            approvalPolicy: AgentMode.Agent.approvalPolicy,
            approvalsReviewer: AgentMode.Agent.approvalsReviewer,
            sandboxPolicy: {...AgentMode.Agent.sandboxPolicy, writableRoots: ['/workspace/extra'], networkAccess: expected},
        });
        expect(AgentMode.Agent.sandboxPolicy).toHaveProperty('networkAccess', false);
    });

    it('does not replace other sandbox policy types', async () => {
        const fixture = createCodexMockTestFixture();
        const server = fixture.getCodexAppServerClient();
        const runTurn = vi.spyOn(server, 'runTurn').mockResolvedValue(completedTurn);
        const client = new CodexAcpClient(server, {sandbox_workspace_write: {network_access: false}});
        await client.sendPrompt(
            {sessionId: 'session', prompt: [{type: 'text', text: 'Hello'}]},
            AgentMode.AgentFullAccess, ModelId.create('test-model', 'medium'), null, false, '', [],
        );
        expect(runTurn.mock.calls[0]![0].sandboxPolicy).toEqual(AgentMode.AgentFullAccess.sandboxPolicy);
    });
});

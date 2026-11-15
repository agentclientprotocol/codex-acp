// Real app-server verification of the experimental thread/start field.
import * as acp from "@agentclientprotocol/sdk/unstable";
import {expect, it} from "vitest";
import {legacySetSessionModel} from "../../AcpExtensions";
import type {SpawnedAgentFixture} from "../CodexACPAgent/e2e/spawned-agent-fixture";
import {
    agentText,
    connectAndLogin,
    describeIntegration,
    expectNoUnscriptedModelRequests,
    INTEGRATION_MODEL_ID,
    sendPrompt,
    spawnAgent,
    stopAll,
} from "./integration-fixture";
import {startMockResponsesServer, textResponse} from "./mock-responses-server";

describeIntegration("integration: session environments", () => {
    it("creates and prompts a thread with environment access disabled", async () => {
        const mock = await startMockResponsesServer();
        let agent: SpawnedAgentFixture | undefined;
        try {
            agent = await spawnAgent();
            await connectAndLogin(agent, mock.baseUrl);
            const {sessionId} = await agent.connection.request(acp.methods.agent.session.new, {
                cwd: agent.workspaceDir,
                mcpServers: [],
                _meta: {environments: []},
            });
            await legacySetSessionModel(agent.connection, {sessionId, modelId: INTEGRATION_MODEL_ID.toString()});
            mock.enqueue(textResponse("environment-ok"));

            const response = await sendPrompt(agent, sessionId, "say environment-ok");

            expect(response.stopReason).toBe("end_turn");
            expect(agentText(agent, sessionId)).toBe("environment-ok");
            expectNoUnscriptedModelRequests(mock);
        } finally {
            await stopAll(agent, mock);
        }
    });
});

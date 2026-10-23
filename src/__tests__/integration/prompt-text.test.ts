// Real codex-acp + real `codex app-server`; only the model is a local mock.
import {afterEach, beforeEach, expect, it} from "vitest";
import type {SpawnedAgentFixture} from "../CodexACPAgent/e2e/spawned-agent-fixture";
import {
    agentText,
    connectAndLogin,
    describeIntegration,
    expectNoUnscriptedModelRequests,
    INTEGRATION_MODEL_ID,
    openSession,
    sendPrompt,
    spawnAgent,
    stopAll,
} from "./integration-fixture";
import {type MockResponsesServer, startMockResponsesServer, textResponse} from "./mock-responses-server";

describeIntegration("integration: text reply", () => {
    let mock: MockResponsesServer;
    let agent: SpawnedAgentFixture;
    let sessionId: string;

    beforeEach(async () => {
        // Start the mock model: a local HTTP server in place of the OpenAI API.
        mock = await startMockResponsesServer();
        // Spawn the agent: the codex-acp process, which starts `codex app-server` itself.
        agent = await spawnAgent();
        // Connect over ACP and log in through `gateway` with the mock's address.
        await connectAndLogin(agent, mock.baseUrl);
        // Open a session in a temp workspace.
        sessionId = await openSession(agent);
    });

    // Stop the agent and the mock, remove the temp dirs.
    afterEach(async () => {
        await stopAll(agent, mock);
    });

    /** The model's request carries the prompt and is sent to the integration model. */
    function expectPromptSentToModel(text: string): void {
        expect(mock.requests).toHaveLength(1);
        const request = mock.requests[0] as {model: string};
        expect(request.model).toBe(INTEGRATION_MODEL_ID.model);
        expect(JSON.stringify(request)).toContain(text);
    }

    /**
     * Scenario:
     * 1. The user sends the prompt "say integration-ok".
     * 2. The model streams the reply "integration-ok" in 3 chunks.
     * Expected:
     * - the turn ends with `end_turn`;
     * - the client receives the whole text "integration-ok";
     * - Codex sent the prompt to the model in exactly one request, on the integration model.
     */
    it("streams a text reply and ends the turn", async () => {
        // Script the model: its only reply is text in 3 chunks.
        mock.enqueue(textResponse("integ", "ration", "-ok"));

        // Send the prompt and wait for the turn to end.
        const response = await sendPrompt(agent, sessionId, "say integration-ok");

        // Check what the client received and what Codex sent to the model.
        expect(response.stopReason).toBe("end_turn");
        expect(agentText(agent, sessionId)).toBe("integration-ok");
        expectPromptSentToModel("say integration-ok");
        expectNoUnscriptedModelRequests(mock);
    });
});

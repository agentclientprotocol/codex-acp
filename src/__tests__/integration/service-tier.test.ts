import {afterEach, expect, it} from "vitest";
import {createSpawnedAgentFixture, type SpawnedAgentFixture} from "../CodexACPAgent/e2e/spawned-agent-fixture";
import {connectAndLogin, describeIntegration, expectNoUnscriptedModelRequests, sendPrompt, stopAll} from "./integration-fixture";
import {findPromptRequest} from "./model-request";
import {type MockResponsesServer, startMockResponsesServer, textResponse} from "./mock-responses-server";

describeIntegration("integration: configured service tier", () => {
    let mock: MockResponsesServer | undefined;
    let agent: SpawnedAgentFixture | undefined;

    afterEach(async () => {
        await stopAll(agent, mock);
    });

    it("sends configured Ultrafast to the model on consecutive turns with Fast disabled", async () => {
        mock = await startMockResponsesServer();
        agent = await createSpawnedAgentFixture(async () => {}, {
            CODEX_CONFIG: JSON.stringify({
                model: "gpt-6-astra",
                service_tier: "ultrafast",
                features: {fast_mode: false},
            }),
        });
        await connectAndLogin(agent, mock.baseUrl);
        const {sessionId} = await agent.createSession();
        // The first prompt may also generate a session title.
        mock.enqueue(textResponse("ok"), textResponse("ok"), textResponse("ok"));

        for (const prompt of ["First Ultrafast prompt", "Second Ultrafast prompt"]) {
            const response = await sendPrompt(agent, sessionId, prompt);
            expect(response.stopReason).toBe("end_turn");
            expect(findPromptRequest(mock.requests, prompt)).toMatchObject({
                model: "gpt-6-astra",
                service_tier: "ultrafast",
            });
        }
        expectNoUnscriptedModelRequests(mock);
    });
});

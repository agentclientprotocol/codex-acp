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

    it.each(["new", "resume", "load"])("preserves a configured non-Fast tier on consecutive turns after session/%s", async (operation) => {
        mock = await startMockResponsesServer();
        agent = await createSpawnedAgentFixture(async () => {}, {
            CODEX_CONFIG: JSON.stringify({
                model: "gpt-6-astra",
                // Flex is supported without an account-specific model catalog; Ultrafast is not.
                service_tier: "flex",
                features: {fast_mode: false},
            }),
        });
        await connectAndLogin(agent, mock.baseUrl);
        const {sessionId} = await agent.createSession();
        if (operation !== "new") {
            // Reopen before the first prompt, while Codex has no persisted rollout.
            await agent.connection.request(`session/${operation}`, {
                sessionId,
                cwd: agent.workspaceDir,
                mcpServers: [],
            });
        }
        // The first prompt may also generate a session title.
        mock.enqueue(textResponse("ok"), textResponse("ok"), textResponse("ok"));

        for (const prompt of ["First Flex prompt", "Second Flex prompt"]) {
            const response = await sendPrompt(agent, sessionId, prompt);
            expect(response.stopReason).toBe("end_turn");
            expect(findPromptRequest(mock.requests, prompt)).toMatchObject({
                model: "gpt-6-astra",
                service_tier: "flex",
            });
        }
        expectNoUnscriptedModelRequests(mock);
    });
});

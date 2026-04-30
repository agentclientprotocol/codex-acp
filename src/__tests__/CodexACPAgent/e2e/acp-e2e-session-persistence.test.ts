import {afterEach, expect, it} from "vitest";
import {
    createAuthenticatedFixture,
    describeE2E,
    OTHER_TEST_MODEL_ID,
    type SpawnedAgentFixture,
} from "./acp-e2e-test-utils";

describeE2E("E2E session persistence tests", () => {
    let beforeRestartFixture: SpawnedAgentFixture | null = null;
    let afterRestartFixture: SpawnedAgentFixture | null = null;

    afterEach(async () => {
        await afterRestartFixture?.dispose();
        await beforeRestartFixture?.dispose();
        afterRestartFixture = null;
        beforeRestartFixture = null;
    });

    it("persists a session across ACP process restart", async () => {
        beforeRestartFixture = await createAuthenticatedFixture();
        const sessionId = (await beforeRestartFixture.createSession()).sessionId;

        await beforeRestartFixture.connection.unstable_setSessionModel({sessionId, modelId: OTHER_TEST_MODEL_ID.toString()});
        const memorizedToken = "token-for-tests-123";
        await beforeRestartFixture.expectPromptText(
            sessionId,
            `Remember this token - "${memorizedToken}". Reply with exactly before-restart-ok and nothing else.`,
            (text) => expect(text.toLowerCase()).toContain("before-restart-ok"),
        );

        afterRestartFixture = await beforeRestartFixture.restart();

        const loadSessionResponse = await afterRestartFixture.connection.loadSession({
            sessionId,
            cwd: afterRestartFixture.workspaceDir,
            mcpServers: [],
        });
        expect(loadSessionResponse.models?.currentModelId).toBe(OTHER_TEST_MODEL_ID.toString());

        await afterRestartFixture.expectPromptText(
            sessionId,
            "What token did I ask you to remember earlier? Reply with just the token and nothing else.",
            (text) => expect(text.toLowerCase()).toContain(memorizedToken),
        );
    });
});

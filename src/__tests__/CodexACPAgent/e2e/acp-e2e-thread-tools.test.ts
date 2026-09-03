import {afterEach, beforeEach, expect, it} from "vitest";
import {AgentMode} from "../../../AgentMode";
import {
    createAuthenticatedFixture,
    describeE2E,
    type SpawnedAgentFixture,
} from "./acp-e2e-test-utils";

describeE2E("E2E thread tools tests", () => {
    let fixture: SpawnedAgentFixture;

    beforeEach(async () => {
        fixture = await createAuthenticatedFixture(AgentMode.ReadOnly);
    });

    afterEach(async () => {
        await fixture.dispose();
    });

    it("lists another task through the adapter MCP server", async () => {
        const target = await fixture.createSession();
        const source = await fixture.createSession();

        await fixture.expectPromptText(
            source.sessionId,
            `Use the list_threads tool. Find task ${target.sessionId}. Reply with that task ID only.`,
            text => expect(text).toContain(target.sessionId),
        );
    });
});

import {describe, expect, it} from "vitest";
import {AgentMode} from "../../AgentMode";
import {setupPromptTestSession} from "../acp-test-utils";

describe("Plan mode", () => {
    it("passes Codex plan collaboration mode on turn/start", async () => {
        const {mockFixture, turnStartSpy} = setupPromptTestSession({
            agentMode: AgentMode.Plan,
            currentModelId: "model-id[medium]",
        });

        await mockFixture.getCodexAcpAgent().prompt({
            sessionId: "session-id",
            prompt: [{type: "text", text: "Plan this change"}],
        });

        expect(turnStartSpy).toHaveBeenCalledWith(expect.objectContaining({
            collaborationMode: {
                mode: "plan",
                settings: {
                    model: "model-id",
                    reasoning_effort: "medium",
                    developer_instructions: null,
                },
            },
        }));
    });
});

// The model edits a file with apply_patch; the test user allows the edit.
// Read-only mode makes Codex ask for permission before writing.
import fs from "node:fs";
import path from "node:path";
import {afterEach, beforeEach, expect, it} from "vitest";
import {ApprovalOptionId} from "../../permissions/option-ids";
import type {SpawnedAgentFixture} from "../CodexACPAgent/e2e/spawned-agent-fixture";
import {
    answerPermissions,
    connectAndLogin,
    describeIntegration,
    expectNoUnscriptedModelRequests,
    modelRequestInput,
    openSession,
    sendPrompt,
    spawnAgent,
    stopAll,
    toolCallUpdates,
} from "./integration-fixture";
import {applyPatchResponse, type MockResponsesServer, startMockResponsesServer, textResponse} from "./mock-responses-server";

const CALL_ID = "call_patch";
const ADD_HELLO_PATCH = "*** Begin Patch\n*** Add File: hello.txt\n+edit-ok\n*** End Patch\n";

describeIntegration("integration: file edit approval", () => {
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

    function readWorkspaceFile(name: string): string {
        return fs.readFileSync(path.join(agent.workspaceDir, name), "utf8");
    }

    /** One edit permission request, pointing at `fileName`. Returns its tool call id. */
    function expectOneEditPermissionFor(fileName: string): string | undefined {
        const requests = agent.readPermissionRequests(sessionId, "edit");
        expect(requests).toHaveLength(1);
        const toolCall = requests[0]?.toolCall;
        expect(toolCall?.locations?.some((l) => l.path.endsWith(fileName))).toBe(true);
        return toolCall?.toolCallId;
    }

    /** The client was shown a diff of `fileName` on that tool call (permission requests carry only paths). */
    function expectDiffShown(toolCallId: string | undefined, fileName: string): void {
        const diffs = toolCallUpdates(agent, sessionId)
            .filter((u) => u.toolCallId === toolCallId)
            .flatMap((u) => u.content ?? [])
            .filter((c) => c.type === "diff");
        expect(diffs.some((d) => d.path.endsWith(fileName))).toBe(true);
    }

    /** Codex sent the patch result back to the model in its 2nd request. */
    function expectPatchResultSentToModel(): void {
        expect(mock.requests).toHaveLength(2);
        expect(modelRequestInput(mock, 1).some((i) => i.type === "custom_tool_call_output" && i.call_id === CALL_ID)).toBe(true);
    }

    /**
     * Scenario:
     * 1. The user sends the prompt "patch file".
     * 2. The model sends a patch that adds hello.txt with the text "edit-ok".
     * 3. Codex asks the user for permission to edit; the user allows it once.
     * 4. Codex writes the file and sends the patch result to the model.
     * 5. The model replies "done".
     * Expected:
     * - the turn ends with `end_turn`;
     * - there was one edit permission request, for hello.txt;
     * - the client was shown the diff of hello.txt;
     * - hello.txt in the workspace contains "edit-ok";
     * - the model's 2nd request contains the patch result.
     */
    it("writes the file when the user allows the edit", async () => {
        // Script the model (send the patch, then "done") and the user (allow once).
        mock.enqueue(applyPatchResponse(CALL_ID, ADD_HELLO_PATCH), textResponse("done"));
        answerPermissions(agent, "edit", ApprovalOptionId.AllowOnce);

        // Send the prompt and wait for the turn to end.
        const response = await sendPrompt(agent, sessionId, "patch file");

        // Check the client, the disk, and what Codex sent to the model.
        expect(response.stopReason).toBe("end_turn");
        const toolCallId = expectOneEditPermissionFor("hello.txt");
        expectDiffShown(toolCallId, "hello.txt");
        expect(readWorkspaceFile("hello.txt")).toBe("edit-ok\n");
        expectPatchResultSentToModel();
        expectNoUnscriptedModelRequests(mock);
    });
});

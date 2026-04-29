import fs from "node:fs";
import path from "node:path";
import {afterEach, beforeEach, expect, it} from "vitest";
import {ApprovalOptionId} from "../../../ApprovalOptionId";
import {
    createPermissionResponder,
    createReadOnlyFixture,
    describeE2E,
    type SpawnedAgentFixture,
} from "./acp-e2e-test-utils";

const FILE_NAME = "approval-file.txt";
const FILE_CONTENT = "file approval e2e";

describeE2E("E2E file approval tests", () => {
    let fixture: SpawnedAgentFixture;
    let sessionId: string;

    beforeEach(async () => {
        fixture = await createReadOnlyFixture();
        sessionId = (await fixture.createSession()).sessionId;
    });

    afterEach(async () => {
        await fixture.dispose();
    });

    async function expectFileApproval(
        optionId: ApprovalOptionId,
        expectedStopReason: "end_turn" | "cancelled",
    ): Promise<void> {
        fixture.setPermissionResponder(createPermissionResponder("edit", optionId));
        const response = await fixture.connection.prompt({
            sessionId,
            prompt: [{
                type: "text",
                text: `Create ${FILE_NAME} by editing files directly. Content must be exactly: ${FILE_CONTENT}. Do not use shell commands, and stop if the edit is rejected.`,
            }],
        });
        expect(response.stopReason).toBe(expectedStopReason);
        expect(fixture.readPermissionRequests(sessionId, "edit").length).toBe(1);
        expect(fixture.readPermissionRequests(sessionId, "execute").length).toBe(0);
    }

    it("applies approved file edits", async () => {
        await expectFileApproval(ApprovalOptionId.AllowOnce, "end_turn");
        const filePath = path.join(fixture.workspaceDir, FILE_NAME);
        expect(fs.existsSync(filePath)).toBe(true);
        expect(fs.readFileSync(filePath, "utf8").trim()).toBe(FILE_CONTENT);
    });

    it("does not apply rejected file edits", async () => {
        await expectFileApproval(ApprovalOptionId.RejectOnce, "cancelled");
        expect(fs.existsSync(path.join(fixture.workspaceDir, FILE_NAME))).toBe(false);
    });
});

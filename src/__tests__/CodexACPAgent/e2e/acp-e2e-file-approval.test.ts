import fs from "node:fs";
import path from "node:path";
import {afterEach, beforeEach, expect, it, onTestFinished} from "vitest";
import {AgentMode} from "../../../AgentMode";
import {ApprovalOptionId} from "../../../ApprovalOptionId";
import {
    createAuthenticatedFixture,
    createPermissionResponder,
    describeE2E,
    expectNoPermissionRequests,
    expectPermissionRequests,
    generateFileNameForTest,
    type SpawnedAgentFixture,
} from "./acp-e2e-test-utils";

const FILE_CONTENT = "file approval e2e";

describeE2E("E2E file approval tests", () => {
    let fixture: SpawnedAgentFixture;

    beforeEach(async () => {
        fixture = await createAuthenticatedFixture(AgentMode.ReadOnly);
    });

    afterEach(async () => {
        await fixture.dispose();
    });

    it("applies approved file edits", async () => {
        fixture.setPermissionResponder(createPermissionResponder("edit", ApprovalOptionId.AllowOnce));
        const sessionId = await editFileDirectly(fixture, path.join(fixture.workspaceDir, generateFileNameForTest()), true);
        expectPermissionRequests(fixture, sessionId, {edit: 1, execute: 0});
    });

    it("does not apply rejected file edits", async () => {
        fixture.setPermissionResponder(createPermissionResponder("edit", ApprovalOptionId.RejectOnce));
        const sessionId = await editFileDirectly(fixture, path.join(fixture.workspaceDir, generateFileNameForTest()), false);
        expectPermissionRequests(fixture, sessionId, {edit: 1, execute: 0});
    });
});

describeE2E("E2E Agent mode file permission tests", () => {
    let fixture: SpawnedAgentFixture;

    beforeEach(async () => {
        fixture = await createAuthenticatedFixture(AgentMode.Agent);
    });

    afterEach(async () => {
        await fixture.dispose();
    });

    it("edits a workspace file without prompting for permission", async () => {
        const sessionId = await editFileDirectly(fixture, path.join(fixture.workspaceDir, generateFileNameForTest()), true);
        expectNoPermissionRequests(fixture, sessionId);
    });

    it("can't edit file outside workspace", async () => {
        const dir = createDirOutsideWorkspace(fixture);
        await editFileDirectly(fixture, path.join(dir, generateFileNameForTest()), false);
    });
});

describeE2E("E2E Agent with full access file permission tests", () => {
    let fixture: SpawnedAgentFixture;

    beforeEach(async () => {
        fixture = await createAuthenticatedFixture(AgentMode.AgentFullAccess);
    });

    afterEach(async () => {
        await fixture.dispose();
    });

    it("edits a file outside workspace without prompting for permission", async () => {
        const dir = createDirOutsideWorkspace(fixture);
        const sessionId = await editFileDirectly(fixture, path.join(dir, generateFileNameForTest()), true);
        expectNoPermissionRequests(fixture, sessionId);
    });
});

async function editFileDirectly(
    fixture: SpawnedAgentFixture,
    filePath: string,
    expectSuccess: boolean,
): Promise<string> {
    const sessionId = (await fixture.createSession()).sessionId;
    await fixture.connection.prompt({
        sessionId,
        prompt: [{
            type: "text",
            text: `Create ${filePath} by editing files directly. Content must be exactly: ${FILE_CONTENT}. Do not use shell commands.`,
        }],
    });
    if (expectSuccess) {
        expect(fs.readFileSync(filePath, "utf8").trim()).toBe(FILE_CONTENT);
    } else {
        expect(fs.existsSync(filePath)).toBe(false);
    }
    return sessionId;
}

function createDirOutsideWorkspace(fixture: SpawnedAgentFixture): string {
    const outsideWorkspaceDir = path.join(path.dirname(fixture.workspaceDir), "outside-workspace");
    onTestFinished(() => fs.rmSync(outsideWorkspaceDir, {recursive: true, force: true}));
    fs.mkdirSync(outsideWorkspaceDir);
    return outsideWorkspaceDir;
}

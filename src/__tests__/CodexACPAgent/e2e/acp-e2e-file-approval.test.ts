import * as acp from "@agentclientprotocol/sdk";
import fs from "node:fs";
import path from "node:path";
import {afterEach, beforeEach, expect, it, onTestFinished, vi} from "vitest";
import {AgentMode} from "../../../AgentMode";
import {ApprovalOptionId} from "../../../permissions/option-ids";
import {
    createAuthenticatedFixture,
    createPermissionResponder,
    createPermissionResponse,
    describeE2E,
    expectEndTurn,
    expectNoPermissionRequests,
    generateFileNameForTest,
    type SpawnedAgentFixture,
} from "./acp-e2e-test-utils";

const FILE_CONTENT = "file approval e2e";
// The edit lands before the turn ends, so this only absorbs filesystem visibility lag.
const FILE_APPEARS_TIMEOUT_MS = 5_000;

describeE2E("E2E read-only mode file permission tests", () => {
    let fixture: SpawnedAgentFixture;

    beforeEach(async () => {
        fixture = await createAuthenticatedFixture(AgentMode.ReadOnly);
    });

    afterEach(async () => {
        await fixture.dispose();
    });

    it("applies an approved workspace file edit", async () => {
        fixture.setPermissionResponder(createPermissionResponder("edit", ApprovalOptionId.AllowOnce));
        const sessionId = await expectFileEditApplied(fixture, newFilePathIn(fixture.workspaceDir));
        expect(fixture.readPermissionRequests(sessionId, "edit").length).toBeGreaterThanOrEqual(1);
        expect(fixture.readPermissionRequests(sessionId, "execute")).toHaveLength(0);
    });

    it("does not apply a workspace file edit when permission is cancelled", async () => {
        fixture.setPermissionResponder(() => createPermissionResponse(null));
        await expectFileEditBlocked(fixture, newFilePathIn(fixture.workspaceDir));
    });

    it("can't edit file outside workspace", async () => {
        await expectFileEditBlocked(fixture, newFilePathIn(createDirOutsideWorkspace(fixture)));
    });
});

describeE2E("E2E workspace access mode file permission tests", () => {
    let fixture: SpawnedAgentFixture;

    beforeEach(async () => {
        fixture = await createAuthenticatedFixture(AgentMode.WorkspaceWrite);
    });

    afterEach(async () => {
        await fixture.dispose();
    });

    it("edits a workspace file without prompting for permission", async () => {
        const sessionId = await expectFileEditApplied(fixture, newFilePathIn(fixture.workspaceDir));
        expectNoPermissionRequests(fixture, sessionId);
    });
});

describeE2E("E2E switching to read-only mode file permission tests", () => {
    let fixture: SpawnedAgentFixture;

    beforeEach(async () => {
        fixture = await createAuthenticatedFixture(AgentMode.WorkspaceWrite);
    });

    afterEach(async () => {
        await fixture.dispose();
    });

    it("does not apply a rejected workspace edit after setSessionMode succeeds", async () => {
        const session = await fixture.createSession();
        expect(session.modes?.currentModeId).toBe(AgentMode.WorkspaceWrite.id);
        await fixture.connection.setSessionMode({
            sessionId: session.sessionId,
            modeId: AgentMode.ReadOnly.id,
        });
        fixture.setPermissionResponder(createPermissionResponder("edit", ApprovalOptionId.Cancel));

        await expectFileEditBlocked(fixture, newFilePathIn(fixture.workspaceDir), session.sessionId);
    });
});

describeE2E("E2E full-access mode file permission tests", () => {
    let fixture: SpawnedAgentFixture;

    beforeEach(async () => {
        fixture = await createAuthenticatedFixture(AgentMode.AgentFullAccess);
    });

    afterEach(async () => {
        await fixture.dispose();
    });

    it("edits a file outside workspace without prompting for permission", async () => {
        const sessionId = await expectFileEditApplied(fixture, newFilePathIn(createDirOutsideWorkspace(fixture)));
        expectNoPermissionRequests(fixture, sessionId);
    });
});

async function expectFileEditApplied(fixture: SpawnedAgentFixture, filePath: string): Promise<string> {
    const turn = await askAgentToEditFile(fixture, filePath);
    expectEndTurn(turn.response);
    await vi.waitFor(() => {
        expect(fs.existsSync(filePath), turn.diagnostics()).toBe(true);
        expect(fs.readFileSync(filePath, "utf8").trim(), turn.diagnostics()).toBe(FILE_CONTENT);
    }, {timeout: FILE_APPEARS_TIMEOUT_MS});
    return turn.sessionId;
}

async function expectFileEditBlocked(
    fixture: SpawnedAgentFixture,
    filePath: string,
    sessionId?: string,
): Promise<string> {
    const turn = await askAgentToEditFile(fixture, filePath, sessionId);
    // No end_turn assertion: a declining model may legitimately stop with `refusal`,
    // so its stop reason stays diagnostic rather than becoming a second way to fail.
    expect(fs.existsSync(filePath), turn.diagnostics()).toBe(false);
    return turn.sessionId;
}

interface EditFileTurn {
    readonly sessionId: string;
    readonly response: acp.PromptResponse;
    // The prompt is natural language, so a failure means the model did something other
    // than asked. Its stop reason and its own words tell you which, where a bare ENOENT
    // cannot say whether it refused, wrote elsewhere or reached for the shell.
    diagnostics(): string;
}

async function askAgentToEditFile(
    fixture: SpawnedAgentFixture,
    filePath: string,
    existingSessionId?: string,
): Promise<EditFileTurn> {
    const sessionId = existingSessionId ?? (await fixture.createSession()).sessionId;
    const response = await fixture.connection.prompt({
        sessionId,
        prompt: [{
            type: "text",
            text: `Create ${filePath} by editing files directly. Content must be exactly: '${FILE_CONTENT}'. Do not use shell commands.`,
        }],
    });
    return {
        sessionId,
        response,
        diagnostics: () => {
            const said = fixture.readText(sessionId).trim();
            return `stopReason=${response.stopReason}; agent said: ${said.length > 0 ? said : "<nothing>"}`;
        },
    };
}

function newFilePathIn(directory: string): string {
    return path.join(directory, generateFileNameForTest());
}

function createDirOutsideWorkspace(fixture: SpawnedAgentFixture): string {
    const outsideWorkspaceDir = path.join(path.dirname(fixture.workspaceDir), "outside-workspace");
    onTestFinished(() => fs.rmSync(outsideWorkspaceDir, {recursive: true, force: true}));
    fs.mkdirSync(outsideWorkspaceDir);
    return outsideWorkspaceDir;
}

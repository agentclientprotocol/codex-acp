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
    expectCancelled,
    expectEndTurn,
    expectNoPermissionRequests,
    expectPermissionRequests,
    generateFileNameForTest,
    type SpawnedAgentFixture,
} from "./acp-e2e-test-utils";

const FIRST_FILE_NAME = "approval-first.txt";
const SECOND_FILE_NAME = "approval-second.txt";

describeE2E("E2E shell approval tests", () => {
    let fixture: SpawnedAgentFixture;
    let sessionId: string;
    let firstFilePath: string;
    let secondFilePath: string;
    let command: string;

    beforeEach(async () => {
        fixture = await createAuthenticatedFixture(AgentMode.ReadOnly);
        sessionId = (await fixture.createSession()).sessionId;
        const outsideWorkspace = createDirOutsideWorkspace(fixture);
        firstFilePath = path.join(outsideWorkspace, FIRST_FILE_NAME);
        secondFilePath = path.join(outsideWorkspace, SECOND_FILE_NAME);
        command = `if [ -e '${firstFilePath}' ]; then touch '${secondFilePath}'; else touch '${firstFilePath}'; fi`;
    });

    afterEach(async () => {
        await fixture.dispose();
    });

    async function promptShellCommandTwice(
        expectedStopReasons: ["end_turn" | "cancelled", "end_turn" | "cancelled"],
    ): Promise<void> {
        const prompts = [
            `Use your shell tool to run exactly \`${command}\`.`,
            `Use your shell tool to run exactly the same command again: \`${command}\`.`,
        ];
        for (const [index, text] of prompts.entries()) {
            const response = await fixture.connection.prompt({
                sessionId,
                prompt: [{type: "text", text}],
            });
            if (expectedStopReasons[index] === "cancelled") {
                expectCancelled(response);
            } else {
                expectEndTurn(response);
            }
        }
    }

    it("prompts for every command when allow_once is selected", async () => {
        const responses = [ApprovalOptionId.AllowOnce, ApprovalOptionId.Cancel];
        fixture.setPermissionResponder((request) => createPermissionResponse(
            request.toolCall.kind === "execute"
                ? responses.shift() ?? ApprovalOptionId.Cancel
                : null
        ));
        await promptShellCommandTwice(["end_turn", "cancelled"]);
        expect(fs.existsSync(firstFilePath)).toBe(true);
        expect(fs.existsSync(secondFilePath)).toBe(false);
        expectPermissionRequests(fixture, sessionId, {execute: 2, edit: 0});
    });

    it("skips subsequent approvals when the exec-policy amendment is accepted", async () => {
        fixture.setPermissionResponder(createPermissionResponder(
            "execute",
            ApprovalOptionId.AcceptWithExecpolicyAmendment,
        ));
        await promptShellCommandTwice(["end_turn", "end_turn"]);
        expect(fs.existsSync(firstFilePath)).toBe(true);
        expect(fs.existsSync(secondFilePath)).toBe(true);
        expectPermissionRequests(fixture, sessionId, {execute: 1, edit: 0});
    });

    it("cancels every command when cancel is selected", async () => {
        fixture.setPermissionResponder(createPermissionResponder("execute", ApprovalOptionId.Cancel));
        await promptShellCommandTwice(["cancelled", "cancelled"]);
        expect(fs.existsSync(firstFilePath)).toBe(false);
        expect(fs.existsSync(secondFilePath)).toBe(false);
        expectPermissionRequests(fixture, sessionId, {execute: 2, edit: 0});
    });
});

describeE2E("E2E read-only mode shell permission tests", () => {
    let fixture: SpawnedAgentFixture;

    beforeEach(async () => {
        fixture = await createAuthenticatedFixture(AgentMode.ReadOnly);
    });

    afterEach(async () => {
        await fixture.dispose();
    });

    it("runs a workspace command without prompting for permission", async () => {
        const sessionId = await writeToFile(fixture, path.join(fixture.workspaceDir, generateFileNameForTest()));

        expectNoPermissionRequests(fixture, sessionId);
    });

    it("requests permission for a command that writes outside the workspace", async () => {
        const dir = createDirOutsideWorkspace(fixture);
        fixture.setPermissionResponder(createPermissionResponder("execute", ApprovalOptionId.AllowOnce));
        const sessionId = await writeToFile(fixture, path.join(dir, generateFileNameForTest()));
        expectPermissionRequests(fixture, sessionId, {execute: 1, edit: 0});
    });
});

describeE2E("E2E full-access mode shell permission tests", () => {
    let fixture: SpawnedAgentFixture;

    beforeEach(async () => {
        fixture = await createAuthenticatedFixture(AgentMode.AgentFullAccess);
    });

    afterEach(async () => {
        await fixture.dispose();
    });

    it("runs a command outside workspace without prompting for permission", async () => {
        const dir = createDirOutsideWorkspace(fixture);
        const sessionId = await writeToFile(fixture, path.join(dir, generateFileNameForTest()));
        expectNoPermissionRequests(fixture, sessionId);
    });
});

describeE2E("E2E shell cancellation tests", () => {
    let fixture: SpawnedAgentFixture | null = null;

    afterEach(async () => {
        await fixture?.dispose();
        fixture = null;
    });

    function isProcessRunning(pid: number): boolean {
        try {
            process.kill(pid, 0);
            return true;
        } catch {
            return false;
        }
    }

    it("cancels a running shell command", async () => {
        fixture = await createAuthenticatedFixture(AgentMode.AgentFullAccess);
        const sessionId = (await fixture.createSession()).sessionId;
        const pidFilePath = path.join(fixture.workspaceDir, "cancel-command.pid");
        const command = `/bin/sh -c 'echo $$ > "${pidFilePath}"; exec sleep 100'`;

        const promptResponse = fixture.connection.prompt({
            sessionId,
            prompt: [{type: "text", text: `Use your shell tool to run exactly \`${command}\`.`}],
        });

        const pid = await vi.waitFor(() => {
            const content = fs.existsSync(pidFilePath) ? fs.readFileSync(pidFilePath, "utf8").trim() : "";
            const parsed = Number.parseInt(content, 10);
            expect(parsed).toBeGreaterThan(0);
            return parsed;
        }, {timeout: 10_000});
        expect(isProcessRunning(pid)).toBe(true);
        await fixture.connection.cancel({sessionId});

        expect((await promptResponse).stopReason).toBe("cancelled");
        await vi.waitFor(() => {
            expect(isProcessRunning(pid)).toBe(false);
        }, {timeout: 5_000});
    });
});

async function writeToFile(fixture: SpawnedAgentFixture, filePath: string): Promise<string> {
    const content = "hello from e2e";
    const command = `printf '${content}' > '${filePath}'`;
    const sessionId = (await fixture.createSession()).sessionId;
    const response = await fixture.connection.prompt({
        sessionId,
        prompt: [{
            type: "text",
            text: `Use your shell tool to run exactly \`${command}\`. Do not modify files any other way.`,
        }],
    });
    expectEndTurn(response);
    expect(fs.readFileSync(filePath, "utf8").trim()).toBe(content);
    return sessionId;
}

function createDirOutsideWorkspace(fixture: SpawnedAgentFixture): string {
    const outsideWorkspaceDir = path.join(path.dirname(fixture.workspaceDir), "outside-workspace");
    onTestFinished(() => fs.rmSync(outsideWorkspaceDir, {recursive: true, force: true}));
    fs.mkdirSync(outsideWorkspaceDir);
    return outsideWorkspaceDir;
}

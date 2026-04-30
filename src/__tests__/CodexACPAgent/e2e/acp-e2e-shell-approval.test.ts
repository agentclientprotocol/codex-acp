import fs from "node:fs";
import path from "node:path";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {AgentMode} from "../../../AgentMode";
import {ApprovalOptionId} from "../../../ApprovalOptionId";
import {
    createAuthenticatedFixture,
    createPermissionResponse,
    createPermissionResponder,
    describeE2E,
    expectEndTurn,
    type SpawnedAgentFixture,
} from "./acp-e2e-test-utils";

const FIRST_FILE_NAME = "approval-first.txt";
const SECOND_FILE_NAME = "approval-second.txt";
const COMMAND = `if [ -e ${FIRST_FILE_NAME} ]; then touch ${SECOND_FILE_NAME}; else touch ${FIRST_FILE_NAME}; fi`;

describeE2E("E2E shell approval tests", () => {
    let fixture: SpawnedAgentFixture;
    let sessionId: string;

    beforeEach(async () => {
        fixture = await createAuthenticatedFixture(AgentMode.ReadOnly);
        sessionId = (await fixture.createSession()).sessionId;
    });

    afterEach(async () => {
        await fixture.dispose();
    });

    async function promptShellCommandTwice(): Promise<void> {
        for (const text of [
            `Use your shell tool to run exactly \`${COMMAND}\`.`,
            `Use your shell tool to run exactly the same command again: \`${COMMAND}\`.`,
        ]) {
            expectEndTurn(await fixture.connection.prompt({
                sessionId,
                prompt: [{type: "text", text}],
            }));
        }
    }

    it("prompts for every command when allow_once is selected", async () => {
        const responses = [ApprovalOptionId.AllowOnce, ApprovalOptionId.RejectOnce];
        fixture.setPermissionResponder((request) => createPermissionResponse(
            request.toolCall.kind === "execute"
                ? responses.shift() ?? ApprovalOptionId.RejectOnce
                : null
        ));
        await promptShellCommandTwice();
        expect(fs.existsSync(path.join(fixture.workspaceDir, FIRST_FILE_NAME))).toBe(true);
        expect(fs.existsSync(path.join(fixture.workspaceDir, SECOND_FILE_NAME))).toBe(false);
        expect(fixture.readPermissionRequests(sessionId, "execute").length).toBe(2);
    });

    it("skips subsequent approvals when allow_always is selected", async () => {
        fixture.setPermissionResponder(createPermissionResponder("execute", ApprovalOptionId.AllowAlways));
        await promptShellCommandTwice();
        expect(fs.existsSync(path.join(fixture.workspaceDir, FIRST_FILE_NAME))).toBe(true);
        expect(fs.existsSync(path.join(fixture.workspaceDir, SECOND_FILE_NAME))).toBe(true);
        expect(fixture.readPermissionRequests(sessionId, "execute").length).toBe(1);
    });

    it("prompts for every command when reject_once is selected", async () => {
        fixture.setPermissionResponder(createPermissionResponder("execute", ApprovalOptionId.RejectOnce));
        await promptShellCommandTwice();
        expect(fs.existsSync(path.join(fixture.workspaceDir, FIRST_FILE_NAME))).toBe(false);
        expect(fs.existsSync(path.join(fixture.workspaceDir, SECOND_FILE_NAME))).toBe(false);
        expect(fixture.readPermissionRequests(sessionId, "execute").length).toBe(2);
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
        fixture = await createAuthenticatedFixture();
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

import fs from "node:fs";
import path from "node:path";
import {afterEach, beforeEach, expect, it} from "vitest";
import {ApprovalOptionId} from "../../../ApprovalOptionId";
import {
    createPermissionResponse,
    createPermissionResponder,
    createReadOnlyFixture,
    describeE2E,
    expectEndTurn,
    type SpawnedAgentFixture,
    type SpawnedSessionFixture,
} from "./acp-e2e-test-utils";

const FIRST_FILE_NAME = "approval-first.txt";
const SECOND_FILE_NAME = "approval-second.txt";
const COMMAND = `if [ -e ${FIRST_FILE_NAME} ]; then touch ${SECOND_FILE_NAME}; else touch ${FIRST_FILE_NAME}; fi`;

describeE2E("E2E shell approval tests", () => {
    let fixture: SpawnedAgentFixture;
    let session: SpawnedSessionFixture;

    beforeEach(async () => {
        fixture = await createReadOnlyFixture();
        session = await fixture.createSession();
    });

    afterEach(async () => {
        await fixture.dispose();
    });

    async function promptShellCommandTwice() {
        for (const text of [
            `Use your shell tool to run exactly \`${COMMAND}\`.`,
            `Use your shell tool to run exactly the same command again: \`${COMMAND}\`.`,
        ]) {
            expectEndTurn(await fixture.connection.prompt({
                sessionId: session.response.sessionId,
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
        expect(session.readPermissionRequests("execute").length).toBe(2);
    });

    it("skips subsequent approvals when allow_always is selected", async () => {
        fixture.setPermissionResponder(createPermissionResponder("execute", ApprovalOptionId.AllowAlways));
        await promptShellCommandTwice();
        expect(fs.existsSync(path.join(fixture.workspaceDir, FIRST_FILE_NAME))).toBe(true);
        expect(fs.existsSync(path.join(fixture.workspaceDir, SECOND_FILE_NAME))).toBe(true);
        expect(session.readPermissionRequests("execute").length).toBe(1);
    });

    it("prompts for every command when reject_once is selected", async () => {
        fixture.setPermissionResponder(createPermissionResponder("execute", ApprovalOptionId.RejectOnce));
        await promptShellCommandTwice();
        expect(fs.existsSync(path.join(fixture.workspaceDir, FIRST_FILE_NAME))).toBe(false);
        expect(fs.existsSync(path.join(fixture.workspaceDir, SECOND_FILE_NAME))).toBe(false);
        expect(session.readPermissionRequests("execute").length).toBe(2);
    });
});

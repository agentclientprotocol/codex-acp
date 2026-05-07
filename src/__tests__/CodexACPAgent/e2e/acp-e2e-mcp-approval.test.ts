import type * as acp from "@agentclientprotocol/sdk";
import fs from "node:fs";
import path from "node:path";
import {afterEach, beforeEach, expect, it} from "vitest";
import {McpApprovalOptionId, type McpApprovalOptionId as McpApprovalOptionIdValue} from "../../../McpApprovalOptionId";
import {
    createAuthenticatedFixture,
    describeE2E,
    expectEndTurn,
    type PermissionResponder,
    type SpawnedAgentFixture,
} from "./acp-e2e-test-utils";
import os from "node:os";

const MCP_SERVER_NAME = "integration-mcp";
const MCP_ECHO_MESSAGE = "mcp approval e2e";

function createMcpServer(invocationMarkerPath: string): acp.McpServerStdio {
    return {
        name: MCP_SERVER_NAME,
        command: process.execPath,
        args: [path.join(process.cwd(), "src/__tests__/CodexACPAgent/e2e/fixtures/invocation-aware-mcp-server.mjs")],
        env: [{
            name: "MCP_TOOL_INVOCATION_MARKER_PATH",
            value: invocationMarkerPath,
        }],
    };
}

function isMcpPermissionRequest(request: acp.RequestPermissionRequest): boolean {
    return request.toolCall.kind === "execute" && request._meta?.["is_mcp_tool_approval"] === true;
}

function createMcpPermissionResponse(optionId: McpApprovalOptionIdValue | null): acp.RequestPermissionResponse {
    if (optionId === null) {
        return {outcome: {outcome: "cancelled"}};
    }
    return {outcome: {outcome: "selected", optionId}};
}

function createMcpPermissionResponder(...optionIds: McpApprovalOptionIdValue[]): PermissionResponder {
    const queue = [...optionIds];
    return (request) => createMcpPermissionResponse(
        isMcpPermissionRequest(request)
            ? queue.shift() ?? McpApprovalOptionId.Decline
            : null,
    );
}

async function expectEchoToolReply(fixture: SpawnedAgentFixture, sessionId: string, message: string): Promise<void> {
    await fixture.expectPromptText(
        sessionId,
        `Use the ${MCP_SERVER_NAME} MCP echo tool with message "${message}". Reply with exactly the tool result and no extra text.`,
        (text) => expect(text).toContain(`You said: ${message}`),
    );
}

function expectMcpPermissionRequestCount(fixture: SpawnedAgentFixture, sessionId: string, count: number): void {
    const requests = fixture.readPermissionRequests(sessionId, "execute");
    expect(requests.length).toBe(count);
    for (const request of requests) {
        expect(isMcpPermissionRequest(request)).toBe(true);
    }
}

describeE2E("E2E MCP approval tests (configured in session)", () => {
    let fixture: SpawnedAgentFixture;

    beforeEach(async () => {
        fixture = await createAuthenticatedFixture();
    });

    afterEach(async () => {
        await fixture.dispose();
    });

    async function createMcpSession(): Promise<{ sessionId: string; invocationMarkerPath: string }> {
        const invocationMarkerPath = path.join(fixture.workspaceDir, `mcp-tool-invocation-${crypto.randomUUID()}.txt`);
        const sessionId = (await fixture.createSession([createMcpServer(invocationMarkerPath)])).sessionId;
        return {sessionId, invocationMarkerPath};
    }

    it("executes an approved MCP tool call", async () => {
        fixture.setPermissionResponder(createMcpPermissionResponder(McpApprovalOptionId.AllowOnce));
        const {sessionId, invocationMarkerPath} = await createMcpSession();

        await expectEchoToolReply(fixture, sessionId, MCP_ECHO_MESSAGE);
        expect(fs.readFileSync(invocationMarkerPath, "utf8")).toBe(MCP_ECHO_MESSAGE);
        expectMcpPermissionRequestCount(fixture, sessionId, 1);
    });

    it("ends turn when MCP tool call is rejected", async () => {
        fixture.setPermissionResponder(createMcpPermissionResponder(McpApprovalOptionId.Decline));
        const {sessionId, invocationMarkerPath} = await createMcpSession();

        expectEndTurn(await fixture.connection.prompt({
            sessionId,
            prompt: [{
                type: "text",
                text: `Use the ${MCP_SERVER_NAME} MCP echo tool with message "${MCP_ECHO_MESSAGE}". Stop if the tool call is rejected.`,
            }],
        }));
        expect(fs.existsSync(invocationMarkerPath)).toBe(false);
        expectMcpPermissionRequestCount(fixture, sessionId, 1);
    });

    it("skips subsequent approvals in the same session when allow_session is selected", async () => {
        fixture.setPermissionResponder(createMcpPermissionResponder(McpApprovalOptionId.AllowSession));
        const {sessionId, invocationMarkerPath} = await createMcpSession();

        await expectEchoToolReply(fixture, sessionId, "session approval first");
        await expectEchoToolReply(fixture, sessionId, "session approval second");

        expect(fs.readFileSync(invocationMarkerPath, "utf8")).toBe("session approval second");
        expectMcpPermissionRequestCount(fixture, sessionId, 1);
    });

    it("requests subsequent approvals after session restart when allow_session is selected", async () => {
        fixture.setPermissionResponder(createMcpPermissionResponder(McpApprovalOptionId.AllowSession, McpApprovalOptionId.AllowOnce));
        const {sessionId, invocationMarkerPath} = await createMcpSession();

        await expectEchoToolReply(fixture, sessionId, MCP_ECHO_MESSAGE);
        expectMcpPermissionRequestCount(fixture, sessionId, 1);

        fixture = await fixture.restart();
        await fixture.connection.loadSession({
            sessionId,
            cwd: fixture.workspaceDir,
            mcpServers: [createMcpServer(invocationMarkerPath)],
        });

        await expectEchoToolReply(fixture, sessionId, MCP_ECHO_MESSAGE);
        expectMcpPermissionRequestCount(fixture, sessionId, 2);
    });
});

describeE2E("E2E MCP approval tests (configured in toml)", () => {
    let invocationMarkerPath: string;
    let fixture: SpawnedAgentFixture;

    beforeEach(async () => {
        fixture = await createAuthenticatedFixture();
        invocationMarkerPath = path.join(os.tmpdir(), `mcp-tool-invocation-${crypto.randomUUID()}.txt`)
    });

    afterEach(async () => {
        await fixture.dispose();
        fs.rmSync(invocationMarkerPath, { force: true });
    });


    beforeEach(async () => {
        await fixture.dispose();
        fixture = await createAuthenticatedFixture(undefined, [createMcpServer(invocationMarkerPath)]);
    });

    it("skips subsequent approvals in the same session when allow_always is selected", async () => {
        fixture.setPermissionResponder(
            createMcpPermissionResponder(McpApprovalOptionId.AllowAlways),
        );
        const sessionId = (await fixture.createSession()).sessionId;

        await expectEchoToolReply(fixture, sessionId, "always approval first");
        await expectEchoToolReply(fixture, sessionId, "always approval second");

        expect(fs.readFileSync(invocationMarkerPath, "utf8")).toBe("always approval second");
        expectMcpPermissionRequestCount(fixture, sessionId, 1);
    });

    it.skip("skips subsequent approvals after session restart when allow_always is selected", async () => {
        fixture.setPermissionResponder(
            createMcpPermissionResponder(McpApprovalOptionId.AllowAlways),
        );
        const firstSessionId = (await fixture.createSession()).sessionId;

        await expectEchoToolReply(fixture, firstSessionId, "always approval first");

        fixture = await fixture.restart();
        fixture.setPermissionResponder((request) => {
            if (isMcpPermissionRequest(request)) {
                throw new Error("unexpected MCP approval after allow_always restart");
            }
            return createMcpPermissionResponse(null);
        });
        const newSessionId = (await fixture.createSession()).sessionId;
        await expectEchoToolReply(fixture, newSessionId, "always approval second");

        expect(fs.readFileSync(invocationMarkerPath, "utf8")).toBe("always approval second");
        expect(fixture.readPermissionRequests(newSessionId, "execute").length).toBe(0);
    });
});

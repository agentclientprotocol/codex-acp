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

function createMcpPermissionResponder(optionId: McpApprovalOptionIdValue): PermissionResponder {
    return (request) => createMcpPermissionResponse(isMcpPermissionRequest(request) ? optionId : null);
}

describeE2E("E2E MCP approval tests", () => {
    let fixture: SpawnedAgentFixture;

    beforeEach(async () => {
        fixture = await createAuthenticatedFixture();
    });

    afterEach(async () => {
        await fixture.dispose();
    });

    function expectMcpToolPermissionRequest(sessionId: string): void {
        const requests = fixture.readPermissionRequests(sessionId, "execute");
        expect(requests.length).toBe(1);
        expect(isMcpPermissionRequest(requests[0]!)).toBe(true);
    }

    it("executes an approved MCP tool call", async () => {
        fixture.setPermissionResponder(createMcpPermissionResponder(McpApprovalOptionId.AllowOnce));
        const invocationMarkerPath = path.join(fixture.workspaceDir, `mcp-tool-invocation-${crypto.randomUUID()}.txt`);
        const sessionId = (await fixture.createSession([createMcpServer(invocationMarkerPath)])).sessionId;

        await fixture.expectPromptText(
            sessionId,
            `Use the ${MCP_SERVER_NAME} MCP echo tool with message "${MCP_ECHO_MESSAGE}". Reply with exactly the tool result and no extra text.`,
            (text) => expect(text).toContain(`You said: ${MCP_ECHO_MESSAGE}`),
        );
        expect(fs.readFileSync(invocationMarkerPath, "utf8")).toBe(MCP_ECHO_MESSAGE);
        expectMcpToolPermissionRequest(sessionId);
    });

    it("ends turn when MCP tool call is rejected", async () => {
        fixture.setPermissionResponder(createMcpPermissionResponder(McpApprovalOptionId.Decline));
        const invocationMarkerPath = path.join(fixture.workspaceDir, `mcp-tool-invocation-${crypto.randomUUID()}.txt`);
        const sessionId = (await fixture.createSession([createMcpServer(invocationMarkerPath)])).sessionId;

        expectEndTurn(await fixture.connection.prompt({
            sessionId,
            prompt: [{
                type: "text",
                text: `Use the ${MCP_SERVER_NAME} MCP echo tool with message "${MCP_ECHO_MESSAGE}". Stop if the tool call is rejected.`,
            }],
        }));
        expect(fs.existsSync(invocationMarkerPath)).toBe(false);
        expectMcpToolPermissionRequest(sessionId);
    });
});

import type * as acp from "@agentclientprotocol/sdk";
import path from "node:path";
import {afterEach, beforeEach, expect, it} from "vitest";
import {ApprovalOptionId} from "../../../ApprovalOptionId";
import {
    createAuthenticatedFixture,
    createPermissionResponse,
    describeE2E,
    expectEndTurn,
    type PermissionResponder,
    type SpawnedAgentFixture,
} from "./acp-e2e-test-utils";

const MCP_SERVER_NAME = "integration-mcp";
const MCP_ECHO_MESSAGE = "mcp approval e2e";

function createMcpServer(): acp.McpServerStdio {
    return {
        name: MCP_SERVER_NAME,
        command: process.execPath,
        args: [path.join(process.cwd(), "node_modules/mcp-hello-world/build/stdio.js")],
        env: [],
    };
}

function isMcpPermissionRequest(request: acp.RequestPermissionRequest): boolean {
    return request.toolCall.kind === "execute" && request._meta?.["is_mcp_tool_approval"] === true;
}

function createMcpPermissionResponder(optionId: ApprovalOptionId): PermissionResponder {
    return (request) => createPermissionResponse(isMcpPermissionRequest(request) ? optionId : null);
}

describeE2E("E2E MCP approval tests", () => {
    let fixture: SpawnedAgentFixture;
    let sessionId: string;

    beforeEach(async () => {
        fixture = await createAuthenticatedFixture();
        sessionId = (await fixture.createSession([createMcpServer()])).sessionId;
    });

    afterEach(async () => {
        await fixture.dispose();
    });

    function expectMcpToolPermissionRequest(): void {
        const requests = fixture.readPermissionRequests(sessionId, "execute");
        expect(requests.length).toBe(1);
        expect(isMcpPermissionRequest(requests[0]!)).toBe(true);
    }

    it("executes an approved MCP tool call", async () => {
        fixture.setPermissionResponder(createMcpPermissionResponder(ApprovalOptionId.AllowOnce));

        await fixture.expectPromptText(
            sessionId,
            `Use the ${MCP_SERVER_NAME} MCP echo tool with message "${MCP_ECHO_MESSAGE}". Reply with exactly the tool result and no extra text.`,
            (text) => expect(text).toContain(`You said: ${MCP_ECHO_MESSAGE}`),
        );
        expectMcpToolPermissionRequest();
    });

    it("ends turn when MCP tool call is rejected", async () => {
        fixture.setPermissionResponder(createMcpPermissionResponder(ApprovalOptionId.RejectOnce));

        expectEndTurn(await fixture.connection.prompt({
            sessionId,
            prompt: [{
                type: "text",
                text: `Use the ${MCP_SERVER_NAME} MCP echo tool with message "${MCP_ECHO_MESSAGE}". Stop if the tool call is rejected.`,
            }],
        }));
        expectMcpToolPermissionRequest();
    });
});

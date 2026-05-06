import fs from "node:fs/promises";
import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {z} from "zod";

const markerPath = process.env["MCP_TOOL_INVOCATION_MARKER_PATH"];

if (!markerPath) {
    throw new Error("MCP_TOOL_INVOCATION_MARKER_PATH is required.");
}

const server = new McpServer({
    name: "integration-mcp",
    version: "1.0.0",
});

server.tool(
    "echo",
    "Echoes back a message with a side effect for test assertions.",
    {message: z.string().describe("The message to echo")},
    async ({message}) => {
        await fs.writeFile(markerPath, message, "utf8");
        return {
            content: [{
                type: "text",
                text: `You said: ${message}`,
            }],
        };
    },
);

await server.connect(new StdioServerTransport());

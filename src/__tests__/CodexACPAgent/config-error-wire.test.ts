import * as acp from "@agentclientprotocol/sdk/unstable";
import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {ResponseError} from "vscode-jsonrpc/node";
import {afterEach, describe, expect, it, vi} from "vitest";
import {createAcpAgentRouter} from "../../AcpAgentRouter";
import {CodexAcpClient} from "../../CodexAcpClient";
import {CodexAcpServer} from "../../CodexAcpServer";
import {CodexAppServerClient} from "../../CodexAppServerClient";
import {createMockConnections} from "./test-utils";

type ProtocolVersion = "v1" | "v2";

const versions: ProtocolVersion[] = ["v1", "v2"];
const safeConfigMessage = "Codex could not load its configuration. Check the global and project .codex directories, "
    + "especially config.toml files or any CODEX_CONFIG override.";

function connectClient(version: ProtocolVersion, threadStartError: Error) {
    const mocks = createMockConnections();
    mocks.mockCodexConnection.sendRequest.mockImplementation(async (method: string) => {
        switch (method) {
            case "initialize":
                return {codexHome: "/home/codex"};
            case "thread/start":
                throw threadStartError;
            default:
                return {};
        }
    });
    const codexAcpClient = new CodexAcpClient(new CodexAppServerClient(mocks.mockCodexConnection as any));
    vi.spyOn(codexAcpClient, "readAuthRequirement").mockResolvedValue({required: false, account: null});
    const router = createAcpAgentRouter(connection => new CodexAcpServer(connection, codexAcpClient));
    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
    router.connect(acp.ndJsonStream(agentToClient.writable, clientToAgent.readable));
    const stream = acp.ndJsonStream(clientToAgent.writable, agentToClient.readable);

    if (version === "v1") {
        const connection = acp.client({name: "test-client"}).connect(stream);
        return {
            close: () => connection.close(),
            initialize: () => connection.agent.request(acp.methods.agent.initialize, {
                protocolVersion: acp.PROTOCOL_VERSION,
            }),
            newSession: () => connection.agent.request(acp.methods.agent.session.new, {
                cwd: "/workspace",
                mcpServers: [],
            }),
        };
    }

    const connection = acpV2.client({name: "test-client"}).connect(stream);
    return {
        close: () => connection.close(),
        initialize: () => connection.agent.request(acpV2.methods.agent.initialize, {
            protocolVersion: 2,
            info: {name: "test-client", version: "1.0.0"},
        }),
        newSession: () => connection.agent.request(acpV2.methods.agent.session.new, {
            cwd: "/workspace",
        }),
    };
}

describe("config errors over ACP", () => {
    const clients: Array<{close(): void}> = [];

    afterEach(() => {
        clients.splice(0).forEach(client => client.close());
        vi.clearAllMocks();
    });

    it.each(versions)("%s: presents fixed guidance without promoting recognized raw config detail", async version => {
        const marker = "PRIVATE_CONFIG_MARKER=/home/alice/.codex/config.toml";
        const client = connectClient(version, new ResponseError(
            -32600,
            `failed to load configuration: invalid value ${marker}`,
            {source: "config"},
        ));
        clients.push(client);
        await client.initialize();

        const error = await client.newSession().catch(value => value);

        expect(error).toMatchObject({
            code: -32603,
            message: `Internal error: ${safeConfigMessage}`,
            data: {details: expect.stringContaining(marker)},
        });
        expect(error.message).not.toContain(marker);
    });

    it.each(versions)("%s: keeps unrelated internal errors generic", async version => {
        const marker = "UNKNOWN_PRIVATE_MARKER=/home/alice/secret";
        const client = connectClient(version, new Error(`unexpected failure ${marker}`));
        clients.push(client);
        await client.initialize();

        const error = await client.newSession().catch(value => value);

        expect(error).toMatchObject({
            code: -32603,
            message: "Internal error",
            data: {details: expect.stringContaining(marker)},
        });
        expect(error.message).not.toContain(marker);
    });
});

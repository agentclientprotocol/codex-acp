import * as acp from "@agentclientprotocol/sdk/unstable";
import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {ResponseError} from "vscode-jsonrpc/node";
import {afterEach, describe, expect, it, vi} from "vitest";
import {createMockConnections} from "./test-utils";

type ProtocolVersion = "v1" | "v2";

const versions: ProtocolVersion[] = ["v1", "v2"];
const safeConfigMessage = "Codex could not load its configuration. Check the global and project .codex directories, "
    + "especially config.toml files or any CODEX_CONFIG override.";
const safeDeletedDirectoryMessage = "Codex cannot read its configuration because its working directory was deleted "
    + "or replaced. Restart the agent.";
const originalDirectory = process.cwd();
const temporaryDirectories: string[] = [];

async function connectClient(version: ProtocolVersion, threadStartError: Error) {
    const [
        {createAcpAgentRouter},
        {CodexAcpClient},
        {CodexAcpServer},
        {CodexAppServerClient},
    ] = await Promise.all([
        import("../../AcpAgentRouter"),
        import("../../CodexAcpClient"),
        import("../../CodexAcpServer"),
        import("../../CodexAppServerClient"),
    ]);
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
        process.chdir(originalDirectory);
        temporaryDirectories.splice(0).forEach(directory => fs.rmSync(directory, {recursive: true, force: true}));
        clients.splice(0).forEach(client => client.close());
        vi.clearAllMocks();
    });

    it.each(versions)("%s: presents fixed guidance without promoting recognized raw config detail", async version => {
        const marker = "PRIVATE_CONFIG_MARKER=/home/alice/.codex/config.toml";
        const client = await connectClient(version, new ResponseError(
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

    it.each(versions)("%s: presents fixed guidance without promoting a deleted working-directory path", async version => {
        const workingDirectory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "PRIVATE_CWD_MARKER-")));
        temporaryDirectories.push(workingDirectory);
        process.chdir(workingDirectory);
        vi.resetModules();
        const client = await connectClient(version, new ResponseError(
            -32600,
            `failed to load configuration: No such file or directory (os error 2): ${workingDirectory}`,
        ));
        clients.push(client);
        await client.initialize();
        process.chdir(originalDirectory);
        fs.rmdirSync(workingDirectory);

        const error = await client.newSession().catch(value => value);

        expect(error).toMatchObject({
            code: -32603,
            message: `Internal error: ${safeDeletedDirectoryMessage}`,
            data: {details: expect.stringContaining(workingDirectory)},
        });
        expect(error.message).not.toContain(workingDirectory);
    });

    it.each(versions)("%s: keeps unrelated internal errors generic", async version => {
        const marker = "UNKNOWN_PRIVATE_MARKER=/home/alice/secret";
        const client = await connectClient(version, new Error(`unexpected failure ${marker}`));
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

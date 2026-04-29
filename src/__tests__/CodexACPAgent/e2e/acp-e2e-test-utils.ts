import * as acp from "@agentclientprotocol/sdk";
import {describe, expect} from "vitest";
import {AgentMode} from "../../../AgentMode";
import {createSpawnedAgentFixture, type SpawnedAgentFixture} from "./spawned-agent-fixture";

export {
    createPermissionResponder,
    createPermissionResponse,
    type PermissionResponder,
} from "./permission-responders";
export {
    DEFAULT_TEST_MODEL_ID,
    type SpawnedAgentFixture,
    type TestSkill,
    OTHER_TEST_MODEL_ID,
} from "./spawned-agent-fixture";

export const RUN_E2E_TESTS = process.env["RUN_E2E_TESTS"] === "true";
const DEFAULT_E2E_SUITE_TIMEOUT_MS = 60_000;

export function describeE2E(name: string, factory: () => void, timeoutMs = DEFAULT_E2E_SUITE_TIMEOUT_MS): void {
    describe.skipIf(!RUN_E2E_TESTS)(name, {timeout: timeoutMs}, factory);
}

export function expectEndTurn(response: acp.PromptResponse): void {
    expect(response.stopReason).toBe("end_turn");
}

export async function createAuthenticatedFixture(extraEnv?: NodeJS.ProcessEnv): Promise<SpawnedAgentFixture> {
    const apiKey = requireLiveApiKey();
    return await createSpawnedFixture(async (connection, authMethods) => {
        if (!authMethods.some((method) => method.id === "api-key")) {
            throw new Error("API key authentication is not available.");
        }

        await connection.authenticate({
            methodId: "api-key",
            _meta: {
                "api-key": {
                    apiKey,
                },
            },
        });

        const authenticationStatus = await getAuthenticationStatus(connection);
        if (authenticationStatus["type"] !== "api-key") {
            throw new Error(`Unexpected authentication status: ${JSON.stringify(authenticationStatus)}`);
        }
    }, extraEnv);
}

export async function createReadOnlyFixture(): Promise<SpawnedAgentFixture> {
    return await createAuthenticatedFixture({INITIAL_AGENT_MODE: AgentMode.ReadOnly.id});
}

export async function createGatewayFixture(
    baseUrl: string,
    headers: Record<string, string>,
): Promise<SpawnedAgentFixture> {
    return await createSpawnedFixture(async (connection, authMethods) => {
        if (!authMethods.some((method) => method.id === "gateway")) {
            throw new Error("Gateway authentication is not available.");
        }

        await connection.authenticate({
            methodId: "gateway",
            _meta: {
                gateway: {
                    baseUrl,
                    headers,
                },
            },
        });

        const authenticationStatus = await getAuthenticationStatus(connection);
        if (authenticationStatus["type"] !== "gateway" || authenticationStatus["name"] !== "custom-gateway") {
            throw new Error(`Unexpected authentication status: ${JSON.stringify(authenticationStatus)}`);
        }
    });
}

function buildClientCapabilities(): acp.ClientCapabilities {
    return {
        fs: {
            readTextFile: true,
            writeTextFile: true,
        },
        terminal: true,
        auth: {
            _meta: {
                gateway: true,
            },
        },
        _meta: {
            "terminal-auth": true,
        },
    };
}

type Authenticator = (connection: acp.ClientSideConnection, authMethods: acp.AuthMethod[]) => Promise<void>;

async function createSpawnedFixture(
    authenticate: Authenticator,
    extraEnv?: NodeJS.ProcessEnv,
): Promise<SpawnedAgentFixture> {
    const fixture = createSpawnedAgentFixture(extraEnv);
    const connection = fixture.connection;

    const initializeResponse = await connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: buildClientCapabilities(),
        clientInfo: {
            name: "vitest",
            version: "1.0.0",
        },
    });

    if (initializeResponse.protocolVersion !== acp.PROTOCOL_VERSION) {
        throw new Error(`Unexpected protocol version: ${initializeResponse.protocolVersion}`);
    }

    await authenticate(connection, initializeResponse.authMethods ?? []);
    return fixture;
}

export function requireLiveApiKey(): string {
    const apiKey = process.env["CODEX_API_KEY"] ?? process.env["OPENAI_API_KEY"];
    if (!apiKey) {
        throw new Error("Live integration test requires CODEX_API_KEY or OPENAI_API_KEY.");
    }
    return apiKey;
}

async function getAuthenticationStatus(connection: acp.ClientSideConnection): Promise<Record<string, unknown>> {
    return await connection.extMethod("authentication/status", {});
}

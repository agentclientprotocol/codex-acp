import * as acp from "@agentclientprotocol/sdk";
import {type ChildProcessWithoutNullStreams, spawn} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {Readable, Writable} from "node:stream";
import {describe, expect, vi} from "vitest";
import {AgentMode} from "../../../AgentMode";
import {ApprovalOptionId} from "../../../ApprovalOptionId";
import {removeDirectoryWithRetry, writeCodexHomeConfig} from "../../acp-test-utils";

export const RUN_E2E_TESTS = process.env["RUN_E2E_TESTS"] === "true";
const DEFAULT_E2E_SUITE_TIMEOUT_MS = 60_000;

export interface SpawnedSessionFixture {
    readonly response: acp.NewSessionResponse;
    expectPromptText(promptText: string, assertText: (text: string) => void, timeoutMs?: number): Promise<void>;
    readPermissionRequests(toolCallKind: acp.ToolKind): acp.RequestPermissionRequest[];
}

export function expectEndTurn(response: acp.PromptResponse): void {
    expect(response.stopReason).toBe("end_turn");
}

export type PermissionResponder = (
    params: acp.RequestPermissionRequest,
) => acp.RequestPermissionResponse;

export function createPermissionResponder(
    expectedToolCallKind: acp.ToolKind,
    optionId: ApprovalOptionId,
): PermissionResponder {
    return (request) => createPermissionResponse(
        request.toolCall.kind === expectedToolCallKind ? optionId : null
    );
}

export function createPermissionResponse(optionId: ApprovalOptionId | null): acp.RequestPermissionResponse {
    if (optionId === null) {
        return {outcome: {outcome: "cancelled"}};
    }
    return {outcome: {outcome: "selected", optionId}};
}

export interface SpawnedAgentFixture {
    readonly connection: acp.ClientSideConnection;
    readonly workspaceDir: string;
    createSession(): Promise<SpawnedSessionFixture>;
    setPermissionResponder(responder: PermissionResponder): void;
    dispose(): Promise<void>;
}

export function describeE2E(name: string, factory: () => void, timeoutMs = DEFAULT_E2E_SUITE_TIMEOUT_MS): void {
    describe.skipIf(!RUN_E2E_TESTS)(name, {timeout: timeoutMs}, factory);
}

export async function expectStatus(
    session: SpawnedSessionFixture,
    fields: Record<string, unknown>,
): Promise<void> {
    await session.expectPromptText("/status", (text) => {
        for (const [field, value] of Object.entries(fields)) {
            expect(text).toContain(`**${field}:** ${String(value)}`);
        }
    });
}

interface TestSkill {
    readonly name: string;
    readonly description: string;
    readonly body: string;
}

interface RuntimePaths {
    readonly rootDir: string;
    readonly codexHome: string;
    readonly workspaceDir: string;
    readonly appServerLogsDir: string;
}

class RecordingClient implements acp.Client {
    private readonly textBySessionId = new Map<string, string>();
    private readonly permissionRequestsBySessionId = new Map<string, acp.RequestPermissionRequest[]>();
    private permissionResponder: PermissionResponder = () => ({
        outcome: {outcome: "cancelled"},
    });

    setPermissionResponder(responder: PermissionResponder): void {
        this.permissionResponder = responder;
    }

    async requestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
        let requests = this.permissionRequestsBySessionId.get(params.sessionId);
        if (!requests) {
            requests = [];
            this.permissionRequestsBySessionId.set(params.sessionId, requests);
        }
        requests.push(params);
        return this.permissionResponder(params);
    }

    async sessionUpdate(params: acp.SessionNotification): Promise<void> {
        if (params.update.sessionUpdate !== "agent_message_chunk" || params.update.content.type !== "text") {
            return;
        }

        const nextText = `${this.textBySessionId.get(params.sessionId) ?? ""}${params.update.content.text}`;
        this.textBySessionId.set(params.sessionId, nextText);
    }

    readText(sessionId: string): string {
        return this.textBySessionId.get(sessionId) ?? "";
    }

    readPermissionRequests(
        sessionId: string,
        toolCallKind: acp.ToolKind,
    ): acp.RequestPermissionRequest[] {
        const requests = this.permissionRequestsBySessionId.get(sessionId) ?? [];
        return requests.filter((request) => request.toolCall.kind === toolCallKind);
    }
}

export async function createFixtureWithSkill(skill: TestSkill): Promise<SpawnedAgentFixture> {
    const runtimePaths = createTemporaryRuntimePaths();
    writeSkill(runtimePaths.codexHome, skill);
    return await createAuthenticatedFixture(runtimePaths);
}

export async function createAuthenticatedFixture(
    runtimePaths = createTemporaryRuntimePaths(),
    extraEnv?: NodeJS.ProcessEnv,
): Promise<SpawnedAgentFixture> {
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
    }, runtimePaths, extraEnv);
}

export async function createReadOnlyFixture(): Promise<SpawnedAgentFixture> {
    return await createAuthenticatedFixture(undefined, {INITIAL_AGENT_MODE: AgentMode.ReadOnly.id});
}

export interface GatewayFixtureOptions {
    readonly baseUrl: string;
    readonly headers?: Record<string, string>;
}

export async function createGatewayFixture(
    options: GatewayFixtureOptions,
    runtimePaths = createTemporaryRuntimePaths(),
): Promise<SpawnedAgentFixture> {
    return await createSpawnedFixture(async (connection, authMethods) => {
        if (!authMethods.some((method) => method.id === "gateway")) {
            throw new Error("Gateway authentication is not available.");
        }

        await connection.authenticate({
            methodId: "gateway",
            _meta: {
                gateway: {
                    baseUrl: options.baseUrl,
                    headers: options.headers ?? {},
                },
            },
        });

        const authenticationStatus = await getAuthenticationStatus(connection);
        if (authenticationStatus["type"] !== "gateway" || authenticationStatus["name"] !== "custom-gateway") {
            throw new Error(`Unexpected authentication status: ${JSON.stringify(authenticationStatus)}`);
        }
    }, runtimePaths);
}

type Authenticator = (connection: acp.ClientSideConnection, authMethods: acp.AuthMethod[]) => Promise<void>;

async function createSpawnedFixture(
    authenticate: Authenticator,
    runtimePaths: RuntimePaths,
    extraEnv?: NodeJS.ProcessEnv,
): Promise<SpawnedAgentFixture> {
    const agentProcess = spawn("npm", ["run", "--silent", "start"], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            CODEX_HOME: runtimePaths.codexHome,
            APP_SERVER_LOGS: runtimePaths.appServerLogsDir,
            ...extraEnv,
        },
        stdio: ["pipe", "pipe", "pipe"],
    });

    const client = new RecordingClient();
    const output = Readable.toWeb(agentProcess.stdout) as ReadableStream<Uint8Array>;
    const connection = new acp.ClientSideConnection(
        () => client,
        acp.ndJsonStream(Writable.toWeb(agentProcess.stdin), output)
    );

    const initializeResponse = await connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: {
            name: "vitest",
            version: "1.0.0",
        },
    });

    if (initializeResponse.protocolVersion !== acp.PROTOCOL_VERSION) {
        throw new Error(`Unexpected protocol version: ${initializeResponse.protocolVersion}`);
    }

    await authenticate(connection, initializeResponse.authMethods ?? []);

    const createSession = async (): Promise<SpawnedSessionFixture> => {
        const newSessionResponse = await connection.newSession({
            cwd: runtimePaths.workspaceDir,
            mcpServers: [],
        });

        return {
            response: newSessionResponse,
            async expectPromptText(promptText: string, assertText: (text: string) => void, timeoutMs = 30_000): Promise<void> {
                await expectPromptTextForSession(connection, client, newSessionResponse.sessionId, promptText, assertText, timeoutMs);
            },
            readPermissionRequests(toolCallKind: acp.ToolKind): acp.RequestPermissionRequest[] {
                return client.readPermissionRequests(newSessionResponse.sessionId, toolCallKind);
            },
        };
    };

    return {
        connection,
        workspaceDir: runtimePaths.workspaceDir,
        createSession,
        setPermissionResponder(responder: PermissionResponder): void {
            client.setPermissionResponder(responder);
        },
        async dispose(): Promise<void> {
            if (!agentProcess.stdin.destroyed && !agentProcess.stdin.writableEnded) {
                agentProcess.stdin.end();
            }

            const exitedAfterStdinClose = await waitForProcessExit(agentProcess, 4_000);
            if (!exitedAfterStdinClose && !agentProcess.killed) {
                agentProcess.kill();
                await waitForProcessExit(agentProcess, 4_000);
            }

            printLogDirectory(runtimePaths.appServerLogsDir);
            removeDirectoryWithRetry(runtimePaths.rootDir);
        },
    };
}

export function requireLiveApiKey(): string {
    const apiKey = process.env["CODEX_API_KEY"] ?? process.env["OPENAI_API_KEY"];
    if (!apiKey) {
        throw new Error("Live integration test requires CODEX_API_KEY or OPENAI_API_KEY.");
    }
    return apiKey;
}

function createTemporaryRuntimePaths(): RuntimePaths {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-acp-integration-"));
    const codexHome = path.join(rootDir, "codex-home");
    const workspaceDir = path.join(rootDir, "workspace");
    const appServerLogsDir = path.join(rootDir, "logs");

    fs.mkdirSync(codexHome, {recursive: true});
    fs.mkdirSync(workspaceDir, {recursive: true});
    fs.mkdirSync(appServerLogsDir, {recursive: true});
    writeCodexHomeConfig(codexHome, {
        model: "gpt-5.2",
        model_reasoning_effort: "none",
        web_search: "disabled",
    });

    return {
        rootDir,
        codexHome,
        workspaceDir,
        appServerLogsDir,
    };
}

function writeSkill(codexHome: string, skill: TestSkill): void {
    const skillDirectory = path.join(codexHome, "skills", skill.name);
    fs.mkdirSync(skillDirectory, {recursive: true});
    fs.writeFileSync(
        path.join(skillDirectory, "SKILL.md"),
        [
            "---",
            `name: ${skill.name}`,
            `description: ${skill.description}`,
            "metadata:",
            `  short-description: ${skill.description}`,
            "---",
            "",
            skill.body,
            "",
        ].join("\n"),
        "utf8",
    );
}

async function getAuthenticationStatus(connection: acp.ClientSideConnection): Promise<Record<string, unknown>> {
    return await connection.extMethod("authentication/status", {});
}

async function expectPromptTextForSession(
    connection: acp.ClientSideConnection,
    client: RecordingClient,
    sessionId: string,
    promptText: string,
    assertText: (text: string) => void,
    timeoutMs: number,
): Promise<void> {
    const previousText = client.readText(sessionId);
    const promptResponse = await connection.prompt({
        sessionId,
        prompt: [{
            type: "text",
            text: promptText,
        }],
    });

    expectEndTurn(promptResponse);

    await vi.waitFor(() => {
        const sessionText = client.readText(sessionId);
        const nextText = sessionText.slice(previousText.length);
        assertText(nextText);
    }, {timeout: timeoutMs});
}

function printLogDirectory(logDirectory: string): void {
    fs.readdirSync(logDirectory, {withFileTypes: true})
        .filter((entry) => entry.isFile())
        .forEach((entry) => {
            const logFilePath = path.join(logDirectory, entry.name);
            const content = fs.readFileSync(logFilePath, "utf8").trim();
            console.log(`[APP_SERVER_LOGS] Logs from ${logFilePath}:`);
            console.log(content.length > 0 ? content : "[APP_SERVER_LOGS] Log file is empty");
            console.log("------");
        });
}

async function waitForProcessExit(proc: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
    if (proc.exitCode !== null || proc.signalCode !== null) {
        return true;
    }

    return await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
            cleanup();
            resolve(false);
        }, timeoutMs);

        const cleanup = () => {
            clearTimeout(timeout);
            proc.off("exit", handleExit);
        };

        const handleExit = () => {
            cleanup();
            resolve(true);
        };

        proc.once("exit", handleExit);
    });
}

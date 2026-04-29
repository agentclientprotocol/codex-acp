import * as acp from "@agentclientprotocol/sdk";
import {type ChildProcessWithoutNullStreams, spawn} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {Readable, Writable} from "node:stream";
import {expect, vi} from "vitest";
import {ModelId} from "../../../ModelId";
import {removeDirectoryWithRetry, writeCodexHomeConfig} from "../../acp-test-utils";
import type {PermissionResponder} from "./permission-responders";

export const DEFAULT_TEST_MODEL_ID = ModelId.create("gpt-5.2", "none");
export const OTHER_TEST_MODEL_ID = ModelId.create("gpt-5.3-codex", "low");

export interface TestSkill {
    readonly name: string;
    readonly description: string;
    readonly body: string;
}

export interface SpawnedAgentFixture {
    readonly connection: acp.ClientSideConnection;
    readonly workspaceDir: string;
    createSession(mcpServers?: acp.McpServer[]): Promise<acp.NewSessionResponse>;
    restart(): Promise<SpawnedAgentFixture>;
    writeSkill(skill: TestSkill): void;
    setPermissionResponder(responder: PermissionResponder): void;
    expectPromptText(
        sessionId: string,
        promptText: string,
        assertText: (text: string) => void,
        timeoutMs?: number,
    ): Promise<void>;
    expectStatus(sessionId: string, fields: Record<string, unknown>): Promise<void>;
    readPermissionRequests(
        sessionId: string,
        toolCallKind: acp.ToolKind,
    ): acp.RequestPermissionRequest[];
    dispose(): Promise<void>;
}

type ConnectionInitializer = (connection: acp.ClientSideConnection) => Promise<void>;

export async function createSpawnedAgentFixture(
    initializeConnection: ConnectionInitializer,
    extraEnv?: NodeJS.ProcessEnv,
    paths = RuntimePaths.createTemporary(),
): Promise<SpawnedAgentFixture> {
    const agentProcess = spawn("npm", ["run", "--silent", "start"], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            CODEX_HOME: paths.codexHome,
            APP_SERVER_LOGS: paths.appServerLogsDir,
            ...extraEnv,
        },
        stdio: ["pipe", "pipe", "pipe"],
    });

    const fixture = new SpawnedAgentFixtureImpl(
        new RecordingClient(),
        agentProcess,
        paths,
        initializeConnection,
        extraEnv,
    );
    await initializeConnection(fixture.connection);
    return fixture;
}

class RuntimePaths {
    readonly codexHome: string;
    readonly workspaceDir: string;
    readonly appServerLogsDir: string;

    constructor(readonly rootDir: string) {
        this.codexHome = path.join(rootDir, "codex-home");
        this.workspaceDir = path.join(rootDir, "workspace");
        this.appServerLogsDir = path.join(rootDir, "logs");
    }

    static createTemporary(): RuntimePaths {
        const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-acp-integration-"));
        const paths = new RuntimePaths(rootDir);
        for (const dir of [paths.codexHome, paths.workspaceDir, paths.appServerLogsDir]) {
            fs.mkdirSync(dir, {recursive: true});
        }
        writeCodexHomeConfig(paths.codexHome, {
            model: DEFAULT_TEST_MODEL_ID.model,
            model_reasoning_effort: DEFAULT_TEST_MODEL_ID.effort,
            web_search: "disabled",
        });
        return paths;
    }
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

class SpawnedAgentFixtureImpl implements SpawnedAgentFixture {
    readonly connection: acp.ClientSideConnection;
    private disposed = false;

    constructor(
        private readonly client: RecordingClient,
        private readonly agentProcess: ChildProcessWithoutNullStreams,
        private readonly paths: RuntimePaths,
        private readonly initializeConnection: ConnectionInitializer,
        private readonly extraEnv?: NodeJS.ProcessEnv,
    ) {
        const output = Readable.toWeb(agentProcess.stdout) as ReadableStream<Uint8Array>;
        this.connection = new acp.ClientSideConnection(
            () => client,
            acp.ndJsonStream(Writable.toWeb(agentProcess.stdin), output)
        );
    }

    get workspaceDir(): string {
        return this.paths.workspaceDir;
    }

    async createSession(mcpServers: acp.McpServer[] = []): Promise<acp.NewSessionResponse> {
        return await this.connection.newSession({
            cwd: this.workspaceDir,
            mcpServers,
        });
    }

    async restart(): Promise<SpawnedAgentFixture> {
        await this.stopProcess(false);
        return await createSpawnedAgentFixture(this.initializeConnection, this.extraEnv, this.paths);
    }

    writeSkill(skill: TestSkill): void {
        const skillDirectory = path.join(this.paths.codexHome, "skills", skill.name);
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

    setPermissionResponder(responder: PermissionResponder): void {
        this.client.setPermissionResponder(responder);
    }

    async expectPromptText(
        sessionId: string,
        promptText: string,
        assertText: (text: string) => void,
        timeoutMs = 30_000,
    ): Promise<void> {
        const previousText = this.client.readText(sessionId);
        const promptResponse = await this.connection.prompt({
            sessionId,
            prompt: [{type: "text", text: promptText}],
        });
        expect(promptResponse.stopReason).toBe("end_turn");

        await vi.waitFor(() => {
            const sessionText = this.client.readText(sessionId);
            assertText(sessionText.slice(previousText.length));
        }, {timeout: timeoutMs});
    }

    async expectStatus(sessionId: string, fields: Record<string, unknown>): Promise<void> {
        await this.expectPromptText(sessionId, "/status", (text) => {
            for (const [field, value] of Object.entries(fields)) {
                expect(text).toContain(`**${field}:** ${String(value)}`);
            }
        });
    }

    readPermissionRequests(
        sessionId: string,
        toolCallKind: acp.ToolKind,
    ): acp.RequestPermissionRequest[] {
        return this.client.readPermissionRequests(sessionId, toolCallKind);
    }

    async dispose(): Promise<void> {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        await this.stopProcess(true);
        removeDirectoryWithRetry(this.paths.rootDir);
    }

    private async stopProcess(printLogs: boolean): Promise<void> {
        if (!this.agentProcess.stdin.destroyed && !this.agentProcess.stdin.writableEnded) {
            this.agentProcess.stdin.end();
        }

        const exitedAfterStdinClose = await waitForProcessExit(this.agentProcess, 4_000);
        if (!exitedAfterStdinClose && !this.agentProcess.killed) {
            this.agentProcess.kill();
            await waitForProcessExit(this.agentProcess, 4_000);
        }

        if (printLogs) {
            printLogDirectory(this.paths.appServerLogsDir);
        }
    }
}

function printLogDirectory(logDirectory: string): void {
    if (!fs.existsSync(logDirectory)) {
        return;
    }
    fs.readdirSync(logDirectory, {withFileTypes: true})
        .filter((entry) => entry.isFile())
        .forEach((entry) => {
            const logFilePath = path.join(logDirectory, entry.name);
            const content = redactLogSecrets(fs.readFileSync(logFilePath, "utf8").trim());
            console.log(`[APP_SERVER_LOGS] Logs from ${logFilePath}:`);
            console.log(content.length > 0 ? content : "[APP_SERVER_LOGS] Log file is empty");
            console.log("------");
        });
}

function redactLogSecrets(content: string): string {
    return content
        .replace(/("apiKey"\s*:\s*")[^"]+(")/g, "$1[REDACTED]$2")
        .replace(/("Authorization"\s*:\s*")Bearer [^"]+(")/gi, "$1Bearer [REDACTED]$2")
        .replace(/(Incorrect API key provided: )[^.,\s]+/g, "$1[REDACTED]");
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

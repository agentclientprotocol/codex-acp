import * as acp from "@agentclientprotocol/sdk";
import {vi} from "vitest";
import {CodexAcpServer, type CodexProcessState} from "../../CodexAcpServer";
import {CodexAcpClient} from "../../CodexAcpClient";
import {CodexAppServerClient} from "../../CodexAppServerClient";
import {CodexAppServerSupervisor} from "../../app-server-recovery/CodexAppServerSupervisor";
import type {AcpClientConnection} from "../../ACPSessionConnection";
import {type FakeAppServer, fakeAppServer} from "./fake-app-server";

export const MODEL = {
    id: "gpt-test",
    model: "gpt-test",
    displayName: "GPT Test",
    description: "test model",
    hidden: false,
    isDefault: true,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [
        {reasoningEffort: "low", description: "low"},
        {reasoningEffort: "medium", description: "medium"},
        {reasoningEffort: "high", description: "high"},
    ],
    inputModalities: ["text", "image"],
    supportsPersonality: false,
    upgrade: null,
    additionalSpeedTiers: [],
};

function thread(id: string) {
    return {
        id, preview: "", ephemeral: false, modelProvider: "openai", createdAt: 0, updatedAt: 0, status: {type: "idle"},
        path: null, cwd: "/work", cliVersion: "0", source: "appServer", agentNickname: null, agentRole: null,
        gitInfo: null, name: null, turns: [], historyMode: "paginated",
    };
}

/** Answers of a healthy app-server; tests override single methods with `answers`. */
export function defaultAnswer(method: string, params: unknown): unknown {
    const p = (params ?? {}) as {threadId?: string, ephemeral?: boolean};
    switch (method) {
        case "initialize": return {userAgent: "codex-test", codexHome: "/codex-home"};
        case "model/list": return {data: [MODEL], nextCursor: null};
        case "account/read": return {account: null, requiresOpenaiAuth: false};
        case "config/read": return {config: {}, origins: {}, layers: null};
        case "skills/list": return {data: []};
        case "thread/start": return {thread: thread(p.ephemeral ? "title-thread" : "thread-new"), model: "gpt-test", modelProvider: "openai", reasoningEffort: "medium", serviceTier: null, cwd: "/work"};
        case "thread/resume": return {thread: thread(p.threadId ?? "t"), model: "gpt-test", modelProvider: "openai", reasoningEffort: "medium", serviceTier: null, itemsBackwardsCursor: null, cwd: "/work"};
        case "turn/start": return {turn: {id: `turn-${Math.random().toString(36).slice(2, 8)}`, items: [], status: "inProgress", error: null}};
        case "thread/list": return {data: [], nextCursor: null};
        case "thread/goal/get": return {goal: null};
        case "thread/backgroundTerminals/list": return {data: [], nextCursor: null};
        default: return {};
    }
}

export interface RecoveryFixture {
    agent: CodexAcpServer;
    supervisor: CodexAppServerSupervisor;
    /** Every app-server, the initial one first. */
    servers: FakeAppServer[];
    current(): FakeAppServer;
    acp: {notify: ReturnType<typeof vi.fn>, request: ReturnType<typeof vi.fn>};
    updates(): Array<{sessionId: string, update: Record<string, unknown>}>;
    /** Per-method answers of every app-server (also of later ones); return undefined to leave a request pending. */
    answers: Map<string, (params: unknown, server: FakeAppServer) => unknown>;
    /** Kills the current app-server like the OOM killer and waits until the adapter saw it. */
    kill(signal?: NodeJS.Signals): Promise<void>;
}

export function createRecoveryFixture(options: {air?: boolean, env?: Record<string, string>} = {}): RecoveryFixture {
    const answers = new Map<string, (params: unknown, server: FakeAppServer) => unknown>();
    const servers: FakeAppServer[] = [];
    const makeServer = () => {
        const server = fakeAppServer();
        server.rpc.answer = (method, params) => {
            const custom = answers.get(method);
            return custom ? custom(params, server) : defaultAnswer(method, params);
        };
        servers.push(server);
        return server;
    };
    const initial = makeServer();
    const state: CodexProcessState = {
        connection: initial.connection,
        codexPath: undefined,
        config: undefined,
        appServerStartupArgs: ["app-server"],
        modelProvider: undefined,
        stderr: "",
    };
    state.supervisor = new CodexAppServerSupervisor(
        state,
        () => makeServer().connection,
        {closeGraceMs: 5, drainMs: 1, terminateAfterMs: 5, abandonAfterMs: 5, wedgedAfterMs: 50},
    );
    const acpConnection = {
        notify: vi.fn(async () => {}),
        request: vi.fn(async (method: string) => {
            if (method === acp.methods.client.session.requestPermission) return {outcome: {outcome: "cancelled"}};
            return {};
        }),
    };
    const previousEnv: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(options.env ?? {})) {
        previousEnv[key] = process.env[key];
        process.env[key] = value;
    }
    const agent = new CodexAcpServer(
        acpConnection as unknown as AcpClientConnection,
        new CodexAcpClient(new CodexAppServerClient(initial.rpc.connection)),
        undefined,
        undefined,
        undefined,
        state,
    );
    for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    void options.air;
    return {
        agent,
        supervisor: state.supervisor,
        servers,
        current: () => servers.at(-1)!,
        acp: acpConnection,
        updates: () => acpConnection.notify.mock.calls
            .filter(call => (call as unknown[])[0] === acp.methods.client.session.update)
            .map(call => (call as unknown[])[1] as {sessionId: string, update: Record<string, unknown>}),
        answers,
        async kill(signal: NodeJS.Signals = "SIGKILL") {
            const server = servers.at(-1)!;
            server.child.die(null, signal);
            await vi.waitFor(() => {
                if (!server.rpc.disposed) throw new Error("not disposed yet");
            });
        },
    };
}

export const AIR_CAPABILITIES = {_meta: {jetbrains: {air: {version: 1, capabilities: ["sessionFailure"]}}}};

export async function initialize(fixture: RecoveryFixture, air = false, capabilities: Record<string, unknown> = {}): Promise<void> {
    await fixture.agent.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientInfo: {name: "test-client", version: "1.0"},
        clientCapabilities: (air ? {...AIR_CAPABILITIES, ...capabilities} : capabilities) as never,
    });
}

export function requestsOf(server: FakeAppServer, method: string): unknown[] {
    return server.rpc.requests.filter(request => request.method === method).map(request => request.params);
}

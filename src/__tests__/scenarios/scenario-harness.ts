import type * as acp from "@agentclientprotocol/sdk";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {vi} from "vitest";
import {createCodexMockTestFixture, createTestModel, type MethodCallEvent} from "../acp-test-utils";
import {SESSION_ID, TURN_ID, type Scenario} from "./scenarios";

/**
 * Drives the adapter with the scripted app-server traffic of one scenario and records the outbound ACP messages.
 *
 * The harness uses only the public ACP methods of the adapter and the mocked app-server client,
 * so it runs against any adapter version that has the same test fixture.
 */

/** The scenarios name the workspace directory with this path. */
const WS = "/workspace";

export type ProfileName = "plain" | "zed" | "air";

export const AIR_CAPABILITY_NAMES = [
    "diffPatch",
    "sessionFailure",
    "agentFileChangeReport",
    "nativeSubagentSessions",
    "asyncTasks",
    "recommendedValue",
    "rawInputRendering",
    "planContentDelta",
];

/** The client capabilities of each client profile. */
export const PROFILES: Record<ProfileName, acp.ClientCapabilities> = {
    /** A plain ACP client: no `_meta` capabilities and no terminal support. */
    plain: {},
    /** Zed declares its terminal conventions in `_meta`. */
    zed: {
        fs: {readTextFile: true, writeTextFile: true},
        terminal: true,
        _meta: {"terminal_output": true, "terminal-auth": true},
    },
    air: {
        fs: {readTextFile: true, writeTextFile: true},
        plan: {},
        elicitation: {form: {}, url: {}},
        _meta: {
            terminal_output_delta: true,
            jetbrains: {air: {version: 1, capabilities: AIR_CAPABILITY_NAMES}},
        },
    } as acp.ClientCapabilities,
};

/** One outbound ACP message, or the response the adapter returns to the app-server or to the client. */
export type RecordedMessage = {direction: string; method: string; params: unknown};

type TurnCompletion = {threadId: string; turn: Record<string, unknown>};

function turn(id: string, status: string): Record<string, unknown> {
    return {
        id, items: [], itemsView: "notLoaded", status, error: null, startedAt: null, completedAt: null, durationMs: null,
    };
}

function thread(items: Record<string, unknown>[], cwd: string): Record<string, unknown> {
    return {
        id: SESSION_ID, sessionId: SESSION_ID, parentThreadId: null, threadSource: null, originator: null,
        forkedFromId: null, preview: "history", ephemeral: false, modelProvider: "openai", model: null,
        reasoningEffort: null, createdAt: 1, updatedAt: 2, recencyAt: null, status: {type: "idle"}, path: null,
        cwd, cliVersion: "0.0.0", section: null, sectionEnteredAt: null, projectId: null,
        historyMode: "legacy", source: "cli", agentNickname: null, agentRole: null, gitInfo: null, name: null,
        turns: [{...turn("history-turn", "completed"), itemsView: "full", items}],
    };
}

/** The files that exist after the file changes of the scenarios. */
const WORKSPACE_FILES: Record<string, string> = {
    "src/app.ts": "const a = 2;\nexport {a};\n",
    "after.ts": "export const name = \"after\";\n",
};

/**
 * Runs one scenario in a temporary workspace. `/workspace` in the scenario stands for that directory,
 * and the recorded messages name it `/workspace` again.
 */
export async function runScenario(
    scenario: Scenario,
    profile: ProfileName | acp.ClientCapabilities,
): Promise<RecordedMessage[]> {
    const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-acp-scenario-")));
    try {
        for (const [file, text] of Object.entries(WORKSPACE_FILES)) {
            fs.mkdirSync(path.dirname(path.join(workspace, file)), {recursive: true});
            fs.writeFileSync(path.join(workspace, file), text);
        }
        const messages = await runInWorkspace(replaceText(scenario, WS, workspace), profile, workspace);
        // A Git patch names the paths without the leading slash.
        return replaceText(replaceText(messages, workspace, WS), workspace.slice(1), WS.slice(1));
    } finally {
        fs.rmSync(workspace, {recursive: true, force: true});
    }
}

function replaceText<T>(value: T, from: string, to: string): T {
    return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "string" ? item.split(from).join(to) : item));
}

async function runInWorkspace(
    scenario: Scenario,
    profile: ProfileName | acp.ClientCapabilities,
    workspace: string,
): Promise<RecordedMessage[]> {
    const fixture = createCodexMockTestFixture();
    const agent = fixture.getCodexAcpAgent();
    const client = fixture.getCodexAcpClient();
    const appServer = fixture.getCodexAppServerClient();
    const recorded: RecordedMessage[] = [];
    const model = createTestModel();

    const anyClient = client as any;
    const anyAppServer = appServer as any;
    anyClient.authRequired = vi.fn().mockResolvedValue(false);
    anyClient.getAccount = vi.fn().mockResolvedValue({account: null, requiresOpenaiAuth: false});
    anyClient.listSkills = vi.fn().mockResolvedValue({data: []});
    anyClient.newSession = vi.fn().mockResolvedValue({
        sessionId: SESSION_ID,
        currentModelId: `${model.id}[medium]`,
        models: [model],
        collaborationMode: scenario.planMode ? "plan" : "default",
        currentServiceTier: null,
        additionalDirectories: [],
    });
    anyClient.awaitMcpServerStartup = vi.fn().mockResolvedValue({
        ready: [],
        failed: (scenario.mcpStartup?.failed ?? []).map(failure => ({...failure, failureReason: null})),
        cancelled: scenario.mcpStartup?.cancelled ?? [],
    });
    anyAppServer.listModels = vi.fn().mockResolvedValue({data: [model], nextCursor: null});
    anyAppServer.threadBackgroundTerminalsList = vi.fn().mockResolvedValue({data: [], nextCursor: null});
    anyAppServer.threadResume = vi.fn().mockResolvedValue({
        thread: thread(scenario.history ?? [], workspace), model: model.id, modelProvider: "openai", cwd: workspace,
        approvalPolicy: "never", sandbox: {type: "dangerFullAccess"}, reasoningEffort: model.defaultReasoningEffort,
    });
    anyAppServer.threadReadWithHistory = vi.fn().mockResolvedValue({thread: thread(scenario.history ?? [], workspace)});

    const initializeResponse = await agent.initialize({protocolVersion: 1, clientCapabilities: typeof profile === "string" ? PROFILES[profile] : profile});
    recorded.push({direction: "response", method: "initialize", params: initializeResponse});

    const mcpServers: acp.McpServer[] = [
        ...(scenario.mcpStartup?.failed ?? []).map(failure => failure.server),
        ...(scenario.mcpStartup?.cancelled ?? []),
    ].map(name => ({name, command: "npx", args: [name], env: []}));

    if (scenario.history !== undefined) {
        const response = await agent.loadSession({sessionId: SESSION_ID, cwd: workspace, mcpServers});
        recorded.push({direction: "response", method: "session/load", params: response});
        await client.waitForSessionNotifications(SESSION_ID);
        return [...recorded, ...collect(fixture.getAcpConnectionEvents([]))];
    }

    const newSessionResponse = await agent.newSession({cwd: workspace, mcpServers});
    recorded.push({direction: "response", method: "session/new", params: newSessionResponse});
    if (scenario.mcpStartup !== undefined) {
        await vi.waitFor(() => {
            const events = fixture.getAcpConnectionEvents([]);
            const count = events.filter(event => JSON.stringify(event).includes("mcp_startup")).length;
            if (count < scenario.mcpStartup!.failed.length + scenario.mcpStartup!.cancelled.length) {
                throw new Error("MCP startup reports are pending");
            }
        });
        return [...recorded, ...collect(fixture.getAcpConnectionEvents([]))];
    }
    fixture.clearAcpConnectionDump();

    let resolveFirstTurn!: (value: TurnCompletion) => void;
    const firstTurn = new Promise<TurnCompletion>(resolve => {
        resolveFirstTurn = resolve;
    });
    let turnCount = 0;
    anyAppServer.turnStart = vi.fn().mockImplementation(() => {
        turnCount += 1;
        return Promise.resolve({turn: turn(turnCount === 1 ? TURN_ID : `turn-${turnCount}`, "inProgress")});
    });
    anyAppServer.awaitTurnCompleted = vi.fn().mockImplementation((_threadId: string, turnId: string) =>
        turnId === TURN_ID
            ? firstTurn
            : Promise.resolve({threadId: SESSION_ID, turn: turn(turnId, "completed")}));
    fixture.setPermissionResponse(scenario.planReviewOptionId === undefined
        ? {outcome: {outcome: "cancelled"}}
        : {outcome: {outcome: "selected", optionId: scenario.planReviewOptionId}});

    const promptPromise = agent.prompt({sessionId: SESSION_ID, prompt: [{type: "text", text: "Go"}]});
    await vi.waitFor(() => {
        if (turnCount === 0) throw new Error("The turn did not start");
    });

    for (const step of scenario.steps ?? []) {
        if ("waitMs" in step) {
            await new Promise(resolve => setTimeout(resolve, step.waitMs));
            continue;
        }
        if ("notify" in step) {
            fixture.sendServerNotification(step.notify);
            await client.waitForSessionNotifications(SESSION_ID);
            continue;
        }
        fixture.setPermissionResponse(step.permissionOptionId === undefined
            ? {outcome: {outcome: "cancelled"}}
            : {outcome: {outcome: "selected", optionId: step.permissionOptionId}});
        if (step.elicitation !== undefined) {
            fixture.setElicitationResponse(step.elicitation as acp.CreateElicitationResponse);
        }
        const response = await fixture.sendServerRequest(step.request.method, step.request.params);
        recorded.push(...collect(fixture.getAcpConnectionEvents([])));
        fixture.clearAcpConnectionDump();
        recorded.push({direction: "codexResponse", method: step.request.method, params: response});
    }
    await client.waitForSessionNotifications(SESSION_ID);
    if (scenario.planReviewOptionId !== undefined) {
        fixture.setPermissionResponse({outcome: {outcome: "selected", optionId: scenario.planReviewOptionId}});
    }
    resolveFirstTurn({threadId: SESSION_ID, turn: turn(TURN_ID, "completed")});
    const promptResponse = await promptPromise;
    await client.waitForSessionNotifications(SESSION_ID);
    recorded.push(...collect(fixture.getAcpConnectionEvents([])));
    recorded.push({direction: "response", method: "session/prompt", params: promptResponse});
    return recorded;
}

const IGNORED_NOTIFICATIONS = new Set(["_auth/status_update"]);

function collect(events: MethodCallEvent[]): RecordedMessage[] {
    return events.flatMap((event): RecordedMessage[] => {
        switch (event.method) {
            case "sessionUpdate":
                return [{direction: "notify", method: "session/update", params: event.args[0]}];
            case "requestPermission":
                return [{direction: "request", method: "session/request_permission", params: event.args[0]}];
            case "createElicitation":
                return [{direction: "request", method: "elicitation/create", params: event.args[0]}];
            case "completeElicitation":
                return [{direction: "notify", method: "elicitation/complete", params: event.args[0]}];
            case "notify":
            case "request":
                if (IGNORED_NOTIFICATIONS.has(event.args[0])) return [];
                return [{direction: event.method, method: String(event.args[0]), params: event.args[1]}];
            default:
                return [{direction: "call", method: event.method, params: event.args}];
        }
    });
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** Replaces random ids and wall-clock times with stable placeholders. */
export function normalize(messages: RecordedMessage[]): RecordedMessage[] {
    return JSON.parse(JSON.stringify(messages, (key, value) => {
        if (key === "version" && typeof value === "string") return "<version>";
        if (typeof value === "string") return value.replace(UUID, "<uuid>");
        if (typeof value === "number" && /(At|AtMs|Time|timestamp)$/.test(key) && value > 1_000_000_000) {
            return "<time>";
        }
        return value;
    }));
}

/** The value with the keys of each object in sorted order. */
export function canonical(value: unknown): unknown {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(canonical);
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]));
}

/** One message per line, with the keys in sorted order. */
export function toJsonLines(messages: RecordedMessage[]): string {
    return messages.map(message => `${JSON.stringify(canonical(message))}\n`).join("");
}

export function fromJsonLines(text: string): RecordedMessage[] {
    return text.split("\n").filter(line => line !== "").map(line => JSON.parse(line) as RecordedMessage);
}

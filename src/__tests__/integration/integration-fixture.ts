import * as acp from "@agentclientprotocol/sdk";
import {describe, expect} from "vitest";
import {AgentMode} from "../../AgentMode";
import {ModelId} from "../../ModelId";
import {legacySetSessionModel} from "../../AcpExtensions";
import type {ApprovalOptionId} from "../../permissions/option-ids";
import {createPermissionResponder} from "../CodexACPAgent/e2e/permission-responders";
import {createSpawnedAgentFixture, type SpawnedAgentFixture} from "../CodexACPAgent/e2e/spawned-agent-fixture";
import type {MockResponsesServer} from "./mock-responses-server";

// gpt-5.5 exposes exec_command/apply_patch directly; newer bundled models wrap tools in code-mode `exec`.
export const INTEGRATION_MODEL_ID = ModelId.create("gpt-5.5", "low");

const DEFAULT_INTEGRATION_TIMEOUT_MS = 30_000;

export function describeIntegration(name: string, factory: () => void, timeoutMs = DEFAULT_INTEGRATION_TIMEOUT_MS): void {
    describe(name, {timeout: timeoutMs}, factory);
}

export type ToolCallUpdate = Extract<acp.SessionUpdate, {sessionUpdate: "tool_call" | "tool_call_update"}>;

// ---- Setup stages ----

/**
 * Spawns codex-acp (`src/index.ts`) as a child process; it starts the real `codex app-server` itself.
 * Read-only mode by default, so shell commands and edits ask for permission.
 */
export async function spawnAgent(mode: AgentMode = AgentMode.ReadOnly): Promise<SpawnedAgentFixture> {
    return await createSpawnedAgentFixture(async () => {}, {INITIAL_AGENT_MODE: mode.id});
}

/** ACP `initialize` + `authenticate` over the agent's stdin/stdout; `gateway` points Codex's model calls at the mock. */
export async function connectAndLogin(agent: SpawnedAgentFixture, mockBaseUrl: string): Promise<void> {
    await agent.connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
            fs: {readTextFile: true, writeTextFile: true},
            terminal: true,
            auth: {_meta: {gateway: true}},
        },
        clientInfo: {name: "vitest", version: "1.0.0"},
    });
    await agent.connection.authenticate({
        methodId: "gateway",
        _meta: {gateway: {baseUrl: mockBaseUrl, headers: {}}},
    });
}

/** ACP `session/new` in a temp workspace, switched to the integration model. */
export async function openSession(agent: SpawnedAgentFixture): Promise<string> {
    const {sessionId} = await agent.createSession();
    await legacySetSessionModel(agent.connection, {sessionId, modelId: INTEGRATION_MODEL_ID.toString()});
    return sessionId;
}

/** Stops codex-acp + Codex, removes the temp dirs, and closes the mock. */
export async function stopAll(agent: SpawnedAgentFixture | undefined, mock: MockResponsesServer | undefined): Promise<void> {
    try {
        await agent?.dispose();
    } finally {
        await mock?.close();
    }
}

// ---- Test steps ----

/** Sets the test user's answer to permission requests of this kind. */
export function answerPermissions(agent: SpawnedAgentFixture, kind: acp.ToolKind, optionId: ApprovalOptionId): void {
    agent.setPermissionResponder(createPermissionResponder(kind, optionId));
}

/** ACP `session/prompt`; resolves when the turn ends. */
export async function sendPrompt(agent: SpawnedAgentFixture, sessionId: string, text: string): Promise<acp.PromptResponse> {
    return await agent.connection.prompt({sessionId, prompt: [{type: "text", text}]});
}

// ---- What the client received ----

/** All agent text the client received, joined. */
export function agentText(agent: SpawnedAgentFixture, sessionId: string): string {
    return agent.readSessionUpdates(sessionId)
        .flatMap((u) => u.sessionUpdate === "agent_message_chunk" && u.content.type === "text" ? [u.content.text] : [])
        .join("");
}

/** `tool_call` and `tool_call_update` notifications the client received. */
export function toolCallUpdates(agent: SpawnedAgentFixture, sessionId: string): ToolCallUpdate[] {
    return agent.readSessionUpdates(sessionId)
        .filter((u): u is ToolCallUpdate => u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update");
}

// ---- What Codex sent to the model ----

/** Input items of the n-th model request (0-based). */
export function modelRequestInput(mock: MockResponsesServer, n: number): any[] {
    return (mock.requests[n] as {input: any[]}).input;
}

/** Fails if Codex made a model request the test did not script a reply for. */
export function expectNoUnscriptedModelRequests(mock: MockResponsesServer): void {
    expect(mock.unexpectedRequests).toBe(0);
}

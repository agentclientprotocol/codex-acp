import {afterEach, describe, expect, it, vi} from "vitest";
import * as acp from "@agentclientprotocol/sdk";
import {createCodexMockTestFixture, createTestModel} from "../acp-test-utils";
import {AgentMode, MODE_CONFIG_ID} from "../../AgentMode";
import {
    MODEL_CONFIG_ID,
    REASONING_EFFORT_CONFIG_ID,
} from "../../ModelConfigOption";
import type {Model, ReasoningEffortOption, Turn} from "../../app-server/v2";
import {LEGACY_SET_SESSION_MODEL_METHOD} from "../../AcpExtensions";
import {
    COLLABORATION_MODE_CONFIG_ID,
    PLAN_COLLABORATION_MODE,
} from "../../CollaborationModeConfig";

const lowEffort: ReasoningEffortOption = {reasoningEffort: "low", description: "Fast"};
const mediumEffort: ReasoningEffortOption = {reasoningEffort: "medium", description: "Balanced"};
const highEffort: ReasoningEffortOption = {reasoningEffort: "high", description: "Thorough"};

function buildModels(): {fast: Model; slow: Model} {
    const fast = createTestModel({
        id: "fast-model",
        displayName: "Fast model",
        description: "Frontier",
        supportedReasoningEfforts: [lowEffort, mediumEffort, highEffort],
        defaultReasoningEffort: "medium",
        additionalSpeedTiers: ["fast"],
    });
    const slow = createTestModel({
        id: "slow-model",
        displayName: "Slow model",
        description: "Strong",
        supportedReasoningEfforts: [lowEffort, mediumEffort],
        defaultReasoningEffort: "low",
        isDefault: false,
    });
    return {fast, slow};
}

async function createSession(
    currentModelId: string,
    availableModels: Array<Model>,
    clientCapabilities?: acp.ClientCapabilities,
    additionalDirectories: string[] = [],
) {
    const fixture = createCodexMockTestFixture();
    const codexAcpAgent = fixture.getCodexAcpAgent();
    const codexAcpClient = fixture.getCodexAcpClient();

    vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);
    vi.spyOn(codexAcpClient, "getAccount").mockResolvedValue({account: null, requiresOpenaiAuth: false});
    vi.spyOn(codexAcpClient, "newSession").mockResolvedValue({
        sessionId: "session-id",
        currentModelId,
        models: availableModels,
        collaborationMode: "default",
        additionalDirectories,
    });

    if (clientCapabilities) {
        await codexAcpAgent.initialize({protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities});
    }

    const response = await codexAcpAgent.newSession({
        cwd: "/test/cwd",
        mcpServers: [],
        _meta: {additionalRoots: additionalDirectories},
    });
    return {fixture, codexAcpAgent, codexAcpClient, response};
}

describe("Session config options", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("exposes mode, model, reasoning_effort and fast-mode in the new session response", async () => {
        const {fast, slow} = buildModels();
        const {response} = await createSession("fast-model[medium]", [fast, slow]);

        const ids = response.configOptions?.map(o => o.id);
        expect(ids).toEqual([MODE_CONFIG_ID, COLLABORATION_MODE_CONFIG_ID, MODEL_CONFIG_ID, REASONING_EFFORT_CONFIG_ID, "fast-mode"]);

        const modelOption = response.configOptions?.find(o => o.id === MODEL_CONFIG_ID);
        expect(modelOption).toMatchObject({
            category: "model",
            currentValue: "fast-model",
            type: "select",
            options: [
                {value: "fast-model", name: "Fast model", description: "Frontier"},
                {value: "slow-model", name: "Slow model", description: "Strong"},
            ],
        });
        expect(modelOption?._meta).toBeUndefined();

        const effortOption = response.configOptions?.find(o => o.id === REASONING_EFFORT_CONFIG_ID);
        expect(effortOption).toMatchObject({
            category: "thought_level",
            currentValue: "medium",
            type: "select",
            options: [
                {value: "low", name: "Low"},
                {value: "medium", name: "Medium"},
                {value: "high", name: "High"},
            ],
        });
        expect(effortOption?._meta).toBeUndefined();

        const modeOption = response.configOptions?.find(o => o.id === MODE_CONFIG_ID);
        expect(modeOption).toMatchObject({
            category: "mode",
            currentValue: AgentMode.DEFAULT_AGENT_MODE.id,
            type: "select",
            options: [
                {
                    value: "read-only",
                    name: "Read-only",
                    description: "Requires approval to edit files and access the internet.",
                },
                {
                    value: "workspace-write",
                    name: "Workspace access",
                    description: "Edit workspace files; ask before writing outside the workspace or accessing the network.",
                },
                {
                    value: "agent",
                    name: "Auto review",
                    description: "Only ask for actions detected as potentially unsafe",
                },
                {
                    value: "agent-full-access",
                    name: "Full access",
                    description: "Unrestricted access to the internet and any file on your computer",
                },
            ],
        });
        expect((modeOption as any).options.map((o: any) => o.value)).toEqual(
            AgentMode.all().map(m => m.id)
        );
        expect(response.modes?.availableModes.map(mode => mode.id)).toEqual([
            "read-only", "workspace-write", "agent", "agent-full-access",
        ]);
    });

    it("shows the current uncataloged model as its own selectable option", async () => {
        const {fast, slow} = buildModels();
        const {codexAcpAgent, response} = await createSession("custom-model[high]", [fast, slow]);

        const ids = response.configOptions?.map(o => o.id);
        expect(ids).toEqual([MODE_CONFIG_ID, COLLABORATION_MODE_CONFIG_ID, MODEL_CONFIG_ID]);

        const modelOption = response.configOptions?.find(o => o.id === MODEL_CONFIG_ID);
        expect(modelOption).toMatchObject({
            category: "model",
            currentValue: "custom-model",
            type: "select",
            options: [
                {value: "custom-model", name: "custom-model", description: null},
                {value: "fast-model", name: "Fast model", description: "Frontier"},
                {value: "slow-model", name: "Slow model", description: "Strong"},
            ],
        });
        expect(response.configOptions?.some(o => o.id === REASONING_EFFORT_CONFIG_ID)).toBe(false);

        await codexAcpAgent.setSessionConfigOption({
            sessionId: "session-id",
            configId: MODEL_CONFIG_ID,
            value: "custom-model",
        });

        expect(codexAcpAgent.getSessionState("session-id").currentModelId).toBe("custom-model[high]");
    });

    it("advertises the default model and its effort as recommended values after negotiation", async () => {
        const {fast, slow} = buildModels();
        const {response} = await createSession("slow-model[medium]", [fast, slow], {
            _meta: {jetbrains: {air: {version: 1, capabilities: ["recommendedValue"]}}},
        });

        expect(response.configOptions?.find(option => option.id === MODEL_CONFIG_ID)).toMatchObject({
            currentValue: "slow-model",
            _meta: {jetbrains: {air: {version: 1, recommendedValue: "fast-model"}}},
        });
        expect(response.configOptions?.find(option => option.id === REASONING_EFFORT_CONFIG_ID)).toMatchObject({
            currentValue: "medium",
            _meta: {jetbrains: {air: {version: 1, recommendedValue: "low"}}},
        });
    });

    it("updates the recommended effort when the selected model changes", async () => {
        const {fast, slow} = buildModels();
        const {codexAcpAgent} = await createSession("fast-model[medium]", [fast, slow], {
            _meta: {jetbrains: {air: {version: 1, capabilities: ["recommendedValue"]}}},
        });

        const response = await codexAcpAgent.setSessionConfigOption({
            sessionId: "session-id",
            configId: MODEL_CONFIG_ID,
            value: "slow-model",
        });

        expect(response.configOptions?.find(option => option.id === MODEL_CONFIG_ID)).toMatchObject({
            currentValue: "slow-model",
            _meta: {jetbrains: {air: {recommendedValue: "fast-model"}}},
        });
        expect(response.configOptions?.find(option => option.id === REASONING_EFFORT_CONFIG_ID)).toMatchObject({
            currentValue: "medium",
            _meta: {jetbrains: {air: {recommendedValue: "low"}}},
        });
    });

    it("omits a model recommendation when the catalog has no default", async () => {
        const {fast, slow} = buildModels();
        fast.isDefault = false;
        const {response} = await createSession("slow-model[medium]", [fast, slow], {
            _meta: {jetbrains: {air: {version: 1, capabilities: ["recommendedValue"]}}},
        });

        expect(response.configOptions?.find(option => option.id === MODEL_CONFIG_ID)?._meta).toBeUndefined();
        expect(response.configOptions?.find(option => option.id === REASONING_EFFORT_CONFIG_ID)).toHaveProperty(
            "_meta.jetbrains.air.recommendedValue",
            "low",
        );
    });

    it("keeps the legacy models list as combined model/effort entries", async () => {
        const {fast, slow} = buildModels();
        const {response} = await createSession("fast-model[medium]", [fast, slow]);

        expect(response.models?.availableModels.map(m => m.modelId)).toEqual([
            "fast-model[low]",
            "fast-model[medium]",
            "fast-model[high]",
            "slow-model[low]",
            "slow-model[medium]",
        ]);
        expect(response.models?.currentModelId).toBe("fast-model[medium]");
    });

    it("changes the agent mode via setSessionConfigOption", async () => {
        const {fast} = buildModels();
        const {codexAcpAgent} = await createSession("fast-model[medium]", [fast]);

        const result = await codexAcpAgent.setSessionConfigOption({
            sessionId: "session-id",
            configId: MODE_CONFIG_ID,
            value: AgentMode.Agent.id,
        });

        expect(codexAcpAgent.getSessionState("session-id").agentMode).toBe(AgentMode.Agent);
        const modeOption = result.configOptions?.find(o => o.id === MODE_CONFIG_ID);
        expect((modeOption as any).currentValue).toBe(AgentMode.Agent.id);
    });

    it.each([
        {selection: "INITIAL_AGENT_MODE", initialMode: "read-only", modeId: "read-only"},
        {selection: "session/set_mode", initialMode: "agent", modeId: "read-only"},
        {selection: "session/set_mode", initialMode: "workspace-write", modeId: "read-only"},
        {selection: "session/set_mode", initialMode: "agent-full-access", modeId: "read-only"},
        {selection: "session/set_config_option", initialMode: "agent", modeId: "read-only"},
        {selection: "session/set_config_option", initialMode: "workspace-write", modeId: "read-only"},
        {selection: "session/set_config_option", initialMode: "agent-full-access", modeId: "read-only"},
        {selection: "INITIAL_AGENT_MODE", initialMode: "workspace-write", modeId: "workspace-write"},
        {selection: "session/set_mode", initialMode: "read-only", modeId: "workspace-write"},
        {selection: "session/set_config_option", initialMode: "read-only", modeId: "workspace-write"},
    ])("applies $modeId permissions after $selection from $initialMode", async ({selection, initialMode, modeId}) => {
        vi.stubEnv("INITIAL_AGENT_MODE", initialMode);
        const {fast} = buildModels();
        const {fixture, codexAcpAgent, response} = await createSession("fast-model[medium]", [fast], {
            fs: {readTextFile: false, writeTextFile: false},
            terminal: false,
        }, ["/test/extra"]);
        expect(response.modes?.currentModeId).toBe(initialMode);

        if (selection === "session/set_mode") {
            await codexAcpAgent.setSessionMode({sessionId: response.sessionId, modeId});
        } else if (selection === "session/set_config_option") {
            const result = await codexAcpAgent.setSessionConfigOption({
                sessionId: response.sessionId,
                configId: "mode",
                value: modeId,
            });
            expect(result.configOptions.find(option => option.id === "mode")?.currentValue).toBe(modeId);
        }

        const appServer = fixture.getCodexAppServerClient();
        vi.spyOn(appServer, "listSkills").mockResolvedValue({data: []});
        const turn: Turn = {
            id: "turn-id", items: [], itemsView: "notLoaded", status: "inProgress", error: null,
            startedAt: null, completedAt: null, durationMs: null,
        };
        const turnStart = vi.spyOn(appServer, "turnStart").mockResolvedValue({turn});
        vi.spyOn(appServer, "awaitTurnCompleted").mockResolvedValue({
            threadId: response.sessionId,
            turn: {...turn, status: "completed"},
        });

        await codexAcpAgent.prompt({
            sessionId: response.sessionId,
            prompt: [{type: "text", text: "Create summary.md containing PINEAPPLE."}],
        });

        // Assert the actual outgoing policy, independently of the preset object.
        // Additional session roots are writable only in the workspace-write preset.
        const policies = turnStart.mock.calls.map(([{approvalPolicy, approvalsReviewer, sandboxPolicy}]) => ({
            approvalPolicy, approvalsReviewer, sandboxPolicy,
        }));
        await expect(JSON.stringify(policies, null, 2) + "\n").toMatchFileSnapshot(`data/${modeId}-mode-policy.json`);
    });

    it("changes collaboration mode without starting a model turn", async () => {
        const {fast} = buildModels();
        const {codexAcpAgent, codexAcpClient} = await createSession("fast-model[medium]", [fast]);
        const update = vi.spyOn((codexAcpClient as any).codexClient, "threadSettingsUpdate").mockResolvedValue(undefined);

        const result = await codexAcpAgent.setSessionConfigOption({
            sessionId: "session-id",
            configId: COLLABORATION_MODE_CONFIG_ID,
            value: PLAN_COLLABORATION_MODE,
        });

        expect(update).toHaveBeenCalledWith(expect.objectContaining({
            threadId: "session-id",
            collaborationMode: expect.objectContaining({mode: "plan"}),
        }));
        expect(codexAcpAgent.getSessionState("session-id").collaborationMode).toBe("plan");
        expect(result.configOptions?.find(o => o.id === COLLABORATION_MODE_CONFIG_ID)).toMatchObject({currentValue: "plan"});
    });

    it("toggles collaboration mode with /plan without starting a model turn", async () => {
        const {fast} = buildModels();
        const {fixture, codexAcpAgent, codexAcpClient} = await createSession("fast-model[medium]", [fast]);
        const update = vi.spyOn((codexAcpClient as any).codexClient, "threadSettingsUpdate").mockResolvedValue(undefined);
        const turnStart = vi.spyOn(fixture.getCodexAppServerClient(), "turnStart");

        const enabledResponse = await codexAcpAgent.prompt({
            sessionId: "session-id",
            prompt: [{type: "text", text: "/plan"}],
        });

        expect(enabledResponse.stopReason).toBe("end_turn");
        expect(turnStart).not.toHaveBeenCalled();
        expect(update).toHaveBeenCalledWith(expect.objectContaining({
            threadId: "session-id",
            collaborationMode: expect.objectContaining({mode: "plan"}),
        }));
        expect(codexAcpAgent.getSessionState("session-id").collaborationMode).toBe("plan");

        const disabledResponse = await codexAcpAgent.prompt({
            sessionId: "session-id",
            prompt: [{type: "text", text: "/plan"}],
        });

        expect(disabledResponse.stopReason).toBe("end_turn");
        expect(turnStart).not.toHaveBeenCalled();
        expect(update).toHaveBeenLastCalledWith(expect.objectContaining({
            threadId: "session-id",
            collaborationMode: expect.objectContaining({mode: "default"}),
        }));
        expect(codexAcpAgent.getSessionState("session-id").collaborationMode).toBe("default");
        expect(fixture.getAcpConnectionEvents([])).toContainEqual(expect.objectContaining({
            method: "sessionUpdate",
            args: [expect.objectContaining({
                update: expect.objectContaining({
                    sessionUpdate: "config_option_update",
                    configOptions: expect.arrayContaining([
                        expect.objectContaining({id: COLLABORATION_MODE_CONFIG_ID, currentValue: "plan"}),
                    ]),
                }),
            })],
        }));
        expect(fixture.getAcpConnectionEvents([])).toContainEqual(expect.objectContaining({
            method: "sessionUpdate",
            args: [expect.objectContaining({
                update: expect.objectContaining({
                    sessionUpdate: "config_option_update",
                    configOptions: expect.arrayContaining([
                        expect.objectContaining({id: COLLABORATION_MODE_CONFIG_ID, currentValue: "default"}),
                    ]),
                }),
            })],
        }));
    });

    it("changes the model and keeps the current reasoning effort when supported", async () => {
        const {fast, slow} = buildModels();
        const {codexAcpAgent} = await createSession("fast-model[medium]", [fast, slow]);

        await codexAcpAgent.setSessionConfigOption({
            sessionId: "session-id",
            configId: MODEL_CONFIG_ID,
            value: "slow-model",
        });

        expect(codexAcpAgent.getSessionState("session-id").currentModelId).toBe("slow-model[medium]");
    });

    it("falls back to the new model's default effort when the current effort is unsupported", async () => {
        const {fast, slow} = buildModels();
        const {codexAcpAgent} = await createSession("fast-model[high]", [fast, slow]);

        await codexAcpAgent.setSessionConfigOption({
            sessionId: "session-id",
            configId: MODEL_CONFIG_ID,
            value: "slow-model",
        });

        expect(codexAcpAgent.getSessionState("session-id").currentModelId).toBe("slow-model[low]");
    });

    it("changes only the reasoning effort", async () => {
        const {fast} = buildModels();
        const {codexAcpAgent} = await createSession("fast-model[medium]", [fast]);

        await codexAcpAgent.setSessionConfigOption({
            sessionId: "session-id",
            configId: REASONING_EFFORT_CONFIG_ID,
            value: "high",
        });

        expect(codexAcpAgent.getSessionState("session-id").currentModelId).toBe("fast-model[high]");
    });

    it("refreshes the cached model list when unstable_setSessionModel picks a freshly fetched model", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const {fast} = buildModels();

        vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);
        vi.spyOn(codexAcpClient, "getAccount").mockResolvedValue({account: null, requiresOpenaiAuth: false});
        vi.spyOn(codexAcpClient, "newSession").mockResolvedValue({
            sessionId: "session-id",
            currentModelId: "fast-model[medium]",
            models: [fast],
            collaborationMode: "default",
            additionalDirectories: [],
        });
        await codexAcpAgent.newSession({cwd: "/test/cwd", mcpServers: []});

        const extraModel = createTestModel({
            id: "extra-model",
            displayName: "Extra model",
            description: "Added after session start",
            supportedReasoningEfforts: [mediumEffort],
            defaultReasoningEffort: "medium",
        });
        vi.spyOn(codexAcpClient, "fetchAvailableModels").mockResolvedValue([fast, extraModel]);

        await codexAcpAgent.unstable_setSessionModel({
            sessionId: "session-id",
            modelId: "extra-model[medium]",
        });

        const sessionState = codexAcpAgent.getSessionState("session-id");
        expect(sessionState.availableModels.map(m => m.id)).toEqual(["fast-model", "extra-model"]);
    });

    it("changes the model through the legacy session/set_model extMethod", async () => {
        const {fast, slow} = buildModels();
        const {codexAcpAgent, codexAcpClient} = await createSession("fast-model[medium]", [fast]);
        vi.spyOn(codexAcpClient, "fetchAvailableModels").mockResolvedValue([fast, slow]);

        const response = await codexAcpAgent.extMethod(LEGACY_SET_SESSION_MODEL_METHOD, {
            sessionId: "session-id",
            modelId: "slow-model[medium]",
        });

        expect(response).toEqual({});
        expect(codexAcpAgent.getSessionState("session-id").currentModelId).toBe("slow-model[medium]");
    });

    it("rejects unknown model, effort, and mode values", async () => {
        const {fast} = buildModels();
        const {codexAcpAgent} = await createSession("fast-model[medium]", [fast]);

        await expect(codexAcpAgent.setSessionConfigOption({
            sessionId: "session-id",
            configId: MODEL_CONFIG_ID,
            value: "unknown-model",
        })).rejects.toThrow();

        await expect(codexAcpAgent.setSessionConfigOption({
            sessionId: "session-id",
            configId: REASONING_EFFORT_CONFIG_ID,
            value: "wishful",
        })).rejects.toThrow();

        await expect(codexAcpAgent.setSessionConfigOption({
            sessionId: "session-id",
            configId: MODE_CONFIG_ID,
            value: "no-such-mode",
        })).rejects.toThrow();
    });
});

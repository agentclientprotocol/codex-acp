import {describe, expect, it, vi} from "vitest";
import {createCodexMockTestFixture, createTestModel} from "../acp-test-utils";
import {AgentMode, MODE_CONFIG_ID} from "../../AgentMode";
import {
    MODEL_CONFIG_ID,
    REASONING_EFFORT_CONFIG_ID,
} from "../../ModelConfigOption";
import type {Model, ReasoningEffortOption} from "../../app-server/v2";
import {LEGACY_SET_SESSION_MODEL_METHOD} from "../../AcpExtensions";

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
    });
    const slow = createTestModel({
        id: "slow-model",
        displayName: "Slow model",
        description: "Strong",
        supportedReasoningEfforts: [lowEffort, mediumEffort],
        defaultReasoningEffort: "low",
    });
    return {fast, slow};
}

async function createSession(currentModelId: string, availableModels: Array<Model>) {
    const fixture = createCodexMockTestFixture();
    const codexAcpAgent = fixture.getCodexAcpAgent();
    const codexAcpClient = fixture.getCodexAcpClient();

    vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);
    vi.spyOn(codexAcpClient, "getAccount").mockResolvedValue({account: null, requiresOpenaiAuth: false});
    vi.spyOn(codexAcpClient, "newSession").mockResolvedValue({
        sessionId: "session-id",
        currentModelId,
        models: availableModels,
    });

    const response = await codexAcpAgent.newSession({cwd: "/test/cwd", mcpServers: []});
    return {codexAcpAgent, codexAcpClient, response};
}

describe("Session config options", () => {
    it("exposes mode, model, reasoning_effort and fast-mode in the new session response", async () => {
        const {fast, slow} = buildModels();
        const {response} = await createSession("fast-model[medium]", [fast, slow]);

        const ids = response.configOptions?.map(o => o.id);
        expect(ids).toEqual([MODE_CONFIG_ID, MODEL_CONFIG_ID, REASONING_EFFORT_CONFIG_ID, "fast-mode"]);

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

        const effortOption = response.configOptions?.find(o => o.id === REASONING_EFFORT_CONFIG_ID);
        expect(effortOption).toMatchObject({
            category: "thought_level",
            currentValue: "medium",
            type: "select",
            options: [
                {value: "low", name: "low"},
                {value: "medium", name: "medium"},
                {value: "high", name: "high"},
            ],
        });

        const modeOption = response.configOptions?.find(o => o.id === MODE_CONFIG_ID);
        expect(modeOption).toMatchObject({
            category: "mode",
            currentValue: AgentMode.DEFAULT_AGENT_MODE.id,
            type: "select",
        });
        expect((modeOption as any).options.map((o: any) => o.value)).toEqual(
            AgentMode.all().map(m => m.id)
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
            value: AgentMode.ReadOnly.id,
        });

        expect(codexAcpAgent.getSessionState("session-id").agentMode).toBe(AgentMode.ReadOnly);
        const modeOption = result.configOptions?.find(o => o.id === MODE_CONFIG_ID);
        expect((modeOption as any).currentValue).toBe(AgentMode.ReadOnly.id);
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

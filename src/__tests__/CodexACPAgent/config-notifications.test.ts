import {describe, expect, it} from "vitest";
import type {AnyMessage} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {LEGACY_SET_SESSION_MODEL_METHOD} from "../../AcpExtensions";
import {createTestModel} from "../acp-test-utils";
import {codexResponse, connectSession, sessionId, type PromptSession} from "./v2-prompt-harness";

async function connect(version: 1 | 2) {
    const fast = createTestModel({id: "fast-model", additionalSpeedTiers: ["fast"],
        supportedReasoningEfforts: [
            {reasoningEffort: "medium", description: "Balanced"},
            {reasoningEffort: "high", description: "Thorough"},
        ]});
    const slow = createTestModel({id: "slow-model", isDefault: false, defaultReasoningEffort: "low",
        supportedReasoningEfforts: [{reasoningEffort: "low", description: "Fast"}]});
    return connectSession(version, {
        codexResponses: {
            "thread/start": async () => ({...codexResponse("thread/start") as object, model: fast.id}),
            "thread/resume": async () => ({...codexResponse("thread/resume") as object, model: fast.id}),
            "model/list": async () => ({data: [fast, slow], nextCursor: null}),
        },
    });
}

function configUpdates(frames: AnyMessage[]) {
    return frames.flatMap((frame, index) => {
        if (!("method" in frame) || frame.method !== "session/update") return [];
        const params = frame.params as {update: {sessionUpdate: string; configOptions: unknown[]}};
        return params.update.sessionUpdate === "config_option_update"
            ? [{index, configOptions: params.update.configOptions}] : [];
    });
}

function assertBeforeResponse(h: PromptSession, start: number, expected?: unknown[]) {
    const frames = h.wireMessages.slice(start);
    const updates = configUpdates(frames);
    expect(updates).toHaveLength(1);
    const response = frames.findIndex(frame => "result" in frame);
    expect(updates[0]!.index).toBeLessThan(response);
    if (expected) expect(updates[0]!.configOptions).toEqual(expected);
}

describe.each([1, 2] as const)("ACP v%s config notifications", version => {
    it.each([
        {configId: "mode", value: "read-only"},
        {configId: "collaboration_mode", value: "plan"},
        {configId: "model", value: "slow-model"},
        {configId: "reasoning_effort", value: "high"},
        {configId: "fast-mode", value: "on"},
    ])("publishes complete $configId state before its response, but not for a no-op", async ({configId, value}) => {
        const h = await connect(version);
        try {
            const params = {sessionId, configId,
                ...(version === 2 ? {type: configId === "fast-mode" ? "boolean" : "id"} : {}),
                value: version === 2 && configId === "fast-mode" ? true : value};
            const start = h.wireMessages.length;
            const response = await h.request("session/set_config_option", params);
            assertBeforeResponse(h, start, response.configOptions);
            if (configId === "model") {
                const options = response.configOptions.map((option: {
                    id?: string; configId?: string; type: string; currentValue: unknown; options: Array<{value: string}>;
                }) => ({id: option.id ?? option.configId, currentValue: option.currentValue,
                    values: option.options.map(value => value.value)}));
                await expect(JSON.stringify(options, null, 2) + "\n")
                    .toMatchFileSnapshot("data/config-notification-dependent-model.json");
            }
            const repeated = h.wireMessages.length;
            expect((await h.request("session/set_config_option", params)).configOptions).toEqual(response.configOptions);
            expect(configUpdates(h.wireMessages.slice(repeated))).toEqual([]);
        } finally { h.connection.close(); }
    });

    it.each([
        {configId: "missing", value: "anything", nativeFailure: false, code: -32602},
        {configId: "mode", value: "missing", nativeFailure: false, code: -32602},
        {configId: "collaboration_mode", value: "plan", nativeFailure: true, code: -32603},
    ])("does not publish a rejected $configId change (native failure: $nativeFailure)", async ({configId, value, nativeFailure, code}) => {
        const h = await connect(version);
        try {
            if (nativeFailure) h.setCodexResponse("thread/settings/update", async () => { throw new Error("Settings failed"); });
            const start = h.wireMessages.length;
            await expect(h.request("session/set_config_option", {sessionId, configId, value,
                ...(version === 2 ? {type: "id"} : {}),
            })).rejects.toMatchObject({code});
            expect(configUpdates(h.wireMessages.slice(start))).toEqual([]);
            expect(h.agent.getSessionState(sessionId).collaborationMode).toBe("default");
        } finally { h.connection.close(); }
    });

    it("publishes one complete update for /plan", async () => {
        const h = await connect(version);
        try {
            const start = h.wireMessages.length;
            await h.sendPrompt([{type: "text", text: "/plan"}]);
            await h.promptRunFinished();
            const updates = configUpdates(h.wireMessages.slice(start));
            expect(updates).toHaveLength(1);
            expect(updates[0]!.configOptions).toHaveLength(5);
        } finally { h.connection.close(); }
    });

    it("does not publish stale options when replay replaces the session during a native settings request", async () => {
        const h = await connect(version);
        let entered!: () => void;
        let release!: () => void;
        const writing = new Promise<void>(resolve => { entered = resolve; });
        const held = new Promise<void>(resolve => { release = resolve; });
        try {
            h.setCodexResponse("thread/settings/update", async () => { entered(); await held; return {}; });
            const setting = h.request("session/set_config_option", {
                sessionId, configId: "collaboration_mode", value: "plan", ...(version === 2 ? {type: "id"} : {}),
            });
            await writing;
            const resumed = await h.request(version === 1 ? "session/load" : "session/resume", {
                sessionId, cwd: "/workspace", mcpServers: [],
                ...(version === 2 ? {replayFrom: {type: "start"}} : {}),
            });
            const start = h.wireMessages.length;
            release();
            expect((await setting).configOptions).toEqual(resumed.configOptions);
            expect(configUpdates(h.wireMessages.slice(start))).toEqual([]);
        } finally { release(); h.connection.close(); }
    });
});

describe("Legacy configuration entry points", () => {
    it.each([
        {method: "session/set_mode", params: {modeId: "read-only"}},
        {method: LEGACY_SET_SESSION_MODEL_METHOD, params: {modelId: "slow-model[low]"}},
    ])("publishes current config before the $method response", async ({method, params}) => {
        const h = await connect(1);
        try {
            const start = h.wireMessages.length;
            await h.request(method, {sessionId, ...params});
            assertBeforeResponse(h, start);
        } finally { h.connection.close(); }
    });
});

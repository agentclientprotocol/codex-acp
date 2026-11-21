import {describe, expect, it} from "vitest";
import type {AnyMessage} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {createTestModel} from "../acp-test-utils";
import {codexResponse, connectSession, createThread, cwd, sessionId} from "./v2-prompt-harness";

/** An AIR client that declares no AIR capability. */
const AIR_CLIENT = {_meta: {jetbrains: {air: {version: 1}}}};

async function connect(version: 1 | 2, airClient: boolean) {
    const luna = createTestModel({
        id: "gpt-5.6-luna",
        displayName: "GPT-5.6-Luna",
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh"]
            .map(reasoningEffort => ({reasoningEffort, description: reasoningEffort})),
        defaultReasoningEffort: "medium",
    });
    // Codex names a default effort that the model does not list.
    const sol = createTestModel({
        id: "gpt-5.6-sol",
        displayName: "GPT-5.6-Sol",
        isDefault: false,
        supportedReasoningEfforts: [{reasoningEffort: "high", description: "high"}],
        defaultReasoningEffort: "medium",
    });
    const plain = createTestModel({
        id: "plain-model",
        displayName: "Plain model",
        isDefault: false,
        supportedReasoningEfforts: [],
    });
    const start = async () => ({...codexResponse("thread/start") as object, model: luna.id});
    return connectSession(version, {
        ...(airClient ? version === 2 ? {clientCapabilities: AIR_CLIENT} : {v1ClientCapabilities: AIR_CLIENT} : {}),
        codexResponses: {
            "thread/start": start,
            "thread/resume": start,
            "thread/fork": async () => ({...await start(), thread: {...createThread(), id: "thread-2"}}),
            "model/list": async () => ({data: [luna, sol, plain], nextCursor: null}),
        },
    });
}

function modelEntries(configOptions: Array<{id?: string; configId?: string; options: unknown}>) {
    return configOptions.find(option => (option.id ?? option.configId) === "model")!.options;
}

function sessionNewResponse(frames: AnyMessage[]) {
    const response = frames.find(frame => "result" in frame && frame.result !== null
        && typeof frame.result === "object" && "configOptions" in frame.result);
    return (response as {result: {configOptions: Array<{id?: string; configId?: string; options: unknown}>}}).result;
}

const expectedEntries = [
    {
        value: "gpt-5.6-luna",
        name: "5.6 Luna",
        _meta: {jetbrains: {air: {version: 1, reasoningEfforts: {
            values: ["low", "medium", "high", "xhigh"],
            recommended: "medium",
        }}}},
    },
    {value: "gpt-5.6-sol", name: "5.6 Sol", _meta: {jetbrains: {air: {version: 1, reasoningEfforts: {values: ["high"]}}}}},
    {value: "plain-model", name: "Plain model"},
];

describe.each([1, 2] as const)("ACP v%s model reasoning efforts", version => {
    it("adds no per-model metadata for a client that is not AIR", async () => {
        const h = await connect(version, false);
        try {
            const entries = modelEntries(sessionNewResponse(h.wireMessages).configOptions) as Array<object>;
            expect(entries).toHaveLength(3);
            for (const entry of entries) expect(entry).not.toHaveProperty("_meta");
        } finally { h.connection.close(); }
    });

    it("carries the efforts of each model in every answer with config options for an AIR client", async () => {
        const h = await connect(version, true);
        try {
            const answers: Record<string, unknown> = {};
            answers["session/new"] = modelEntries(sessionNewResponse(h.wireMessages).configOptions);

            const updateStart = h.wireMessages.length;
            const setResponse = await h.request("session/set_config_option", {
                sessionId, configId: "reasoning_effort", value: "high", ...(version === 2 ? {type: "id"} : {}),
            });
            answers["session/set_config_option"] = modelEntries(setResponse.configOptions);
            const update = h.wireMessages.slice(updateStart).flatMap(frame => {
                if (!("method" in frame) || frame.method !== "session/update") return [];
                const params = frame.params as {update: {sessionUpdate: string; configOptions: Array<{options: unknown}>}};
                return params.update.sessionUpdate === "config_option_update" ? [params.update] : [];
            });
            expect(update).toHaveLength(1);
            answers["config_option_update"] = modelEntries(update[0]!.configOptions);

            answers["session/resume"] = modelEntries((await h.request("session/resume", {sessionId, cwd})).configOptions);
            answers["session/fork"] = modelEntries(
                (await h.request("session/fork", {sessionId, cwd, ...(version === 1 ? {mcpServers: []} : {})})).configOptions,
            );
            if (version === 1) {
                await h.request("session/close", {sessionId});
                answers["session/load"] = modelEntries(
                    (await h.request("session/load", {sessionId, cwd, mcpServers: []})).configOptions,
                );
            }

            for (const [answer, entries] of Object.entries(answers)) {
                expect(entries, answer).toMatchObject(expectedEntries);
                expect((entries as Array<object>)[2], answer).not.toHaveProperty("_meta");
            }
        } finally { h.connection.close(); }
    });
});

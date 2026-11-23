import {afterEach, describe, expect, it, vi} from "vitest";
import {createTestModel} from "../acp-test-utils";
import {codexResponse, connectSession, createThread, cwd, sessionId, type PromptSession} from "./v2-prompt-harness";

const models = [
    createTestModel({id: "default"}),
    createTestModel({id: "advanced", isDefault: false, additionalSpeedTiers: ["fast"], supportedReasoningEfforts: [
        {reasoningEffort: "medium", description: "Balanced"},
        {reasoningEffort: "high", description: "Thorough"},
    ]}),
];

describe.each([1, 2] as const)("ACP v%s session options", version => {
    const idKey = version === 1 ? "id" : "configId";
    const idValue = (configId: string, value: string) => ({
        configId, value, ...(version === 2 ? {type: "id"} : {}),
    });
    let h: PromptSession;

    async function connect(options: Parameters<typeof connectSession>[1] = {}) {
        const start = vi.fn(async () => ({...codexResponse("thread/start") as object, model: "default"}));
        const resume = vi.fn(async () => ({...codexResponse("thread/resume") as object, model: "advanced"}));
        h = await connectSession(version, {
            openSession: false,
            ...options,
            codexResponses: {
                "model/list": async () => ({data: models, nextCursor: null}),
                "thread/start": start,
                "thread/resume": resume,
                "thread/read": async () => ({thread: {
                    ...createThread(), model: "advanced", reasoningEffort: "medium", status: {type: "active", activeFlags: []},
                }}),
                "thread/fork": async () => ({
                    ...codexResponse("thread/start") as object, thread: {...createThread(), id: "fork-id"}, model: "default",
                }),
            },
        });
        return {start, resume};
    }

    afterEach(() => h?.connection.close());

    it("previews new and stored options without opening a thread or sending session updates", async () => {
        const {start, resume} = await connect();
        const fresh = await h.request("session/options", {cwd, additionalDirectories: null, sessionId: null});
        const stored = await h.request("session/options", {cwd, sessionId});
        expect(fresh.configOptions).toContainEqual(expect.objectContaining({[idKey]: "model", currentValue: "default"}));
        expect(stored.configOptions).toContainEqual(expect.objectContaining({[idKey]: "model", currentValue: "advanced"}));
        expect(stored.configOptions).toContainEqual(expect.objectContaining({
            [idKey]: "fast-mode", type: version === 2 ? "boolean" : "select",
        }));
        expect(start).not.toHaveBeenCalled();
        expect(resume).not.toHaveBeenCalled();
        expect(h.scopedUpdates).toEqual([]);

        const created = await h.request("session/new", {cwd, mcpServers: [], configOptions: null});
        expect(fresh.configOptions).toEqual(created.configOptions);
        if (version === 1) {
            expect(fresh.modes).toEqual(created.modes);
            expect(fresh).not.toHaveProperty("availableCommands");
        } else {
            expect(fresh).not.toHaveProperty("modes");
            expect(fresh.availableCommands).toContainEqual(expect.objectContaining({name: "review"}));
            for (const command of fresh.availableCommands) expect(created.availableCommands).toContainEqual(command);
        }
        h.setCodexResponse("thread/read", async () => ({thread: {...createThread(), model: "default"}}));
        h.setCodexResponse("thread/resume", async () => ({...codexResponse("thread/resume") as object, model: "default"}));
        const updated = await h.request("session/set_config_option", {sessionId, ...idValue("mode", "read-only")});
        const active = await h.request("session/options", {cwd, sessionId});
        expect(active.configOptions).toEqual(updated.configOptions);
        const restored = await h.request("session/resume", {cwd, sessionId, mcpServers: []});
        expect(restored.configOptions).toEqual(active.configOptions);
    });

    it("returns Resource not found for an unknown session", async () => {
        await connect();
        h.setCodexResponse("thread/read", async () => { throw new Error("no rollout found for thread id missing"); });
        await expect(h.request("session/options", {cwd, sessionId: "missing"})).rejects.toMatchObject({code: -32002});
    });

    it("retains a live model with its effective effort while the catalog offers it", async () => {
        await connect();
        h.setCodexResponse("thread/start", async () => ({
            ...codexResponse("thread/start") as object, model: "default", reasoningEffort: "high",
        }));
        h.setCodexResponse("thread/read", async () => ({thread: {...createThread(), model: "default", reasoningEffort: "medium"}}));
        h.setCodexResponse("thread/resume", async () => ({
            ...codexResponse("thread/resume") as object, model: "default", reasoningEffort: "medium",
        }));
        const selected = await h.request("session/new", {
            cwd, mcpServers: [], configOptions: [idValue("model", "advanced")],
        });
        expect(selected.configOptions).toContainEqual(expect.objectContaining({[idKey]: "reasoning_effort", currentValue: "high"}));
        const restored = await h.request("session/resume", {cwd, sessionId, mcpServers: []});
        expect(restored.configOptions).toEqual(selected.configOptions);

        h.setCodexResponse("model/list", async () => ({data: [models[0]], nextCursor: null}));
        const preview = await h.request("session/options", {cwd, sessionId});
        expect(preview.configOptions).toContainEqual(expect.objectContaining({[idKey]: "model", currentValue: "default"}));
        expect((await h.request("session/resume", {cwd, sessionId, mcpServers: []})).configOptions).toEqual(preview.configOptions);
    });

    it("retains the selected speed across a resume while the model hides it", async () => {
        await connect();
        const enabled = version === 1 ? "on" : true;
        await h.request("session/new", {
            cwd, mcpServers: [], configOptions: [idValue("model", "advanced"), version === 1
                ? idValue("fast-mode", "on") : {configId: "fast-mode", type: "boolean", value: true}],
        });
        const setModel = (model: string) => h.request("session/set_config_option", {sessionId, ...idValue("model", model)});
        await setModel("default");
        const resumed = await h.request("session/resume", {cwd, sessionId, mcpServers: []});
        expect(resumed.configOptions).not.toContainEqual(expect.objectContaining({[idKey]: "fast-mode"}));
        const switched = await setModel("advanced");
        const fast = expect.objectContaining({[idKey]: "fast-mode", currentValue: enabled});
        expect(switched.configOptions).toContainEqual(fast);
        expect((await h.request("session/resume", {cwd, sessionId, mcpServers: []})).configOptions).toContainEqual(fast);
    });

    it("resolves workspace settings and returns boolean options to a capable client", async () => {
        await connect({v1ClientCapabilities: {session: {configOptions: {boolean: {}}}}});
        const project = "/another/workspace";
        const config = {
            model: "advanced", model_reasoning_effort: "high", service_tier: "priority", default_permissions: "dev",
        };
        const workspaceConfig = vi.fn(async () => ({config}));
        const profiles = vi.fn(async () => ({data: [{id: "dev", allowed: true}], nextCursor: null}));
        h.setCodexResponse("config/read", workspaceConfig);
        h.setCodexResponse("permissionProfile/list", profiles);
        const response = await h.request("session/options", {cwd: project, additionalDirectories: ["/shared"]});
        expect(workspaceConfig).toHaveBeenCalledWith(expect.objectContaining({cwd: project}));
        expect(profiles).toHaveBeenCalledWith(expect.objectContaining({cwd: project}));
        expect(response.configOptions).toEqual(expect.arrayContaining([
            expect.objectContaining({[idKey]: "model", currentValue: "advanced"}),
            expect.objectContaining({[idKey]: "reasoning_effort", currentValue: "high"}),
            expect.objectContaining({[idKey]: "fast-mode", type: "boolean", currentValue: true}),
            expect.objectContaining({[idKey]: "mode", currentValue: "permission-profile:dev"}),
        ]));
        // A cold resume supplies an explicit provider, so the workspace model and effort win.
        h.setCodexResponse("thread/read", async () => ({thread: {
            ...createThread(), model: "default", reasoningEffort: "medium", status: {type: "notLoaded"},
        }}));
        expect(await h.request("session/options", {cwd: project, sessionId})).toEqual(response);
        h.setCodexResponse("config/read", async () => ({config: {...config, features: {fast_mode: false}}}));
        const standard = await h.request("session/options", {cwd: project});
        expect(standard.configOptions).toContainEqual(expect.objectContaining({[idKey]: "fast-mode", currentValue: false}));
    });

    it("previews the unnamed mode selected by a sandbox override over a configured permission profile", async () => {
        await connect({codexConfig: {sandbox_mode: "read-only"}});
        h.setCodexResponse("config/read", async () => ({config: {default_permissions: "dev"}}));
        h.setCodexResponse("permissionProfile/list", async () => ({data: [{id: "dev", allowed: true}], nextCursor: null}));
        const preview = await h.request("session/options", {cwd});
        const setup = await h.request("session/new", {cwd, mcpServers: []});
        expect(preview.configOptions).toContainEqual(expect.objectContaining({[idKey]: "mode", currentValue: "agent"}));
        expect(preview.configOptions).toEqual(setup.configOptions);
    });

    it("uses inherited workspace trust and preserves higher-priority values", async () => {
        await connect();
        const config = {model: "default", model_reasoning_effort: "high"};
        const disabled = (directory: string, trustRoot: string, model: string) => ({
            name: {type: "project", dotCodexFolder: directory + "/.codex"},
            disabledReason: `${trustRoot} is marked as untrusted in the effective configuration.`,
            config: {model, model_reasoning_effort: "medium", service_tier: "priority"},
        });
        h.setCodexResponse("config/read", async () => ({config, layers: [
            {name: {type: "sessionFlags"}, config: {model_reasoning_effort: "high"}},
            disabled(cwd + "/sub", cwd, "advanced"), disabled("/parent-project", "/parent-project", "default"),
        ]}));
        const request = {cwd: cwd + "/sub/child"};
        const preview = await h.request("session/options", {...request, additionalDirectories: [cwd]});
        expect(preview.configOptions).toEqual(expect.arrayContaining([
            expect.objectContaining({[idKey]: "model", currentValue: "advanced"}),
            expect.objectContaining({[idKey]: "reasoning_effort", currentValue: "high"}),
            expect.objectContaining({[idKey]: "fast-mode", currentValue: version === 1 ? "on" : true}),
        ]));
        expect((await h.request("session/options", request)).configOptions)
            .toContainEqual(expect.objectContaining({[idKey]: "model", currentValue: "default"}));
    });

    it.each([false, true])("reports an archived thread with separate archive support %s", async indexed => {
        const capabilities = {_meta: {jetbrains: {air: {version: 1, capabilities: ["sessionIndex"]}}}};
        await connect(indexed ? {v1ClientCapabilities: capabilities, clientCapabilities: capabilities} : {});
        h.setCodexResponse("thread/read", async () => ({thread: {
            ...createThread(), path: "/codex/archived_sessions/session.jsonl",
        }}));
        await expect(h.request("session/options", {cwd, sessionId})).rejects.toMatchObject(
            indexed ? {code: -32600, data: {reason: "archived", sessionId}} : {code: -32002},
        );
    });

    it.each(["session/new", "session/resume", "session/fork", ...(version === 1 ? ["session/load"] : [])])(
        "%s applies values in order and returns the resulting settings", async method => {
            await connect();
            const response = await h.request(method, {
                cwd, mcpServers: [], ...(method === "session/new" ? {} : {sessionId}),
                configOptions: [
                    idValue("model", "advanced"),
                    idValue("reasoning_effort", "high"),
                    idValue("mode", "read-only"),
                    version === 1 ? idValue("fast-mode", "on") : {configId: "fast-mode", type: "boolean", value: true},
                ],
            });
            expect(response.configOptions).toEqual(expect.arrayContaining([
                expect.objectContaining({[idKey]: "model", currentValue: "advanced"}),
                expect.objectContaining({[idKey]: "reasoning_effort", currentValue: "high"}),
                expect.objectContaining({[idKey]: "mode", currentValue: "read-only"}),
                expect.objectContaining({[idKey]: "fast-mode", currentValue: version === 1 ? "on" : true}),
            ]));
            if (version === 1) expect(response.modes.currentModeId).toBe("read-only");
            expect(h.scopedUpdates.map(({update}) => update.sessionUpdate)).not.toContain("config_option_update");
        },
    );

    it("skips stale selections and runtime refusals, then continues applying later entries", async () => {
        await connect();
        const refused = vi.fn(async () => { throw new Error("Settings refused by Codex"); });
        h.setCodexResponse("thread/settings/update", refused);
        const response = await h.request("session/new", {cwd, mcpServers: [], configOptions: [
            idValue("unknown", "stale"),
            idValue("reasoning_effort", "high"), // Only available after selecting advanced.
            {configId: "mode", type: "boolean", value: true},
            idValue("collaboration_mode", "plan"),
            idValue("model", "advanced"),
        ]});
        expect(refused).toHaveBeenCalledOnce();
        expect(response.configOptions).toEqual(expect.arrayContaining([
            expect.objectContaining({[idKey]: "model", currentValue: "advanced"}),
            expect.objectContaining({[idKey]: "reasoning_effort", currentValue: "medium"}),
            expect.objectContaining({[idKey]: "collaboration_mode", currentValue: "default"}),
        ]));
    });

    it("rejects malformed and duplicate values before creating a thread", async () => {
        const {start} = await connect();
        for (const configOptions of [
            "bad", [null], [{type: "id", value: "missing-key"}], [{configId: "mode", type: "boolean", value: "yes"}],
            [idValue("unknown", "one"), idValue("unknown", "two")],
            ...(version === 2 ? [[{configId: "mode", value: "read-only"}], [{configId: "mode", type: "text", value: "read-only"}]] : []),
        ]) {
            await expect(h.request("session/new", {cwd, mcpServers: [], configOptions}))
                .rejects.toMatchObject({code: -32602});
        }
        expect(start).not.toHaveBeenCalled();
    });
});

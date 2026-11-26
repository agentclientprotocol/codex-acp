// Real codex-acp + real `codex app-server`; only the model is a local mock.
import {afterEach, beforeEach, expect, it} from "vitest";
import {globSync} from "node:fs";
import {mkdir, rename, writeFile} from "node:fs/promises";
import path from "node:path";
import type {SpawnedAgentFixture} from "../CodexACPAgent/e2e/spawned-agent-fixture";
import {
    agentText,
    connectAndLogin,
    describeIntegration,
    expectNoUnscriptedModelRequests,
    INTEGRATION_MODEL_ID,
    sendPrompt,
    spawnAgent,
    stopAll,
} from "./integration-fixture";
import {type MockResponsesServer, startMockResponsesServer, textResponse} from "./mock-responses-server";

describeIntegration("integration: text reply", () => {
    let mock: MockResponsesServer;
    let agent: SpawnedAgentFixture;
    let sessionId: string;

    beforeEach(async () => {
        // Start the mock model: a local HTTP server in place of the OpenAI API.
        mock = await startMockResponsesServer();
        // Spawn the agent: the codex-acp process, which starts `codex app-server` itself.
        agent = await spawnAgent();
        // Connect over ACP and log in through `gateway` with the mock's address.
        await connectAndLogin(agent, mock.baseUrl);
        const cwd = agent.workspaceDir;
        // Setup trusts the selected workspace even when it has no saved project trust entry.
        await mkdir(path.join(cwd, ".codex"), {recursive: true});
        await writeFile(path.join(cwd, ".codex", "config.toml"),
            `model = "${INTEGRATION_MODEL_ID.model}"\nmodel_reasoning_effort = "high"\nservice_tier = "fast"\n`);
        const preview = await agent.connection.request("session/options", {cwd});
        expect(preview.configOptions).toEqual(expect.arrayContaining([
            expect.objectContaining({id: "model", currentValue: INTEGRATION_MODEL_ID.model}),
            expect.objectContaining({id: "reasoning_effort", currentValue: "high"}),
        ]));
        expect((await agent.connection.request("session/list", {cwd})).sessions).toEqual([]);
        const session = await agent.connection.request("session/new", {cwd, mcpServers: [], configOptions: [
            {configId: "model", value: INTEGRATION_MODEL_ID.model},
            {configId: "reasoning_effort", value: INTEGRATION_MODEL_ID.effort},
            {configId: "collaboration_mode", value: "plan"},
        ]});
        sessionId = session.sessionId;
        const live = await agent.connection.request("session/options", {cwd, sessionId});
        expect(live.configOptions).toContainEqual(expect.objectContaining({id: "fast-mode", currentValue: "on"}));
        const resumed = await agent.connection.request("session/resume", {cwd, sessionId, mcpServers: []});
        expect(resumed.configOptions).toEqual(live.configOptions);
    });

    // Stop the agent and the mock, remove the temp dirs.
    afterEach(async () => {
        await stopAll(agent, mock);
    });

    /** The model's request carries the prompt and is sent to the integration model. */
    function expectPromptSentToModel(text: string): void {
        expect(mock.promptRequests).toHaveLength(1);
        expect(mock.promptRequests[0]).toMatchObject({
            model: INTEGRATION_MODEL_ID.model,
            reasoning: {effort: INTEGRATION_MODEL_ID.effort},
        });
        expect(JSON.stringify(mock.promptRequests[0])).toContain(text);
    }

    it("runs the first turn with the selected settings and previews the session after closing it", async () => {
        // Script the model: its only reply is text in 3 chunks.
        mock.enqueue(textResponse("integ", "ration", "-ok"));

        // Send the prompt and wait for the turn to end.
        const response = await sendPrompt(agent, sessionId, "say integration-ok");

        // Check what the client received and what Codex sent to the model.
        expect(response.stopReason).toBe("end_turn");
        expect(agentText(agent, sessionId)).toBe("integration-ok");
        expectPromptSentToModel("say integration-ok");
        expectNoUnscriptedModelRequests(mock);

        await agent.connection.request("session/close", {sessionId});
        const cwd = agent.workspaceDir;
        const preview = await agent.connection.request("session/options", {cwd, sessionId});
        const resumed = await agent.connection.request("session/resume", {cwd, sessionId, mcpServers: []});
        expect(preview.configOptions).toContainEqual(expect.objectContaining({id: "collaboration_mode", currentValue: "plan"}));
        expect(preview.configOptions).toEqual(resumed.configOptions);
    });

    it("falls back when saved settings disappear and recovers when the rollout returns", async () => {
        mock.enqueue(textResponse("OK"));
        await sendPrompt(agent, sessionId, "Reply with OK");
        await agent.connection.request("session/close", {sessionId});
        const cwd = agent.workspaceDir;
        const preview = () => agent.connection.request("session/options", {cwd, sessionId});
        const workspace = await agent.connection.request("session/options", {cwd});
        const saved = await preview();
        expect(saved.configOptions).toContainEqual(expect.objectContaining({id: "collaboration_mode", currentValue: "plan"}));
        expect(workspace.configOptions).toContainEqual(expect.objectContaining({id: "collaboration_mode", currentValue: "default"}));

        const files = globSync(`sessions/**/*-${sessionId}.jsonl{,.zst}`, {cwd: agent.codexHome});
        expect(files).toHaveLength(1);
        const rollout = path.join(agent.codexHome, files[0]!);
        const backup = path.join(agent.codexHome, "saved-rollout");
        await rename(rollout, backup);
        try {
            // Codex can still identify this session from its index.
            expect((await preview()).configOptions).toEqual(workspace.configOptions);
            await writeFile(rollout, "invalid session metadata\n", {flag: "wx"});
            await expect(preview()).rejects.toMatchObject({code: -32603});
        } finally {
            await rename(backup, rollout);
        }

        expect((await preview()).configOptions).toEqual(saved.configOptions);
        const resumed = await agent.connection.request("session/resume", {cwd, sessionId, mcpServers: []});
        expect(resumed.configOptions).toEqual(saved.configOptions);
        expect(mock.promptRequests).toHaveLength(1);
    });
});

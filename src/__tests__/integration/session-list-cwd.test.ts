import * as acp from "@agentclientprotocol/sdk/unstable";
import fs from "node:fs";
import path from "node:path";
import {expect, it, vi} from "vitest";
import type {SpawnedAgentFixture} from "../CodexACPAgent/e2e/spawned-agent-fixture";
import {legacySetSessionModel} from "../../AcpExtensions";
import {
    connectAndLogin,
    describeIntegration,
    INTEGRATION_MODEL_ID,
    sendPrompt,
    spawnAgent,
    stopAll,
} from "./integration-fixture";
import {startMockResponsesServer, textResponse} from "./mock-responses-server";

describeIntegration("integration: session list cwd", () => {
    it("finds a persisted session by a symlink to its workspace", async () => {
        const mock = await startMockResponsesServer();
        let agent: SpawnedAgentFixture | undefined;
        try {
            agent = await spawnAgent();
            await connectAndLogin(agent, mock.baseUrl);
            const {connection, workspaceDir} = agent;
            const cwd = fs.realpathSync.native(workspaceDir);
            const alias = path.join(path.dirname(workspaceDir), "workspace-link");
            fs.symlinkSync(cwd, alias, "junction");

            const {sessionId} = await connection.request(acp.methods.agent.session.new, {cwd: alias, mcpServers: []});
            await legacySetSessionModel(connection, {sessionId, modelId: INTEGRATION_MODEL_ID.toString()});
            mock.enqueue(textResponse("ok"), textResponse("Workspace session"));
            expect((await sendPrompt(agent, sessionId, "Reply with ok")).stopReason).toBe("end_turn");

            const list = (cwd: string) => connection.request(acp.methods.agent.session.list, {cwd});
            await vi.waitFor(async () => {
                expect((await list(cwd)).sessions).toMatchObject([{sessionId, cwd}]);
            });
            expect((await list(alias)).sessions).toMatchObject([{sessionId, cwd}]);

            fs.unlinkSync(alias);
            expect((await list(alias)).sessions).toEqual([]);
            expect((await list(cwd)).sessions).toMatchObject([{sessionId, cwd}]);
        } finally {
            await stopAll(agent, mock);
        }
    });
});

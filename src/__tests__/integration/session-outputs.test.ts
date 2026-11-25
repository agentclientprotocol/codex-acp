import * as acp from "@agentclientprotocol/sdk/unstable";
import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {mkdir, mkdtemp, realpath, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Readable, Writable} from "node:stream";
import {expect, it, vi} from "vitest";
import {OUTPUTS_CAPABILITY, OUTPUTS_LIST, OUTPUTS_READ, type SessionOutput} from "../../SessionOutputs";
import {removeDirectoryWithRetry, writeCodexHomeConfig} from "../acp-test-utils";
import {describeIntegration, INTEGRATION_MODEL_ID} from "./integration-fixture";
import {startMockResponsesServer, textResponse} from "./mock-responses-server";
import {developerText, findPromptRequest} from "./model-request";

describeIntegration("integration: managed session outputs", () => {
    it("instructs the model, serves live output bytes and permanently deletes the thread and its outputs", async () => {
        const root = await mkdtemp(join(await realpath(tmpdir()), "acp-managed-"));
        const codexHome = join(root, "codex-home");
        const outputs = join(root, "outputs");
        await mkdir(codexHome);
        const mock = await startMockResponsesServer();
        writeCodexHomeConfig(codexHome, {
            model: INTEGRATION_MODEL_ID.model,
            model_reasoning_effort: INTEGRATION_MODEL_ID.effort,
            developer_instructions: "KEEP_SITE_INSTRUCTIONS",
            web_search: "disabled",
            model_provider: "integration",
            "model_providers.integration.name": "Local integration mock",
            "model_providers.integration.base_url": mock.baseUrl,
            "model_providers.integration.wire_api": "responses",
        });
        const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
            env: {...process.env, CODEX_HOME: codexHome, CODEX_ACP_SESSION_OUTPUTS_DIR: outputs},
            stdio: ["pipe", "pipe", "inherit"],
        });
        const settled = new Set<string>();
        const connection = acpV2.client()
            .onNotification(acpV2.methods.client.session.update, ({params}) => {
                const update = params.update;
                if (update.sessionUpdate === "state_update" && update.state === "idle" && update.stopReason === "end_turn") {
                    settled.add(params.sessionId);
                }
            })
            .connect(acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>));
        const peer = connection.agent;
        const options = {cancellationSignal: AbortSignal.timeout(20_000)};
        try {
            const initialized = await peer.request(acpV2.methods.agent.initialize, {
                protocolVersion: 2,
                info: {name: "outputs-test", version: "1"},
                capabilities: {auth: {_meta: {gateway: true}}},
            }, options);
            expect(initialized._meta?.[OUTPUTS_CAPABILITY]).toEqual({version: 1});
            await peer.request(acpV2.methods.agent.auth.login, {
                methodId: "gateway",
                _meta: {gateway: {baseUrl: mock.baseUrl, headers: {}}},
            }, options);
            const {sessionId} = await peer.request(acpV2.methods.agent.session.new, {cwd: root}, options);
            const text = "Prepare the deliverable.";
            mock.enqueue(textResponse("Done."), textResponse("Output test"));
            await peer.request(acpV2.methods.agent.session.prompt, {sessionId, prompt: [{type: "text", text}]}, options);
            await vi.waitFor(() => expect(settled.has(sessionId)).toBe(true), {timeout: 10_000});
            const developer = developerText(findPromptRequest(mock.requests, text));
            expect(developer).toContain("KEEP_SITE_INSTRUCTIONS");
            expect(developer).toContain(`'${outputs}'"/$CODEX_THREAD_ID"`);

            await mkdir(join(outputs, sessionId), {recursive: true});
            const bytes = Buffer.from([255, 216, 255, 0, 128, 254]);
            await writeFile(join(outputs, sessionId, "photo.jpg"), bytes);
            const listed = await peer.request<{outputs: SessionOutput[]}>(OUTPUTS_LIST, {sessionId}, options);
            expect(listed.outputs).toHaveLength(1);
            const outputId = listed.outputs[0]!.id;
            const read = await peer.request<{dataBase64: string}>(OUTPUTS_READ, {sessionId, outputId, offset: 0, length: 8}, options);
            expect(Buffer.from(read.dataBase64, "base64")).toEqual(bytes);
            await peer.request(acpV2.methods.agent.session.delete, {sessionId}, options);
            expect(await peer.request(OUTPUTS_LIST, {sessionId}, options)).toEqual({outputs: []});
            await expect(peer.request(acpV2.methods.agent.session.resume, {sessionId, cwd: root}, options)).rejects.toThrow();
        } finally {
            const exit = once(child, "exit");
            connection.close();
            child.kill();
            await exit;
            await mock.close();
            await removeDirectoryWithRetry(root);
        }
    });
});
